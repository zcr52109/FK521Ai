const fs = require('fs');
const path = require('path');
const { WORKSPACE_VIRTUAL_PATHS } = require('~/server/services/Platform/runtimeContext');

const FALLBACK_BASE_DIR = path.resolve(process.cwd(), 'runtime', 'sandbox');

function sanitizeSegment(value, fallback = 'item') {
  const normalized = String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || fallback;
}

function getSandboxBaseDir() {
  return path.resolve(String(process.env.FK521_SANDBOX_BASE_DIR || FALLBACK_BASE_DIR));
}

function ensureConversationSandbox(conversationId = 'new', _authContext = {}) {
  const safeConversationId = sanitizeSegment(conversationId, 'new');
  const rootDir = path.join(getSandboxBaseDir(), safeConversationId);
  const uploadsDir = path.join(rootDir, 'uploads');
  const workdirDir = path.join(rootDir, 'workdir');
  const projectsDir = path.join(rootDir, 'projects');
  const outputsDir = path.join(rootDir, 'outputs');
  const workspaceDir = rootDir;

  for (const dir of [rootDir, uploadsDir, workdirDir, projectsDir, outputsDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }

  return {
    rootDir,
    workspaceDir,
    uploadsDir,
    workdirDir,
    projectsDir,
    outputsDir,
  };
}

function toSandboxUploadPath(filename = '') {
  return `${WORKSPACE_VIRTUAL_PATHS.uploads}/${String(filename || '').replace(/^\/+/, '')}`;
}

function normalizeRelativeSandboxPath(relativePath = '') {
  const normalized = path.posix.normalize(`/${String(relativePath || '').replace(/\\/g, '/')}`);
  return normalized.replace(/^\/+/, '');
}

function classifySandboxRelativePath(relativePath = '') {
  const normalized = normalizeRelativeSandboxPath(relativePath);
  if (!normalized) {
    return { normalizedPath: '', root: null, rootId: null, downloadAllowed: false };
  }
  const root = normalized.split('/')[0];
  const downloadAllowed =
    normalized.startsWith('outputs/') ||
    normalized === 'outputs' ||
    normalized.startsWith('workspace/tasks/');
  return {
    normalizedPath: normalized,
    root,
    rootId: root,
    downloadAllowed,
  };
}

async function resolveConversationFile(conversationId, relativePath = '', _options = {}) {
  const sandbox = ensureConversationSandbox(conversationId || 'new');
  const normalizedPath = normalizeRelativeSandboxPath(relativePath);
  const segments = normalizedPath.split('/');
  const root = segments.shift();
  const relative = segments.join('/');

  const rootDirMap = {
    uploads: sandbox.uploadsDir,
    workspace: sandbox.workdirDir,
    workdir: sandbox.workdirDir,
    projects: sandbox.projectsDir,
    outputs: sandbox.outputsDir,
  };

  const baseDir = rootDirMap[root];
  if (!baseDir) {
    const error = new Error('Unsupported sandbox root');
    error.code = 'SANDBOX_ROOT_UNSUPPORTED';
    throw error;
  }

  const absolutePath = path.resolve(baseDir, relative);
  if (!absolutePath.startsWith(path.resolve(baseDir))) {
    const error = new Error('Sandbox path escapes root');
    error.code = 'SANDBOX_PATH_ESCAPE';
    throw error;
  }

  return {
    normalizedPath,
    absolutePath,
  };
}

module.exports = {
  sanitizeSegment,
  ensureConversationSandbox,
  toSandboxUploadPath,
  normalizeRelativeSandboxPath,
  classifySandboxRelativePath,
  resolveConversationFile,
};
