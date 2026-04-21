const crypto = require('crypto');
const { execFile } = require('child_process');
const fs = require('fs/promises');
const path = require('path');
const { ensureConversationSandbox } = require('./paths');
const { sandboxInfo } = require('./sandboxInfo');
const { processList } = require('./processList');
const { hostFilesystemAccess } = require('./hostFilesystemAccess');
const { databaseConnect } = require('./databaseConnect');
const { assertAdmin } = require('./requester');
const {
  WORKSPACE_VIRTUAL_ROOT,
  WORKSPACE_VIRTUAL_PATHS,
} = require('~/server/services/Platform/runtimeContext');
const { readPolicyAuditLog } = require('~/server/services/RuntimePolicy');
const { getSystemSettings } = require('~/server/services/Config/systemSettings');

const DEFAULT_MAX_FILE_BYTES = Number(process.env.FK521_WORKSPACE_MAX_FILE_BYTES || 0);
const DEFAULT_MAX_TOTAL_WRITE_BYTES = Number(
  process.env.FK521_WORKSPACE_MAX_TOTAL_WRITE_BYTES || 0,
);
const DEFAULT_READ_RETRIES = Number(process.env.FK521_WORKSPACE_READ_RETRIES || 3);
const DEFAULT_READ_RETRY_DELAY_MS = Number(process.env.FK521_WORKSPACE_READ_RETRY_DELAY_MS || 120);
const DEFAULT_ARCHIVE_MAX_DEPTH = Number(process.env.FK521_ARCHIVE_MAX_DEPTH || 12);
const DEFAULT_ARCHIVE_MAX_EXPANSION_RATIO = Number(process.env.FK521_ARCHIVE_MAX_EXPANSION_RATIO || 200);
const WORKSPACE_ROOT_SENTINEL = '__workspace_root__';
const conversationOwnerMap = new Map();

const DANGEROUS_ARCHIVE_EXTENSIONS = new Set(['.exe', '.dll', '.bat', '.cmd', '.ps1', '.vbs', '.js', '.jar', '.scr', '.msi', '.com', '.pif', '.sh']);
const NESTED_ARCHIVE_EXTENSIONS = new Set(['.zip', '.tar', '.tgz', '.tar.gz', '.tbz2', '.tar.bz2', '.txz', '.tar.xz', '.7z', '.rar']);

function assertTenantContext(authContext = {}) {
  const userId = authContext?.user?.id;
  if (!userId || typeof userId !== 'string') {
    throw createWorkspaceError('缺少租户/用户上下文，拒绝访问工作区', 'WORKSPACE_TENANT_CONTEXT_REQUIRED', 403);
  }
}

function assertConversationIsolation(conversationId, authContext = {}) {
  const normalizedConversationId = String(conversationId || '').trim();
  if (!normalizedConversationId) {
    throw createWorkspaceError('缺少会话上下文，拒绝访问工作区', 'WORKSPACE_CONVERSATION_REQUIRED', 403);
  }
  const userId = String(authContext?.user?.id || '').trim();
  const ownedBy = conversationOwnerMap.get(normalizedConversationId);
  if (ownedBy && ownedBy !== userId) {
    throw createWorkspaceError(
      '会话不属于当前用户，拒绝跨租户访问工作区',
      'WORKSPACE_CROSS_TENANT_FORBIDDEN',
      403,
      { conversationId: normalizedConversationId },
    );
  }
  if (!ownedBy) {
    conversationOwnerMap.set(normalizedConversationId, userId);
  }
}

function getArchiveUtils() {
  return require('./archiveUtils');
}

const ROOT_CONFIG = Object.freeze({
  uploads: { hostKey: 'uploadsDir', permission: 'ro', virtualPath: WORKSPACE_VIRTUAL_PATHS.uploads },
  workdir: { hostKey: 'workspaceDir', permission: 'rw', virtualPath: WORKSPACE_VIRTUAL_PATHS.workdir },
  projects: { hostKey: 'projectsDir', permission: 'rw', virtualPath: WORKSPACE_VIRTUAL_PATHS.projects },
  outputs: { hostKey: 'outputsDir', permission: 'rw', virtualPath: WORKSPACE_VIRTUAL_PATHS.outputs },
  manifests: {
    hostKey: 'workspaceDir',
    prefix: 'manifests',
    permission: 'ro',
    virtualPath: WORKSPACE_VIRTUAL_PATHS.manifests,
  },
});

function createWorkspaceError(message, code = 'WORKSPACE_ERROR', status = 400, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  error.details = details;
  return error;
}

function translateSandboxAliasPath(inputPath = '') {
  const normalized = String(inputPath || '').trim().replace(/\\/g, '/');
  if (!normalized) {
    return normalized;
  }

  if (normalized === WORKSPACE_VIRTUAL_ROOT || normalized === `${WORKSPACE_VIRTUAL_ROOT}/`) {
    return WORKSPACE_VIRTUAL_ROOT;
  }

  const aliasMappings = [
    ['/mnt/user-data/uploads', WORKSPACE_VIRTUAL_PATHS.uploads],
    ['/mnt/user-data/outputs', WORKSPACE_VIRTUAL_PATHS.outputs],
    ['/mnt/user-data/workspace/projects', WORKSPACE_VIRTUAL_PATHS.projects],
    ['/mnt/user-data/workspace/tasks', `${WORKSPACE_VIRTUAL_PATHS.workdir}/tasks`],
    ['/mnt/user-data/workspace/manifests', WORKSPACE_VIRTUAL_PATHS.manifests],
    ['/mnt/user-data/workspace/.sandbox-capabilities.json', `${WORKSPACE_VIRTUAL_PATHS.manifests}/.sandbox-capabilities.json`],
    ['/mnt/user-data/workspace', WORKSPACE_VIRTUAL_PATHS.workdir],
  ];

  for (const [aliasPrefix, virtualPrefix] of aliasMappings) {
    if (normalized === aliasPrefix || normalized.startsWith(`${aliasPrefix}/`)) {
      const suffix = normalized.slice(aliasPrefix.length);
      return `${virtualPrefix}${suffix}`.replace(/\/+/, '/').replace(/\/+/g, '/');
    }
  }

  return normalized;
}

function normalizeVirtualPath(inputPath = '') {
  const raw = String(inputPath || '').trim();
  if (!raw) {
    throw createWorkspaceError('缺少工作区路径', 'WORKSPACE_PATH_REQUIRED', 400);
  }

  const normalized = translateSandboxAliasPath(raw);
  if (normalized === WORKSPACE_VIRTUAL_ROOT || normalized === `${WORKSPACE_VIRTUAL_ROOT}/`) {
    return WORKSPACE_ROOT_SENTINEL;
  }

  const withoutRoot = normalized.startsWith(WORKSPACE_VIRTUAL_ROOT)
    ? normalized.slice(WORKSPACE_VIRTUAL_ROOT.length)
    : normalized;
  const relative = path.posix
    .normalize(`/${withoutRoot}`)
    .replace(/^\/+/, '')
    .replace(/^workspace\//, '');

  if (
    !relative ||
    relative === '.' ||
    relative === '..' ||
    relative.startsWith('../') ||
    relative.includes('/../')
  ) {
    throw createWorkspaceError('非法工作区路径', 'WORKSPACE_PATH_TRAVERSAL', 403, { inputPath });
  }

  return relative;
}

function resolveVirtualWorkspacePath(conversationId, inputPath, options = {}) {
  assertTenantContext(options.authContext || {});
  assertConversationIsolation(conversationId, options.authContext || {});
  const relative = normalizeVirtualPath(inputPath);

  if (relative === WORKSPACE_ROOT_SENTINEL) {
    if (options.forWrite) {
      throw createWorkspaceError('工作区根目录不可直接写入', 'WORKSPACE_ROOT_WRITE_FORBIDDEN', 403, { inputPath });
    }
    return {
      root: 'workspace',
      permission: 'mixed',
      virtualPath: WORKSPACE_VIRTUAL_ROOT,
      normalizedPath: WORKSPACE_ROOT_SENTINEL,
      absolutePath: null,
      allowedBase: null,
      isWorkspaceRoot: true,
    };
  }

  const [rootName, ...rest] = relative.split('/');
  const rootConfig = ROOT_CONFIG[rootName];
  if (!rootConfig) {
    throw createWorkspaceError('不允许访问该工作区根目录', 'WORKSPACE_ROOT_NOT_ALLOWED', 403, {
      inputPath,
      allowedRoots: Object.keys(ROOT_CONFIG),
    });
  }

  if (options.forWrite && rootConfig.permission !== 'rw') {
    throw createWorkspaceError('该工作区路径为只读', 'WORKSPACE_PATH_READ_ONLY', 403, {
      inputPath,
      root: rootName,
    });
  }

  const sandboxPaths = ensureConversationSandbox(conversationId, options.authContext || {});
  const baseRoot = sandboxPaths[rootConfig.hostKey];
  const prefix = rootConfig.prefix ? `${rootConfig.prefix}/` : '';
  const childPath = rest.join('/');
  const hostRelative = childPath ? `${prefix}${childPath}` : prefix.replace(/\/$/, '');
  const absolutePath = path.resolve(baseRoot, hostRelative || '.');
  const allowedBase = rootConfig.prefix ? path.resolve(baseRoot, rootConfig.prefix) : path.resolve(baseRoot);

  if (absolutePath !== allowedBase && !absolutePath.startsWith(`${allowedBase}${path.sep}`)) {
    throw createWorkspaceError('工作区路径越界', 'WORKSPACE_PATH_ESCAPE', 403, {
      inputPath,
      root: rootName,
    });
  }

  return {
    root: rootName,
    permission: rootConfig.permission,
    virtualPath: `${WORKSPACE_VIRTUAL_ROOT}/${relative}`,
    normalizedPath: relative,
    absolutePath,
    allowedBase,
    isWorkspaceRoot: false,
  };
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function safeStat(filePath) {
  try {
    return await fs.stat(filePath);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

async function computeSha256(filePath) {
  const data = await fs.readFile(filePath);
  return crypto.createHash('sha256').update(data).digest('hex');
}

async function ensureRealPathWithinBase(absolutePath, allowedBase) {
  try {
    const realPath = await fs.realpath(absolutePath);
    const realBase = await fs.realpath(allowedBase);
    if (realPath !== realBase && !realPath.startsWith(`${realBase}${path.sep}`)) {
      throw createWorkspaceError('符号链接越界，禁止访问工作区外部文件', 'WORKSPACE_SYMLINK_ESCAPE', 403, {
        absolutePath,
        allowedBase,
        realPath,
      });
    }
    return realPath;
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return absolutePath;
    }
    throw error;
  }
}

async function accessReadableFile(absolutePath, allowedBase) {
  const realPath = await ensureRealPathWithinBase(absolutePath, allowedBase);
  await fs.access(realPath, fs.constants.R_OK);
  const stat = await fs.stat(realPath);
  return { stat, realPath };
}

async function accessWritableParent(absolutePath, allowedBase) {
  const parent = path.dirname(absolutePath);
  await fs.mkdir(parent, { recursive: true });
  await fs.chmod(parent, 0o700).catch(() => undefined);
  const realParent = await ensureRealPathWithinBase(parent, allowedBase);
  await fs.access(realParent, fs.constants.W_OK);
  return realParent;
}

async function describePath(resolvedPath, stat = null) {
  const fileStat = stat || (await fs.stat(resolvedPath.absolutePath));
  return {
    path: resolvedPath.virtualPath,
    type: fileStat.isDirectory() ? 'directory' : 'file',
    size: fileStat.isDirectory() ? null : fileStat.size,
    mtime: fileStat.mtime.toISOString(),
    permission: resolvedPath.permission,
    sha256: fileStat.isFile() ? await computeSha256(resolvedPath.absolutePath) : null,
  };
}

function getArchiveEntryExtension(memberPath = '') {
  const lower = String(memberPath || '').toLowerCase();
  const multiExtensions = ['.tar.gz', '.tar.bz2', '.tar.xz'];
  for (const ext of multiExtensions) {
    if (lower.endsWith(ext)) {
      return ext;
    }
  }
  return path.extname(lower);
}

function summarizeArchiveInspection(inspection = {}) {
  const members = Array.isArray(inspection.members) ? inspection.members : [];
  const dangerousExtensions = [];
  const nestedArchives = [];
  let maxDepth = 0;

  for (const member of members) {
    const normalizedPath = String(member.path || member.normalizedPath || member.originalPath || '').replace(/\\/g, '/');
    const segments = normalizedPath.split('/').filter(Boolean);
    maxDepth = Math.max(maxDepth, segments.length);
    const extension = getArchiveEntryExtension(normalizedPath);
    if (extension && DANGEROUS_ARCHIVE_EXTENSIONS.has(extension)) {
      dangerousExtensions.push(normalizedPath);
    }
    if (extension && NESTED_ARCHIVE_EXTENSIONS.has(extension)) {
      nestedArchives.push(normalizedPath);
    }
  }

  const compressionRatio =
    Number(inspection.totalCompressedBytes || 0) > 0
      ? Number(inspection.totalUncompressedBytes || 0) / Number(inspection.totalCompressedBytes || 1)
      : null;

  const bombRisk =
    compressionRatio != null && compressionRatio > DEFAULT_ARCHIVE_MAX_EXPANSION_RATIO
      ? 'high'
      : compressionRatio != null && compressionRatio > DEFAULT_ARCHIVE_MAX_EXPANSION_RATIO / 4
        ? 'medium'
        : 'low';

  return {
    maxDepth,
    dangerousExtensions: [...new Set(dangerousExtensions)].sort(),
    nestedArchives: [...new Set(nestedArchives)].sort(),
    compressionRatio,
    bombRisk,
    preflight: {
      hasDangerousPaths: Number(inspection.dangerousEntries || 0) > 0,
      hasEncryptedEntries: Number(inspection.encryptedEntries || 0) > 0,
      hasDangerousExtensions: dangerousExtensions.length > 0,
      hasNestedArchives: nestedArchives.length > 0,
      exceedsDepthLimit: maxDepth > DEFAULT_ARCHIVE_MAX_DEPTH,
      exceedsExpansionRatio: compressionRatio != null && compressionRatio > DEFAULT_ARCHIVE_MAX_EXPANSION_RATIO,
    },
  };
}

function summarizeArchiveValidation(validation = {}) {
  return {
    preflight: {
      structureOk: Boolean(validation?.structure?.ok),
      integrityOk: Boolean(validation?.integrity?.ok),
      sha256Matches: validation?.sha256Matches,
      encryptedEntryCount: Array.isArray(validation?.encryptedEntries) ? validation.encryptedEntries.length : 0,
      crcStatus: validation?.crc32?.status || 'unknown',
      dangerousPathCount: Array.isArray(validation?.structure?.dangerousPaths)
        ? validation.structure.dangerousPaths.length
        : 0,
      duplicatePathCount: Array.isArray(validation?.structure?.duplicatePaths)
        ? validation.structure.duplicatePaths.length
        : 0,
      emptyNameCount: Array.isArray(validation?.structure?.emptyNames)
        ? validation.structure.emptyNames.length
        : 0,
      pathTypeConflictCount: Array.isArray(validation?.structure?.pathTypeConflicts)
        ? validation.structure.pathTypeConflicts.length
        : 0,
    },
  };
}

async function workspaceList({ conversationId, prefix = WORKSPACE_VIRTUAL_ROOT, authContext = {} }) {
  const resolved = resolveVirtualWorkspacePath(conversationId, prefix, { forWrite: false, authContext });

  if (resolved.isWorkspaceRoot) {
    const sandboxPaths = ensureConversationSandbox(conversationId, authContext);
    const results = await Promise.all(
      Object.entries(ROOT_CONFIG).map(async ([rootName, rootConfig]) => {
        const baseRoot = sandboxPaths[rootConfig.hostKey];
        const absolutePath = rootConfig.prefix
          ? path.resolve(baseRoot, rootConfig.prefix)
          : path.resolve(baseRoot);
        const stat = await safeStat(absolutePath);
        return {
          path: rootConfig.virtualPath,
          type: 'directory',
          size: null,
          mtime: stat?.mtime ? stat.mtime.toISOString() : null,
          permission: rootConfig.permission,
          exists: Boolean(stat?.isDirectory?.()),
          root: rootName,
        };
      }),
    );
    return results.sort((a, b) => a.path.localeCompare(b.path));
  }

  const stat = await safeStat(resolved.absolutePath);
  if (!stat) {
    return [];
  }
  if (!stat.isDirectory()) {
    return [await describePath(resolved, stat)];
  }

  await ensureRealPathWithinBase(resolved.absolutePath, resolved.allowedBase);
  const entries = await fs.readdir(resolved.absolutePath, { withFileTypes: true });
  const results = [];
  for (const entry of entries) {
    const childAbsolute = path.join(resolved.absolutePath, entry.name);
    const childVirtual = `${resolved.virtualPath.replace(/\/$/, '')}/${entry.name}`;
    const childResolved = resolveVirtualWorkspacePath(conversationId, childVirtual, { forWrite: false, authContext });
    const childStat = await fs.stat(childAbsolute);
    results.push({
      path: childResolved.virtualPath,
      type: entry.isDirectory() ? 'directory' : 'file',
      size: entry.isDirectory() ? null : childStat.size,
      mtime: childStat.mtime.toISOString(),
      permission: childResolved.permission,
    });
  }

  return results.sort((a, b) => a.path.localeCompare(b.path));
}

async function workspaceStat({ conversationId, path: targetPath, authContext = {} }) {
  const resolved = resolveVirtualWorkspacePath(conversationId, targetPath, { forWrite: false, authContext });
  if (resolved.isWorkspaceRoot) {
    return {
      path: WORKSPACE_VIRTUAL_ROOT,
      exists: true,
      type: 'directory',
      size: null,
      mtime: null,
      permission: 'mixed',
      sha256: null,
    };
  }

  try {
    const { stat, realPath } = await accessReadableFile(resolved.absolutePath, resolved.allowedBase);
    return {
      exists: true,
      ...(await describePath({ ...resolved, absolutePath: realPath }, stat)),
      realPath,
    };
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return {
        path: resolved.virtualPath,
        exists: false,
        type: null,
        size: null,
        mtime: null,
        permission: resolved.permission,
        sha256: null,
      };
    }
    if (error?.code === 'EACCES' || error?.code === 'EPERM') {
      throw createWorkspaceError('工作区文件存在但权限不足', 'WORKSPACE_PERMISSION_DENIED', 403, { path: targetPath });
    }
    throw error;
  }
}

function buildRangeSlice(buffer, range = {}) {
  const start = Math.max(0, Number(range?.start ?? 0) || 0);
  const endCandidate = range?.end == null ? buffer.length : Number(range.end);
  const end = Number.isFinite(endCandidate)
    ? Math.min(buffer.length, Math.max(start, endCandidate))
    : buffer.length;
  return buffer.subarray(start, end);
}

async function workspaceRead({ conversationId, path: targetPath, range = null, encoding = 'utf8', authContext = {} }) {
  const resolved = resolveVirtualWorkspacePath(conversationId, targetPath, { forWrite: false, authContext });
  if (resolved.isWorkspaceRoot) {
    throw createWorkspaceError('工作区根目录不可直接读取，请先列出具体子目录', 'WORKSPACE_ROOT_READ_FORBIDDEN', 400, {
      path: targetPath,
      allowedRoots: Object.keys(ROOT_CONFIG),
    });
  }

  let lastError = null;
  for (let attempt = 0; attempt < DEFAULT_READ_RETRIES; attempt += 1) {
    try {
      const { stat, realPath } = await accessReadableFile(resolved.absolutePath, resolved.allowedBase);
      if (!stat.isFile()) {
        throw createWorkspaceError('工作区目标不是可读文件', 'WORKSPACE_NOT_A_FILE', 400, { path: targetPath });
      }

      const fileHandle = await fs.open(realPath, 'r');
      try {
        const start = Math.max(0, Number(range?.start ?? 0) || 0);
        const endExclusive = range?.end == null
          ? stat.size
          : Math.min(stat.size, Math.max(start, Number(range.end) || 0));
        const length = Math.max(0, endExclusive - start);
        const buffer = Buffer.alloc(length);
        if (length > 0) {
          await fileHandle.read(buffer, 0, length, start);
        }

        const useBase64 = encoding === 'base64';
        return {
          path: resolved.virtualPath,
          realPath,
          encoding: useBase64 ? 'base64' : 'utf8',
          bytes: buffer.length,
          totalBytes: stat.size,
          range: { start, end: endExclusive },
          sha256: await computeSha256(realPath),
          content: useBase64 ? buffer.toString('base64') : buffer.toString('utf8'),
        };
      } finally {
        await fileHandle.close();
      }
    } catch (error) {
      lastError = error;
      if (!['ENOENT', 'EACCES', 'EPERM'].includes(String(error?.code || '')) || attempt === DEFAULT_READ_RETRIES - 1) {
        break;
      }
      await sleep(DEFAULT_READ_RETRY_DELAY_MS * (attempt + 1));
    }
  }

  if (lastError?.code === 'ENOENT') {
    throw createWorkspaceError('工作区文件不存在或挂载尚未就绪', 'WORKSPACE_NOT_FOUND', 404, { path: targetPath });
  }
  if (lastError?.code === 'EACCES' || lastError?.code === 'EPERM') {
    throw createWorkspaceError('工作区文件存在但不可读取，请检查挂载权限或容器运行用户', 'WORKSPACE_PERMISSION_DENIED', 403, { path: targetPath });
  }
  throw lastError || createWorkspaceError('工作区文件不存在或不可读取', 'WORKSPACE_NOT_FOUND', 404, { path: targetPath });
}

async function getDirectorySize(rootPath) {
  let total = 0;
  const entries = await fs.readdir(rootPath, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const fullPath = path.join(rootPath, entry.name);
    if (entry.isDirectory()) {
      total += await getDirectorySize(fullPath);
    } else if (entry.isFile()) {
      const stat = await fs.stat(fullPath);
      total += stat.size;
    }
  }
  return total;
}

async function enforceWriteQuota({ conversationId, bytes, authContext = {} }) {
  const settings = await getSystemSettings();
  const maxFileBytes = Number(settings.settings?.limits?.workspaceMaxFileBytes ?? DEFAULT_MAX_FILE_BYTES);
  const maxTotalWriteBytes = Number(settings.settings?.limits?.workspaceMaxTotalWriteBytes ?? DEFAULT_MAX_TOTAL_WRITE_BYTES);
  if (maxFileBytes > 0 && bytes > maxFileBytes) {
    throw createWorkspaceError('单文件写入超出限制', 'WORKSPACE_FILE_TOO_LARGE', 413, {
      maxBytes: maxFileBytes,
      bytes,
    });
  }

  const sandboxPaths = ensureConversationSandbox(conversationId, authContext);
  const total = (await getDirectorySize(sandboxPaths.workspaceDir)) + (await getDirectorySize(sandboxPaths.outputsDir));
  if (maxTotalWriteBytes > 0 && total + bytes > maxTotalWriteBytes) {
    throw createWorkspaceError('工作区总写入容量超出限制', 'WORKSPACE_QUOTA_EXCEEDED', 413, {
      maxTotalBytes: maxTotalWriteBytes,
      currentBytes: total,
      requestedBytes: bytes,
    });
  }
}

async function writeFileAtomic(targetPath, buffer) {
  const dir = path.dirname(targetPath);
  const tempPath = path.join(
    dir,
    `.${path.basename(targetPath)}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`,
  );
  await fs.writeFile(tempPath, buffer);
  await fs.chmod(tempPath, 0o600).catch(() => undefined);
  await fs.rename(tempPath, targetPath);
  await fs.chmod(targetPath, 0o600).catch(() => undefined);
}

async function workspaceWrite({ conversationId, path: targetPath, content, overwrite = true, encoding = 'utf8', authContext = {} }) {
  const resolved = resolveVirtualWorkspacePath(conversationId, targetPath, { forWrite: true, authContext });
  const exists = await safeStat(resolved.absolutePath);
  if (exists && overwrite !== true) {
    throw createWorkspaceError('目标文件已存在，且未允许覆盖', 'WORKSPACE_FILE_EXISTS', 409, {
      path: targetPath,
    });
  }

  const buffer =
    encoding === 'base64'
      ? Buffer.from(String(content || ''), 'base64')
      : Buffer.from(String(content || ''), 'utf8');
  await enforceWriteQuota({ conversationId, bytes: buffer.length, authContext });

  try {
    await accessWritableParent(resolved.absolutePath, resolved.allowedBase);
    await writeFileAtomic(resolved.absolutePath, buffer);
    const stat = await fs.stat(resolved.absolutePath);
    return {
      path: resolved.virtualPath,
      bytes: stat.size,
      encoding: encoding === 'base64' ? 'base64' : 'utf8',
      sha256: await computeSha256(resolved.absolutePath),
      overwritten: Boolean(exists),
    };
  } catch (error) {
    if (error?.code === 'EACCES' || error?.code === 'EPERM') {
      throw createWorkspaceError('工作区目录不可写，请检查挂载权限、runAsUser 或宿主机目录属主', 'WORKSPACE_WRITE_PERMISSION_DENIED', 403, {
        path: targetPath,
      });
    }
    throw error;
  }
}

function escapeRegexLiteral(value = '') {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function runWorkspacePythonScript(scriptName, args = []) {
  const scriptPath = path.resolve(__dirname, 'scripts', scriptName);
  return await new Promise((resolve, reject) => {
    execFile('python3', [scriptPath, ...args], { maxBuffer: 20 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        const wrapped = createWorkspaceError(
          `执行 python 脚本失败: ${stderr || error.message}`,
          'WORKSPACE_PYTHON_EXEC_FAILED',
          500,
        );
        wrapped.cause = error;
        reject(wrapped);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function globToRegex(pattern = '**/*') {
  let regex = '^';
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i];
    const next = pattern[i + 1];
    if (char === '*' && next === '*') {
      regex += '.*';
      i += 1;
      continue;
    }
    if (char === '*') {
      regex += '[^/]*';
      continue;
    }
    if (char === '?') {
      regex += '[^/]';
      continue;
    }
    regex += escapeRegexLiteral(char);
  }
  regex += '$';
  return new RegExp(regex);
}

async function collectFilesRecursive(rootDir, includeHidden = false, maxEntries = 5000) {
  const results = [];
  const stack = [rootDir];
  while (stack.length > 0 && results.length < maxEntries) {
    const current = stack.pop();
    const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!includeHidden && entry.name.startsWith('.')) {
        continue;
      }
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile()) {
        results.push(fullPath);
        if (results.length >= maxEntries) {
          break;
        }
      }
    }
  }
  return results;
}

async function workspaceGlobFind({
  conversationId,
  rootPath = WORKSPACE_VIRTUAL_PATHS.workdir,
  pattern = '**/*',
  includeHidden = false,
  maxResults = 200,
  authContext = {},
}) {
  const resolved = resolveVirtualWorkspacePath(conversationId, rootPath, { forWrite: false, authContext });
  const stat = await safeStat(resolved.absolutePath);
  if (!stat || !stat.isDirectory()) {
    return { rootPath: resolved.virtualPath, pattern, matches: [] };
  }
  const matcher = globToRegex(String(pattern || '**/*'));
  const files = await collectFilesRecursive(resolved.absolutePath, includeHidden, Math.max(maxResults * 20, 1000));
  const matches = [];
  for (const file of files) {
    const relative = path.relative(resolved.absolutePath, file).replace(/\\/g, '/');
    if (matcher.test(relative)) {
      matches.push({
        path: `${resolved.virtualPath}/${relative}`.replace(/\/+/g, '/'),
        relativePath: relative,
      });
      if (matches.length >= maxResults) {
        break;
      }
    }
  }
  return {
    rootPath: resolved.virtualPath,
    pattern,
    totalMatches: matches.length,
    matches,
  };
}

async function workspaceGrepSearch({
  conversationId,
  rootPath = WORKSPACE_VIRTUAL_PATHS.workdir,
  query,
  caseSensitive = false,
  regex = false,
  cursor = '',
  pageSize = 100,
  maxResults = 2000,
  authContext = {},
}) {
  if (!query) {
    throw createWorkspaceError('grep 查询不能为空', 'WORKSPACE_QUERY_REQUIRED', 400);
  }
  const resolved = resolveVirtualWorkspacePath(conversationId, rootPath, { forWrite: false, authContext });
  const stat = await safeStat(resolved.absolutePath);
  if (!stat || !stat.isDirectory()) {
    return { rootPath: resolved.virtualPath, query, matches: [] };
  }

  const pageLimit = Math.max(1, Math.min(Number(pageSize) || 100, 1000));
  const pythonArgs = [
    '--root',
    resolved.absolutePath,
    '--query',
    String(query),
    '--page-size',
    String(pageLimit),
    '--max-results',
    String(Math.max(1, Number(maxResults) || 2000)),
  ];
  if (cursor != null && String(cursor).length > 0) {
    pythonArgs.push('--cursor', String(cursor));
  }
  if (caseSensitive) {
    pythonArgs.push('--case-sensitive');
  }
  if (regex) {
    pythonArgs.push('--regex');
  }

  const { stdout } = await runWorkspacePythonScript('workspace_grep_search.py', pythonArgs);
  const grepPage = JSON.parse(String(stdout || '{}'));
  const matches = Array.isArray(grepPage.matches)
    ? grepPage.matches.map((item) => ({
        path: `${resolved.virtualPath}/${String(item.relativePath || '').replace(/^\/+/, '')}`.replace(
          /\/+/g,
          '/',
        ),
        line: Number(item.line) || 0,
        text: String(item.text || ''),
      }))
    : [];

  return {
    rootPath: resolved.virtualPath,
    query,
    cursor: cursor || '',
    pageSize: pageLimit,
    returned: Number(grepPage.returned) || matches.length,
    nextCursor: grepPage.nextCursor ?? null,
    hasMore: Boolean(grepPage.hasMore),
    mode: 'python-streamed',
    matches,
  };
}

async function workspaceDelete({ conversationId, path: targetPath, recursive = false, authContext = {} }) {
  const resolved = resolveVirtualWorkspacePath(conversationId, targetPath, { forWrite: true, authContext });
  const stat = await safeStat(resolved.absolutePath);
  if (!stat) {
    return { path: resolved.virtualPath, deleted: false, reason: 'not_found' };
  }
  if (stat.isDirectory() && !recursive) {
    throw createWorkspaceError('目录删除需要 recursive=true', 'WORKSPACE_DELETE_RECURSIVE_REQUIRED', 400, {
      path: targetPath,
    });
  }
  await accessWritableParent(resolved.absolutePath, resolved.allowedBase);
  await fs.rm(resolved.absolutePath, { recursive: Boolean(recursive), force: true });
  return {
    path: resolved.virtualPath,
    deleted: true,
    type: stat.isDirectory() ? 'directory' : 'file',
    recursive: Boolean(recursive),
  };
}

async function workspaceSearchReplace({
  conversationId,
  path: targetPath,
  search,
  replace = '',
  regex = false,
  caseSensitive = false,
  replaceAll = true,
  authContext = {},
}) {
  if (!search) {
    throw createWorkspaceError('search_replace 缺少 search 参数', 'WORKSPACE_QUERY_REQUIRED', 400);
  }
  const resolved = resolveVirtualWorkspacePath(conversationId, targetPath, { forWrite: true, authContext });
  const source = await fs.readFile(resolved.absolutePath, 'utf8');
  const flags = `${replaceAll ? 'g' : ''}${caseSensitive ? '' : 'i'}`;
  const matcher = regex ? new RegExp(search, flags) : new RegExp(escapeRegexLiteral(String(search)), flags);
  let replacementCount = 0;
  const output = source.replace(matcher, () => {
    replacementCount += 1;
    return String(replace);
  });
  const buffer = Buffer.from(output, 'utf8');
  await enforceWriteQuota({ conversationId, bytes: buffer.length, authContext });
  await writeFileAtomic(resolved.absolutePath, buffer);
  return {
    path: resolved.virtualPath,
    replacements: replacementCount,
    bytes: buffer.length,
    sha256: await computeSha256(resolved.absolutePath),
  };
}

function getTodoVirtualPath() {
  return `${WORKSPACE_VIRTUAL_PATHS.workdir}/manifests/todo.json`;
}

async function workspaceReadTodo({ conversationId, authContext = {} }) {
  const todoPath = getTodoVirtualPath();
  const resolved = resolveVirtualWorkspacePath(conversationId, todoPath, { forWrite: false, authContext });
  const raw = await fs.readFile(resolved.absolutePath, 'utf8').catch(() => '[]');
  const todos = JSON.parse(raw);
  return {
    path: resolved.virtualPath,
    total: Array.isArray(todos) ? todos.length : 0,
    todos: Array.isArray(todos) ? todos : [],
  };
}

async function workspaceWriteTodo({ conversationId, todos = [], authContext = {} }) {
  const todoPath = getTodoVirtualPath();
  const resolved = resolveVirtualWorkspacePath(conversationId, todoPath, { forWrite: true, authContext });
  await accessWritableParent(resolved.absolutePath, resolved.allowedBase);
  const normalized = Array.isArray(todos)
    ? todos.map((item, index) => ({
      id: item?.id || `todo-${index + 1}`,
      title: String(item?.title || '').trim(),
      done: item?.done === true,
      priority: item?.priority || 'normal',
    }))
    : [];
  const buffer = Buffer.from(JSON.stringify(normalized, null, 2), 'utf8');
  await enforceWriteQuota({ conversationId, bytes: buffer.length, authContext });
  await writeFileAtomic(resolved.absolutePath, buffer);
  return {
    path: resolved.virtualPath,
    total: normalized.length,
    done: normalized.filter((item) => item.done).length,
  };
}

async function workspaceTaskSummary({ conversationId, authContext = {} }) {
  const todoResult = await workspaceReadTodo({ conversationId, authContext });
  const done = todoResult.todos.filter((item) => item.done).length;
  const pending = todoResult.total - done;
  return {
    conversationId: String(conversationId),
    todoPath: todoResult.path,
    total: todoResult.total,
    done,
    pending,
    completionRate: todoResult.total > 0 ? Number((done / todoResult.total).toFixed(4)) : 0,
    summary: pending === 0 ? 'all_tasks_completed' : 'tasks_pending',
  };
}

async function workspaceExtractArchive({ conversationId, archivePath, destinationPath, format, authContext = {} }) {
  const archiveResolved = resolveVirtualWorkspacePath(conversationId, archivePath, { forWrite: false, authContext });
  const destinationResolved = resolveVirtualWorkspacePath(conversationId, destinationPath, { forWrite: true, authContext });

  try {
    const { stat, realPath } = await accessReadableFile(archiveResolved.absolutePath, archiveResolved.allowedBase);
    if (!stat.isFile()) {
      throw createWorkspaceError('压缩包路径不是文件', 'WORKSPACE_NOT_A_FILE', 400, { path: archivePath });
    }

    const inspection = await archiveInspect({ conversationId, path: archivePath, maxEntries: 1000, authContext });
    const validation = await archiveValidate({ conversationId, path: archivePath, expectedSha256: inspection.archiveSha256, authContext });

    const preflightIssues = [];
    if (inspection.preflight?.hasDangerousPaths) {
      preflightIssues.push('contains_dangerous_paths');
    }
    if (inspection.preflight?.hasEncryptedEntries) {
      preflightIssues.push('contains_encrypted_entries');
    }
    if (inspection.preflight?.hasDangerousExtensions) {
      preflightIssues.push('contains_dangerous_extensions');
    }
    if (inspection.preflight?.exceedsDepthLimit) {
      preflightIssues.push('exceeds_depth_limit');
    }
    if (inspection.preflight?.exceedsExpansionRatio || inspection.bombRisk === 'high') {
      preflightIssues.push('suspected_archive_bomb');
    }
    if (!validation.preflight?.structureOk) {
      preflightIssues.push('structure_validation_failed');
    }
    if (!validation.preflight?.integrityOk) {
      preflightIssues.push('integrity_validation_failed');
    }

    if (preflightIssues.length > 0) {
      throw createWorkspaceError('归档安全校验未通过，拒绝解压', 'WORKSPACE_ARCHIVE_PREFLIGHT_FAILED', 400, {
        archivePath,
        destinationPath,
        preflightIssues,
        inspection: {
          dangerousEntries: inspection.dangerousEntries,
          dangerousExtensions: inspection.dangerousExtensions,
          maxDepth: inspection.maxDepth,
          bombRisk: inspection.bombRisk,
        },
        validation: {
          integrity: validation.integrity,
          structure: validation.structure,
          crc32: validation.crc32,
        },
      });
    }

    await accessWritableParent(destinationResolved.absolutePath, destinationResolved.allowedBase);
    await fs.mkdir(destinationResolved.absolutePath, { recursive: true });
    const { extractArchive } = getArchiveUtils();
    const archiveFormat = await extractArchive({
      archivePath: realPath,
      destinationDir: destinationResolved.absolutePath,
      format,
    });
    const entries = await workspaceList({ conversationId, prefix: destinationResolved.virtualPath, authContext });
    return {
      archivePath: archiveResolved.virtualPath,
      destinationPath: destinationResolved.virtualPath,
      format: archiveFormat.id,
      extracted: true,
      entryCount: entries.length,
      entries,
      preflight: {
        inspection,
        validation,
      },
    };
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw createWorkspaceError('压缩包不存在或目标目录不可用', 'WORKSPACE_ARCHIVE_PATH_INVALID', 404, {
        archivePath,
        destinationPath,
      });
    }
    throw error;
  }
}

async function resolveArchiveSources({ conversationId, sourcePath, includePaths = [], authContext = {} }) {
  const sourceResolved = resolveVirtualWorkspacePath(conversationId, sourcePath, { forWrite: false, authContext });
  const sourceRealPath = await ensureRealPathWithinBase(sourceResolved.absolutePath, sourceResolved.allowedBase);
  const sourceStat = await safeStat(sourceRealPath);
  if (!sourceStat) {
    throw createWorkspaceError('归档源路径不存在', 'WORKSPACE_NOT_FOUND', 404, { path: sourcePath });
  }

  const normalizedIncludePaths = Array.isArray(includePaths)
    ? includePaths.map((item) => String(item || '').trim()).filter(Boolean)
    : [];
  if (normalizedIncludePaths.length === 0) {
    if (sourceStat.isDirectory()) {
      const modelExtensions = new Set([
        '.onnx',
        '.bin',
        '.safetensors',
        '.pt',
        '.ckpt',
        '.gguf',
        '.json',
      ]);
      const entries = await fs.readdir(sourceRealPath, { withFileTypes: true }).catch(() => []);
      const modelFiles = entries
        .filter((entry) => entry.isFile())
        .map((entry) => path.join(sourceRealPath, entry.name))
        .filter((filePath) => modelExtensions.has(path.extname(filePath).toLowerCase()));
      if (modelFiles.length === 1) {
        return {
          sourceResolved,
          sourceHostPath: sourceRealPath,
          sourceHostPaths: [modelFiles[0]],
        };
      }
    }
    return {
      sourceResolved,
      sourceHostPath: sourceRealPath,
      sourceHostPaths: [sourceRealPath],
    };
  }

  const sourceHostPaths = [];
  for (const includePath of normalizedIncludePaths) {
    const targetVirtualPath = includePath.startsWith('/')
      ? includePath
      : path.posix.join(sourceResolved.virtualPath, includePath).replace(/\\/g, '/');
    const resolved = resolveVirtualWorkspacePath(conversationId, targetVirtualPath, {
      forWrite: false,
      authContext,
    });
    const realPath = await ensureRealPathWithinBase(resolved.absolutePath, resolved.allowedBase);
    const stat = await safeStat(realPath);
    if (!stat) {
      throw createWorkspaceError('归档包含路径不存在', 'WORKSPACE_NOT_FOUND', 404, {
        path: includePath,
      });
    }
    sourceHostPaths.push(realPath);
  }

  return {
    sourceResolved,
    sourceHostPath: sourceRealPath,
    sourceHostPaths,
  };
}

async function workspaceCreateArchive({
  conversationId,
  sourcePath,
  includePaths = [],
  outputPath,
  stripTopLevel = false,
  format,
  authContext = {},
}) {
  const { sourceResolved, sourceHostPath, sourceHostPaths } = await resolveArchiveSources({
    conversationId,
    sourcePath,
    includePaths,
    authContext,
  });
  const outputResolved = resolveVirtualWorkspacePath(conversationId, outputPath, { forWrite: true, authContext });
  await accessWritableParent(outputResolved.absolutePath, outputResolved.allowedBase);
  const { createArchive, inferArchiveFormat } = getArchiveUtils();
  const inferredFormat = inferArchiveFormat({ outputFilename: outputResolved.absolutePath, archiveFormat: format });
  await createArchive({
    sourceHostPath,
    sourceHostPaths,
    outputHostPath: outputResolved.absolutePath,
    format: inferredFormat.id,
    stripTopLevel: Boolean(stripTopLevel),
  });
  const stat = await fs.stat(outputResolved.absolutePath);
  return {
    path: outputResolved.virtualPath,
    sourcePath: sourceResolved.virtualPath,
    includedPathCount: sourceHostPaths.length,
    stripTopLevel: Boolean(stripTopLevel),
    bytes: stat.size,
    format: inferredFormat.id,
    sha256: await computeSha256(outputResolved.absolutePath),
  };
}

async function archiveInspect({ conversationId, path: targetPath, maxEntries, authContext = {} }) {
  const resolved = resolveVirtualWorkspacePath(conversationId, targetPath, { forWrite: false, authContext });
  const { stat, realPath } = await accessReadableFile(resolved.absolutePath, resolved.allowedBase);
  if (!stat.isFile()) {
    throw createWorkspaceError('归档目标不是文件', 'WORKSPACE_NOT_A_FILE', 400, { path: targetPath });
  }
  const { inspectArchive } = getArchiveUtils();
  const inspection = await inspectArchive({
    archivePath: realPath,
    maxEntries,
  });
  const summary = summarizeArchiveInspection(inspection);
  return {
    path: resolved.virtualPath,
    archiveSha256: await computeSha256(realPath),
    format: inspection.format.id,
    entryCount: inspection.entryCount,
    truncated: inspection.truncated,
    encryptedEntries: inspection.encryptedEntries,
    dangerousEntries: inspection.dangerousEntries,
    totalUncompressedBytes: inspection.totalUncompressedBytes,
    totalCompressedBytes: inspection.totalCompressedBytes,
    maxDepth: summary.maxDepth,
    dangerousExtensions: summary.dangerousExtensions,
    nestedArchives: summary.nestedArchives,
    compressionRatio: summary.compressionRatio,
    bombRisk: summary.bombRisk,
    preflight: summary.preflight,
    members: inspection.members,
  };
}

async function archiveValidate({ conversationId, path: targetPath, expectedSha256, includeMemberHashes = false, authContext = {} }) {
  const resolved = resolveVirtualWorkspacePath(conversationId, targetPath, { forWrite: false, authContext });
  const { stat, realPath } = await accessReadableFile(resolved.absolutePath, resolved.allowedBase);
  if (!stat.isFile()) {
    throw createWorkspaceError('归档目标不是文件', 'WORKSPACE_NOT_A_FILE', 400, { path: targetPath });
  }
  const { validateArchive } = getArchiveUtils();
  const validation = await validateArchive({
    archivePath: realPath,
    expectedSha256,
    includeMemberHashes,
  });
  const summary = summarizeArchiveValidation(validation);
  return {
    path: resolved.virtualPath,
    format: validation.format.id,
    memberCount: validation.memberCount,
    archiveSha256: validation.archiveSha256,
    expectedSha256: validation.expectedSha256,
    sha256Matches: validation.sha256Matches,
    encryptedEntries: validation.encryptedEntries,
    crc32: validation.crc32,
    structure: validation.structure,
    integrity: validation.integrity,
    memberHashes: validation.memberHashes,
    preflight: summary.preflight,
  };
}

async function getPathSize(targetPath) {
  const stat = await safeStat(targetPath);
  if (!stat) {
    return 0;
  }
  if (stat.isDirectory()) {
    return await getDirectorySize(targetPath);
  }
  return stat.size;
}

function toWorkdirVirtualPath(hostPath, workspaceDir) {
  const relative = path.relative(workspaceDir, hostPath).replace(/\\/g, '/');
  if (!relative) {
    return WORKSPACE_VIRTUAL_PATHS.workdir;
  }
  return `${WORKSPACE_VIRTUAL_PATHS.workdir}/${relative}`.replace(/\/+/g, '/');
}

async function workspacePurge({ conversationId, dryRun = false, requester, authContext = {} }) {
  assertAdmin(requester, 'workspace_purge');
  const sandboxPaths = ensureConversationSandbox(conversationId, authContext);
  const preserveNames = new Set(['projects', 'manifests', '.sandbox-capabilities.json']);
  const entries = await fs.readdir(sandboxPaths.workspaceDir, { withFileTypes: true }).catch(() => []);

  const purgePlan = [];
  for (const entry of entries) {
    if (preserveNames.has(entry.name)) {
      continue;
    }
    const absolutePath = path.join(sandboxPaths.workspaceDir, entry.name);
    purgePlan.push({
      hostPath: absolutePath,
      virtualPath: toWorkdirVirtualPath(absolutePath, sandboxPaths.workspaceDir),
      bytes: await getPathSize(absolutePath),
      type: entry.isDirectory() ? 'directory' : 'file',
      reason: 'temporary_workdir_content',
    });
  }

  const reclaimedBytes = purgePlan.reduce((total, item) => total + item.bytes, 0);
  if (!dryRun) {
    for (const item of purgePlan) {
      await fs.rm(item.hostPath, { recursive: true, force: true });
    }
  }

  return {
    conversationId: String(conversationId),
    dryRun: Boolean(dryRun),
    purgedCount: purgePlan.length,
    reclaimedBytes,
    purged: purgePlan.map(({ virtualPath, bytes, type, reason }) => ({ path: virtualPath, bytes, type, reason })),
    preserved: [
      WORKSPACE_VIRTUAL_PATHS.uploads,
      WORKSPACE_VIRTUAL_PATHS.outputs,
      WORKSPACE_VIRTUAL_PATHS.projects,
      WORKSPACE_VIRTUAL_PATHS.manifests,
    ],
    summary: dryRun ? 'preview_only' : 'deleted',
  };
}

async function policyAuditLog({ conversationId, limit = 100, toolName = null, requester, scope = 'session', eventType = null, policyResult = null, reasonCode = null }) {
  if (scope === 'global') {
    assertAdmin(requester, 'policy_audit_log_global');
  }

  let events = readPolicyAuditLog({
    conversationId: scope === 'global' ? null : conversationId,
    toolName,
    limit: Math.max(1, Number(limit) || 100),
  });

  if (eventType) {
    events = events.filter((event) => String(event.eventType || '') === String(eventType));
  }
  if (policyResult) {
    events = events.filter((event) => String(event.policyResult || '') === String(policyResult));
  }
  if (reasonCode) {
    events = events.filter((event) => String(event.reasonCode || '') === String(reasonCode));
  }

  return {
    conversationId: scope === 'global' ? null : String(conversationId),
    scope,
    returned: events.length,
    events,
  };
}

async function listSandboxProcesses({ requester, scope = 'sandbox', maxProcesses }) {
  return await processList({ requester, scope, maxProcesses });
}

async function accessHostFilesystem({ requester, operation, path, range, encoding, content, overwrite }) {
  return await hostFilesystemAccess({ requester, operation, path, range, encoding, content, overwrite });
}

async function connectDatabase({ requester, driver, connection, query, params, readOnly, maxRows }) {
  return await databaseConnect({ requester, driver, connection, query, params, readOnly, maxRows });
}

module.exports = {
  WORKSPACE_VIRTUAL_ROOT,
  WORKSPACE_VIRTUAL_PATHS,
  createWorkspaceError,
  translateSandboxAliasPath,
  normalizeVirtualPath,
  resolveVirtualWorkspacePath,
  workspaceList,
  workspaceRead,
  workspaceWrite,
  workspaceDelete,
  workspaceGlobFind,
  workspaceGrepSearch,
  workspaceSearchReplace,
  workspaceReadTodo,
  workspaceWriteTodo,
  workspaceTaskSummary,
  workspaceStat,
  workspaceExtractArchive,
  workspaceCreateArchive,
  archiveInspect,
  archiveValidate,
  sandboxInfo,
  workspacePurge,
  policyAuditLog,
  listSandboxProcesses,
  accessHostFilesystem,
  connectDatabase,
};
