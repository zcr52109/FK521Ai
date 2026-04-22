const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { logger } = require('@fk521ai/data-schemas');
const { ensureConversationSandbox, sanitizeSegment } = require('./paths');
const { WORKSPACE_VIRTUAL_PATHS } = require('~/server/services/Platform/runtimeContext');
const { getArchiveFormat, isArchiveFile } = require('./archiveUtils');

const PROJECT_ARCHIVE_MANIFEST_FILENAME = 'project-archives.json';
const KEY_ROOT_MARKERS = [
  'package.json',
  'pnpm-workspace.yaml',
  'turbo.json',
  'nx.json',
  'pyproject.toml',
  'requirements.txt',
  'cargo.toml',
  'go.mod',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'composer.json',
];
const KEY_HIDDEN_MARKERS = [
  '.gitignore',
  '.npmrc',
  '.nvmrc',
  '.python-version',
  '.env.example',
  '.devcontainer',
  '.github',
  '.vscode',
];

function toVirtualProjectPath(segments = []) {
  const suffix = segments.filter(Boolean).join('/');
  return suffix ? `${WORKSPACE_VIRTUAL_PATHS.projects}/${suffix}` : WORKSPACE_VIRTUAL_PATHS.projects;
}

async function listDirSafe(dirPath) {
  try {
    return await fsp.readdir(dirPath, { withFileTypes: true });
  } catch (_error) {
    return [];
  }
}

function scoreRootCandidate(markerHits = [], hasSrcLike = false) {
  return markerHits.length * 10 + (hasSrcLike ? 2 : 0);
}

async function analyzeExtractedDirectory(extractDir) {
  const entries = await listDirSafe(extractDir);
  const visibleDirs = entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => entry.name);
  const topLevelFiles = entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
  const hiddenRootEntries = entries.filter((entry) => entry.name.startsWith('.')).map((entry) => entry.name);
  const hiddenKeySignals = hiddenRootEntries.filter((entry) => KEY_HIDDEN_MARKERS.includes(entry)).sort();
  const rootCandidates = [];

  const candidateNames = visibleDirs.length > 0 ? visibleDirs : ['.'];
  for (const candidateName of candidateNames) {
    const candidatePath = candidateName === '.' ? extractDir : path.join(extractDir, candidateName);
    const candidateEntries = await listDirSafe(candidatePath);
    const candidateFileNames = candidateEntries.filter((entry) => entry.isFile()).map((entry) => entry.name);
    const candidateDirNames = candidateEntries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    const markerHits = [...new Set(candidateFileNames.map((file) => file.toLowerCase()))].filter((file) =>
      KEY_ROOT_MARKERS.includes(file),
    );
    const hasSrcLike = candidateDirNames.some((name) =>
      ['src', 'app', 'packages', 'backend', 'frontend', 'server', 'client'].includes(name.toLowerCase()),
    );

    rootCandidates.push({
      name: candidateName,
      sandboxPath: candidateName === '.' ? toVirtualProjectPath([path.basename(extractDir)]) : toVirtualProjectPath([path.basename(extractDir), candidateName]),
      markerHits,
      hiddenKeySignals: hiddenRootEntries.filter((entry) => KEY_HIDDEN_MARKERS.includes(entry)),
      score: scoreRootCandidate(markerHits, hasSrcLike),
      topFiles: candidateFileNames.slice(0, 20),
      topDirectories: candidateDirNames.slice(0, 20),
    });
  }

  const sorted = [...rootCandidates].sort((a, b) => b.score - a.score);
  const primary = sorted[0] && sorted[0].score > 0 ? sorted[0] : null;

  return {
    topLevel: {
      visibleDirectoryCount: visibleDirs.length,
      visibleDirectories: visibleDirs.slice(0, 30),
      topLevelFiles: topLevelFiles.slice(0, 30),
      hiddenKeySignals,
    },
    rootCandidates: sorted.map((candidate) => ({
      name: candidate.name,
      sandboxPath: candidate.sandboxPath,
      markerHits: candidate.markerHits,
      hiddenKeySignals: candidate.hiddenKeySignals,
      topFiles: candidate.topFiles,
      topDirectories: candidate.topDirectories,
      score: candidate.score,
    })),
    primaryProjectRoot: primary ? primary.sandboxPath : null,
  };
}

function deriveLikelyCommands(rootCandidate = {}) {
  const markerSet = new Set((rootCandidate.markerHits || []).map((marker) => marker.toLowerCase()));
  const commands = [];
  if (markerSet.has('package.json')) {
    commands.push('npm install', 'npm run build', 'npm test');
  }
  if (markerSet.has('pyproject.toml') || markerSet.has('requirements.txt')) {
    commands.push('python -m venv .venv', 'pip install -r requirements.txt');
  }
  if (markerSet.has('go.mod')) {
    commands.push('go mod tidy', 'go test ./...');
  }
  if (markerSet.has('cargo.toml')) {
    commands.push('cargo build', 'cargo test');
  }
  return [...new Set(commands)].slice(0, 6);
}

function deriveLanguageHints(rootCandidate = {}) {
  const markerSet = new Set((rootCandidate.markerHits || []).map((marker) => marker.toLowerCase()));
  const hints = [];
  if (markerSet.has('package.json')) hints.push('javascript', 'typescript');
  if (markerSet.has('pyproject.toml') || markerSet.has('requirements.txt')) hints.push('python');
  if (markerSet.has('go.mod')) hints.push('go');
  if (markerSet.has('cargo.toml')) hints.push('rust');
  if (markerSet.has('pom.xml') || markerSet.has('build.gradle') || markerSet.has('build.gradle.kts')) hints.push('java');
  return [...new Set(hints)];
}

async function extractProjectArchive(archive = {}, options = {}) {
  const conversationId = options.conversationId || 'new';
  const { projectsDir } = ensureConversationSandbox(conversationId, options.authContext || {});
  const archiveName = String(archive.filename || archive.originalName || archive.file_id || 'archive').trim();
  const baseName = archiveName.replace(/(\.tar\.gz|\.tgz|\.zip|\.7z|\.rar)$/i, '');
  const uniqueSeed = String(archive.file_id || archive.sha256 || archiveName || 'archive');
  const suffix = crypto.createHash('sha1').update(uniqueSeed).digest('hex').slice(0, 8);
  const extractDirName = `${sanitizeSegment(baseName, 'project')}--${suffix}`;
  const extractDir = path.join(projectsDir, extractDirName);

  await fsp.mkdir(extractDir, { recursive: true });
  const placeholderFile = path.join(extractDir, '.extracted-from-upload');
  if (!fs.existsSync(placeholderFile)) {
    await fsp.writeFile(placeholderFile, archiveName, 'utf8');
  }

  const analyzed = await analyzeExtractedDirectory(extractDir);
  const primaryCandidate =
    analyzed.rootCandidates.find((candidate) => candidate.sandboxPath === analyzed.primaryProjectRoot) ||
    analyzed.rootCandidates[0] ||
    null;

  return {
    file_id: archive.file_id || null,
    archiveFilename: archiveName,
    archiveFormat: getArchiveFormat(archiveName, archive.type),
    uploadedArchivePath: archive.virtualPath || archive.path || null,
    extractHostPath: extractDir,
    extractSandboxPath: toVirtualProjectPath([extractDirName]),
    primaryProjectRoot: analyzed.primaryProjectRoot,
    projectRootCandidates: analyzed.rootCandidates,
    treeSummary: analyzed.topLevel,
    keyFiles: primaryCandidate?.markerHits || [],
    frameworkHints: primaryCandidate?.markerHits || [],
    languageHints: deriveLanguageHints(primaryCandidate),
    likelyCommands: deriveLikelyCommands(primaryCandidate),
    extractionWarnings: [],
    reused: false,
  };
}

async function writeProjectArchiveManifest(conversationId, archives = [], authContext = {}) {
  const { workspaceDir } = ensureConversationSandbox(conversationId, authContext);
  const manifestsDir = path.join(workspaceDir, 'manifests');
  await fsp.mkdir(manifestsDir, { recursive: true });
  const hostPath = path.join(manifestsDir, PROJECT_ARCHIVE_MANIFEST_FILENAME);
  const manifest = {
    version: 1,
    generatedAt: new Date().toISOString(),
    archives,
  };
  await fsp.writeFile(hostPath, JSON.stringify(manifest, null, 2), 'utf8');
  return {
    hostPath,
    virtualPath: `${WORKSPACE_VIRTUAL_PATHS.manifests}/${PROJECT_ARCHIVE_MANIFEST_FILENAME}`,
    manifest,
  };
}

async function prepareProjectArchives({ conversationId, syncedFiles = [], authContext = {} } = {}) {
  const projectArchives = [];
  const archiveFailures = [];

  for (const file of syncedFiles) {
    if (!isArchiveFile(file)) {
      continue;
    }
    try {
      const archive = await extractProjectArchive(file, { conversationId, authContext });
      projectArchives.push(archive);
    } catch (error) {
      archiveFailures.push({
        file_id: file.file_id,
        archiveFilename: file.filename || file.originalName || 'archive',
        message: '项目压缩包解析失败',
      });
      logger.warn(`[project archives] failed to prepare ${file.filename}: ${error?.message || error}`);
    }
  }

  const manifestInfo = await writeProjectArchiveManifest(conversationId, projectArchives, authContext);
  return {
    projectArchives,
    archiveFailures,
    manifestInfo,
  };
}

function buildProjectArchivesContext(projectArchives = [], archiveFailures = [], manifestInfo = null) {
  if (!projectArchives.length && !archiveFailures.length) {
    return '';
  }

  const lines = [
    '<project_archives_manifest>',
    '项目压缩包已分类到 project archives；请优先读取结构化 manifest，再决定进入哪个目录工作。',
    `manifest_path: ${manifestInfo?.virtualPath || `${WORKSPACE_VIRTUAL_PATHS.manifests}/${PROJECT_ARCHIVE_MANIFEST_FILENAME}`}`,
    '工作规则：',
    '- 如果存在 primaryProjectRoot，默认先在该目录进行读取与修改。',
    '- 如果 primaryProjectRoot 为空，必须先查看 projectRootCandidates，不要直接在 uploads 根目录执行修改。',
    '- 交付文件写入 /workspace/outputs，由系统生成附件和下载按钮；不要输出原始下载 URL、服务器地址或 IP。',
    '',
    'project_archives:',
  ];

  for (const archive of projectArchives) {
    lines.push(`- archive: ${archive.archiveFilename}`);
    lines.push(`  extractSandboxPath: ${archive.extractSandboxPath}`);
    lines.push(`  primaryProjectRoot: ${archive.primaryProjectRoot || 'null'}`);
    lines.push(`  rootCandidates: ${archive.projectRootCandidates.length}`);
    lines.push(`  languageHints: ${(archive.languageHints || []).join(', ') || 'unknown'}`);
  }

  if (archiveFailures.length > 0) {
    lines.push('');
    lines.push('archive_failures:');
    for (const failure of archiveFailures) {
      lines.push(`- ${failure.archiveFilename}: ${failure.message}`);
    }
  }
  lines.push('</project_archives_manifest>');
  return lines.join('\n');
}

module.exports = {
  PROJECT_ARCHIVE_MANIFEST_FILENAME,
  extractProjectArchive,
  prepareProjectArchives,
  buildProjectArchivesContext,
  writeProjectArchiveManifest,
};
