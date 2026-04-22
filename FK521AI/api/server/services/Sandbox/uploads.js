const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const mime = require('mime-types');
const { logger } = require('@fk521ai/data-schemas');
const { sanitizeFilename, getDisplayFilename } = require('@fk521ai/api');
const appPaths = require('~/config/paths');
const { getFiles } = require('~/models');
const {
  ensureConversationSandbox,
  sanitizeSegment,
  toSandboxUploadPath,
} = require('./paths');
const { SANDBOX_PATHS, ensureSandboxCapabilityManifest } = require('./runtimeContract');
const { prepareProjectArchives, buildProjectArchivesContext } = require('./projectArchives');
const { getArchiveToolStatus } = require('./archiveUtils');
const {
  WORKSPACE_VIRTUAL_PATHS,
  WORKSPACE_VIRTUAL_ROOT,
} = require('~/server/services/Platform/runtimeContext');

const UPLOAD_MANIFEST_FILENAME = 'uploaded-files.json';

function uniqueFilename(baseName, usedNames, suffix = '') {
  const ext = path.extname(baseName);
  const stem = path.basename(baseName, ext);
  let candidate = `${stem}${suffix}${ext}`;
  let counter = 1;
  while (usedNames.has(candidate)) {
    candidate = `${stem}${suffix || ''}-${counter}${ext}`;
    counter += 1;
  }
  usedNames.add(candidate);
  return candidate;
}

function normalizeFilename(file, fallbackId = '') {
  const preferredName = getDisplayFilename(String(file?.filename || '').trim(), '').trim();
  if (preferredName) {
    return sanitizeFilename(preferredName);
  }
  const fallback = sanitizeSegment(fallbackId || 'upload', 'upload');
  const ext = path.extname(String(file?.filename || '').trim() || '') || '';
  return `${fallback}${ext}`;
}

function isLocalReadableFile(filePath) {
  if (!filePath || typeof filePath !== 'string') {
    return false;
  }
  try {
    const stat = fs.statSync(filePath);
    return stat.isFile();
  } catch (_error) {
    return false;
  }
}

function resolveStoredLocalPath(filePath) {
  const raw = String(filePath || '').split('?')[0].trim();
  if (!raw) {
    return null;
  }

  if (isLocalReadableFile(raw)) {
    return raw;
  }

  const normalized = raw.replace(/\\/g, '/');

  const uploadMatch = normalized.match(/^\/uploads\/(.+)$/);
  if (uploadMatch) {
    const candidate = path.join(appPaths.uploads, uploadMatch[1]);
    if (isLocalReadableFile(candidate)) {
      return candidate;
    }
  }

  const imageMatch = normalized.match(/^\/images\/(.+)$/);
  if (imageMatch) {
    const candidate = path.join(appPaths.imageOutput, imageMatch[1]);
    if (isLocalReadableFile(candidate)) {
      return candidate;
    }
  }

  return null;
}

function formatBytes(bytes) {
  const size = Number(bytes || 0);
  if (!Number.isFinite(size) || size <= 0) {
    return '0 B';
  }
  if (size < 1024) {
    return `${size} B`;
  }
  const kb = size / 1024;
  if (kb < 1024) {
    return `${kb.toFixed(1)} KB`;
  }
  const mb = kb / 1024;
  if (mb < 1024) {
    return `${mb.toFixed(1)} MB`;
  }
  return `${(mb / 1024).toFixed(1)} GB`;
}

async function computeSha256(filePath) {
  const bytes = await fsp.readFile(filePath);
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

async function resolveConversationFiles({
  conversationFileIds = [],
  conversationId,
  user = null,
} = {}) {
  const fileIds = [...new Set((conversationFileIds || []).filter(Boolean))];
  if (fileIds.length === 0 || !conversationId || !user?.id) {
    return [];
  }
  const filter = {
    file_id: { $in: fileIds },
    conversationId,
    user: user.id,
  };
  if (user.tenantId) {
    filter.tenantId = user.tenantId;
  }
  return (await getFiles(filter, null, { text: 0 })) || [];
}

async function writeUploadManifest({
  conversationId,
  syncedFiles = [],
  skippedFiles = [],
  projectArchives = [],
  archiveFailures = [],
  projectArchiveManifest = null,
  authContext = {},
}) {
  const { workspaceDir } = ensureConversationSandbox(conversationId, authContext);
  const manifestsDir = path.join(workspaceDir, 'manifests');
  await fsp.mkdir(manifestsDir, { recursive: true });
  const hostPath = path.join(manifestsDir, UPLOAD_MANIFEST_FILENAME);
  const manifest = {
    version: 1,
    generatedAt: new Date().toISOString(),
    workspaceRoot: WORKSPACE_VIRTUAL_ROOT,
    files: syncedFiles.map((file) => ({
      file_id: file.file_id,
      filename: file.filename,
      originalName: file.originalName,
      size: file.size,
      mimeType: file.type,
      sha256: file.sha256,
      uploadedAt: file.uploadedAt,
      permission: file.permission,
      sandboxPath: file.path,
      virtualPath: file.virtualPath,
      source: file.source,
    })),
    skippedFiles,
    projectArchives,
    archiveFailures,
    projectArchiveManifest,
    categories: {
      projectArchives: projectArchives.map((item) => item.file_id).filter(Boolean),
      contextDocuments: syncedFiles
        .filter((file) => !projectArchives.some((archive) => archive.file_id && archive.file_id === file.file_id))
        .map((file) => file.file_id)
        .filter(Boolean),
    },
  };

  await fsp.writeFile(hostPath, JSON.stringify(manifest, null, 2), 'utf8');
  return {
    hostPath,
    virtualPath: `${WORKSPACE_VIRTUAL_PATHS.manifests}/${UPLOAD_MANIFEST_FILENAME}`,
    manifest,
  };
}

async function syncMongoFilesToSandbox({ conversationId, files = [], user = null, authContext = {} }) {
  const { uploadsDir } = ensureConversationSandbox(conversationId, authContext);
  await ensureSandboxCapabilityManifest(conversationId, authContext?.user ? authContext : { user });
  const usedNames = new Set();
  const syncedFiles = [];
  const skippedFiles = [];

  for (const file of files || []) {
    if (!file) {
      continue;
    }

    const baseName = normalizeFilename(file, file.file_id);
    const suffix = file.file_id ? `-${String(file.file_id).slice(0, 8)}` : '';
    const finalName = uniqueFilename(baseName, usedNames, suffix);
    const sourcePath = resolveStoredLocalPath(file.filepath);

    if (!sourcePath) {
      skippedFiles.push({
        file_id: file.file_id,
        filename: baseName,
        originalPath: file.filepath || null,
        reason: '上传记录已存在，但未找到可读的本地文件副本；请检查 /uploads 到本地存储的落盘链路',
      });
      continue;
    }

    const sourceStat = await fsp.stat(sourcePath);
    const destination = path.join(uploadsDir, finalName);
    await fsp.copyFile(sourcePath, destination);
    const stat = await fsp.stat(destination);
    const sha256 = await computeSha256(destination);

    syncedFiles.push({
      file_id: file.file_id,
      filename: finalName,
      originalName: getDisplayFilename(String(file.filename || finalName).trim(), finalName),
      size: stat.size,
      type: file.type || mime.lookup(finalName) || 'application/octet-stream',
      path: toSandboxUploadPath(finalName),
      virtualPath: `${WORKSPACE_VIRTUAL_PATHS.uploads}/${finalName}`,
      hostPath: destination,
      source: file.source,
      sourcePath,
      sourceMtimeMs: sourceStat.mtimeMs,
      uploadedAt: file.createdAt ? new Date(file.createdAt).toISOString() : new Date(stat.mtimeMs).toISOString(),
      permission: 'ro',
      sha256,
    });
  }

  if (skippedFiles.length > 0) {
    logger.warn(
      `[sandbox uploads] conversation ${conversationId} skipped ${skippedFiles.length} file(s): ${skippedFiles
        .map((file) => `${file.filename}(${file.reason})`)
        .join(', ')}`,
    );
  }

  return {
    syncedFiles,
    skippedFiles,
  };
}

async function syncConversationFilesToSandbox({ conversationId, conversationFileIds = [], user = null, authContext = {} }) {
  const dbFiles = await resolveConversationFiles({
    conversationFileIds,
    conversationId,
    user,
  });
  const syncResult = await syncMongoFilesToSandbox({
    conversationId,
    files: dbFiles,
    user,
    authContext: authContext?.user ? authContext : { user },
  });
  const effectiveAuthContext = authContext?.user ? authContext : { user };
  const { projectArchives, archiveFailures, manifestInfo } = await prepareProjectArchives({
    conversationId,
    syncedFiles: syncResult.syncedFiles,
    authContext: effectiveAuthContext,
  });
  const uploadManifest = await writeUploadManifest({
    conversationId,
    syncedFiles: syncResult.syncedFiles,
    skippedFiles: syncResult.skippedFiles,
    projectArchives,
    archiveFailures,
    projectArchiveManifest: manifestInfo?.virtualPath || null,
    authContext: effectiveAuthContext,
  });

  return {
    ...syncResult,
    projectArchives,
    archiveFailures,
    projectArchiveManifest: manifestInfo || null,
    uploadManifest,
  };
}

function buildSandboxUploadsContext(
  syncedFiles = [],
  skippedFiles = [],
  projectArchives = [],
  uploadManifest = null,
  archiveFailures = [],
  projectArchiveManifest = null,
) {
  if (syncedFiles.length === 0 && skippedFiles.length === 0) {
    return '';
  }

  const archiveToolStatus = getArchiveToolStatus();
  const lines = [
    '<uploaded_files_manifest>',
    '以下是当前会话工作区中可直接访问的上传文件清单。这里只提供元数据，不提供文件全文。需要内容时请按需读取。',
    `虚拟工作区根目录：${WORKSPACE_VIRTUAL_ROOT}`,
    `上传目录：${WORKSPACE_VIRTUAL_PATHS.uploads}`,
    `临时工作目录：${WORKSPACE_VIRTUAL_PATHS.workdir}`,
    `项目目录：${WORKSPACE_VIRTUAL_PATHS.projects}`,
    `输出目录：${WORKSPACE_VIRTUAL_PATHS.outputs}`,
    `文件清单：${uploadManifest?.virtualPath || `${WORKSPACE_VIRTUAL_PATHS.manifests}/${UPLOAD_MANIFEST_FILENAME}`}`,
    `项目压缩包清单：${projectArchiveManifest?.virtualPath || `${WORKSPACE_VIRTUAL_PATHS.manifests}/project-archives.json`}`,
    '',
  ];

  const projectArchiveIds = new Set(projectArchives.map((archive) => archive.file_id).filter(Boolean));
  const archiveFiles = syncedFiles.filter((file) => projectArchiveIds.has(file.file_id));
  const contextFiles = syncedFiles.filter((file) => !projectArchiveIds.has(file.file_id));

  if (archiveFiles.length > 0) {
    lines.push('project_archive_files:');
    for (const file of archiveFiles) {
      lines.push(`- name: ${file.filename}`);
      lines.push(`  original_name: ${file.originalName || file.filename}`);
      lines.push(`  virtual_path: ${file.virtualPath}`);
      lines.push(`  mime: ${file.type}`);
      lines.push(`  size: ${file.size} bytes (${formatBytes(file.size)})`);
    }
    lines.push('');
  }

  if (contextFiles.length > 0) {
    lines.push('context_files:');
    for (const file of contextFiles) {
      lines.push(`- name: ${file.filename}`);
      lines.push(`  original_name: ${file.originalName || file.filename}`);
      lines.push(`  virtual_path: ${file.virtualPath}`);
      lines.push(`  sandbox_path: ${file.path}`);
      lines.push(`  size: ${file.size} bytes (${formatBytes(file.size)})`);
      lines.push(`  mime: ${file.type}`);
      lines.push(`  sha256: ${file.sha256}`);
      lines.push(`  uploaded_at: ${file.uploadedAt}`);
      lines.push(`  permission: ${file.permission}`);
    }
    lines.push('');
  }

  if (skippedFiles.length > 0) {
    lines.push('skipped_uploads:');
    for (const file of skippedFiles) {
      lines.push(`- ${file.filename}: ${file.reason}`);
    }
    lines.push('');
  }

  lines.push('archive_tool_status:');
  lines.push(`- commands: ${JSON.stringify(archiveToolStatus.commands)}`);
  lines.push(`- operations: ${JSON.stringify(archiveToolStatus.operations)}`);
  lines.push('');

  lines.push('工作约定：');
  lines.push(`- 能力清单文件：${SANDBOX_PATHS.capabilityManifest}`);
  lines.push(`- 优先通过 workspace_read / workspace_stat / workspace_list 访问 ${WORKSPACE_VIRTUAL_ROOT} 下的文件。`);
  lines.push(`- 读取用户上传文件时，优先使用 ${WORKSPACE_VIRTUAL_PATHS.uploads}/... 路径。`);
  lines.push(`- 临时工作文件写到 ${WORKSPACE_VIRTUAL_PATHS.workdir}。`);
  lines.push(`- 需要交付给用户下载的最终文件，写到 ${WORKSPACE_VIRTUAL_PATHS.outputs}。`);
  lines.push('- 你已经拥有受控工作区权限，不要再向用户请求创建文件的权限。');
  lines.push('- 当用户要求生成可下载结果时，应直接在工作区创建真实文件，由系统生成附件和下载按钮。');
  lines.push('- 只要任务涉及压缩、打包、归档、读取压缩包，先检查上面的 archive_tool_status 或运行等价工具检查，再决定执行路径。');
  lines.push(`- 如果检测到项目压缩包，先读取 ${projectArchiveManifest?.virtualPath || `${WORKSPACE_VIRTUAL_PATHS.manifests}/project-archives.json`}，再进入 primaryProjectRoot。`);
  lines.push('- 读取压缩包时必须执行“确认路径 → 检查工具/后端 → 解压 → 列目录 → 读关键文件 → 再回答”，不能停留在附件元数据层。');
  lines.push('- 未完成实际检查前，不得回复“没有压缩工具”或“无法读取压缩包内容”。');
  lines.push('- 对上传文件默认只看元数据，不要假设已读取全文。');
  lines.push('- 不要在回复中输出原始下载 URL、服务器地址或 IP。');
  lines.push('</uploaded_files_manifest>');

  const uploadsContext = lines.join('\n');
  const projectContext = buildProjectArchivesContext(projectArchives, archiveFailures, projectArchiveManifest);
  return [uploadsContext, projectContext].filter(Boolean).join('\n\n');
}

module.exports = {
  syncMongoFilesToSandbox,
  syncConversationFilesToSandbox,
  buildSandboxUploadsContext,
  computeSha256,
  formatBytes,
  writeUploadManifest,
};
