const fs = require('fs');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..', '..', '..');
const defaultConfigPath = path.resolve(projectRoot, 'runtime', 'admin', 'dify-console.json');

function getDifyConsoleConfigPath() {
  return process.env.FK521_DIFY_CONSOLE_PATH || defaultConfigPath;
}

function ensureStorageFile() {
  const configPath = getDifyConsoleConfigPath();
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  if (!fs.existsSync(configPath)) {
    fs.writeFileSync(configPath, `${JSON.stringify(getDefaultConfig(), null, 2)}\n`, 'utf8');
  }
  return configPath;
}

function createId(prefix = 'item') {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeText(value, fallback = '') {
  const text = String(value ?? '').trim();
  return text || fallback;
}

function normalizeBool(value, fallback = false) {
  return value === undefined ? fallback : value === true;
}

function toInt(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, parsed));
}

function normalizeDelimitedText(value = '') {
  return String(value ?? '')
    .split(/[\n\r,;|、\s]+/)
    .map((item) => item.trim())
    .filter(Boolean)
    .join('\n');
}

function normalizeList(items, type) {
  if (!Array.isArray(items)) {
    return [];
  }

  return items
    .filter((item) => item && typeof item === 'object')
    .map((item) => ({
      id: normalizeText(item.id, createId(type)),
      name: normalizeText(item.name, `${type}-${Date.now()}`),
      description: normalizeText(item.description),
      type: normalizeText(item.type || item.mode || item.provider, type),
      provider: normalizeText(item.provider),
      enabled: normalizeBool(item.enabled, true),
      status: normalizeText(item.status, item.enabled === false ? 'disabled' : 'active'),
      documentCount: toInt(item.documentCount, 0, 0, 1000000),
      workflowCount: toInt(item.workflowCount, 0, 0, 1000000),
      toolCount: toInt(item.toolCount, 0, 0, 1000000),
      updatedAt: new Date().toISOString(),
    }));
}

function getDefaultConfig() {
  return {
    workspace: {
      name: '工作室',
      description: '',
    },
    workflows: [
      {
        id: 'workflow-default',
        name: '标准工作流',
        description: '',
        type: 'workflow',
        provider: 'local',
        enabled: true,
        status: 'draft',
        updatedAt: new Date().toISOString(),
      },
    ],
    tools: [
      {
        id: 'tool-local-code',
        name: '本地代码执行器',
        description: '',
        type: 'executor',
        provider: 'local',
        enabled: true,
        status: 'active',
        updatedAt: new Date().toISOString(),
      },
    ],
    codeExecutor: {
      enabled: true,
      defaultLanguage: 'python',
      allowNetwork: false,
      timeoutMs: 12000,
      maxOutputBytes: 131072,
      workdir: path.resolve(projectRoot, 'runtime', 'dify-executor'),
      pythonCommand: process.env.FK521_LOCAL_PYTHON_CMD || 'python3',
      nodeCommand: process.env.FK521_LOCAL_NODE_CMD || 'node',
      updatedAt: new Date().toISOString(),
    },
    sandboxTools: {
      allowArchiveTools: true,
      allowWebFetch: true,
      allowProgrammaticToolBridge: false,
      allowHostFilesystemAccess: false,
      hostFilesystemWriteEnabled: false,
      allowDatabaseConnect: false,
      databaseWriteEnabled: false,
      allowProcessList: true,
      maxFetchBytes: 524288,
      fetchTimeoutMs: 12000,
      allowedDomains: '',
      allowedUrlPrefixes: '',
      hostFilesystemAllowedPaths: '',
      allowedDatabaseHosts: '',
      allowedSqliteRoots: '',
      updatedAt: new Date().toISOString(),
    },
    updatedAt: new Date().toISOString(),
  };
}

function readRawConfig() {
  try {
    const configPath = ensureStorageFile();
    const raw = fs.readFileSync(configPath, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : getDefaultConfig();
  } catch (_error) {
    return getDefaultConfig();
  }
}

function normalizeDifyConsoleConfig(input = {}) {
  const defaults = getDefaultConfig();
  const workspace = input.workspace && typeof input.workspace === 'object' ? input.workspace : {};
  const codeExecutor = input.codeExecutor && typeof input.codeExecutor === 'object' ? input.codeExecutor : {};
  const sandboxTools = input.sandboxTools && typeof input.sandboxTools === 'object' ? input.sandboxTools : {};

  return {
    workspace: {
      name: normalizeText(workspace.name, defaults.workspace.name),
      description: normalizeText(workspace.description, defaults.workspace.description),
    },
    workflows: normalizeList(input.workflows, 'workflow'),
    tools: normalizeList(input.tools, 'tool'),
    codeExecutor: {
      enabled: normalizeBool(codeExecutor.enabled, defaults.codeExecutor.enabled),
      defaultLanguage: ['python', 'javascript'].includes(String(codeExecutor.defaultLanguage || ''))
        ? String(codeExecutor.defaultLanguage)
        : defaults.codeExecutor.defaultLanguage,
      allowNetwork: normalizeBool(codeExecutor.allowNetwork, defaults.codeExecutor.allowNetwork),
      timeoutMs: toInt(codeExecutor.timeoutMs, defaults.codeExecutor.timeoutMs, 1000, 60000),
      maxOutputBytes: toInt(codeExecutor.maxOutputBytes, defaults.codeExecutor.maxOutputBytes, 2048, 1048576),
      workdir: normalizeText(codeExecutor.workdir, defaults.codeExecutor.workdir),
      pythonCommand: normalizeText(codeExecutor.pythonCommand, defaults.codeExecutor.pythonCommand),
      nodeCommand: normalizeText(codeExecutor.nodeCommand, defaults.codeExecutor.nodeCommand),
      updatedAt: new Date().toISOString(),
    },
    sandboxTools: {
      allowArchiveTools: normalizeBool(sandboxTools.allowArchiveTools, defaults.sandboxTools.allowArchiveTools),
      allowWebFetch: normalizeBool(sandboxTools.allowWebFetch, defaults.sandboxTools.allowWebFetch),
      allowProgrammaticToolBridge: normalizeBool(
        sandboxTools.allowProgrammaticToolBridge,
        defaults.sandboxTools.allowProgrammaticToolBridge,
      ),
      allowHostFilesystemAccess: normalizeBool(
        sandboxTools.allowHostFilesystemAccess,
        defaults.sandboxTools.allowHostFilesystemAccess,
      ),
      hostFilesystemWriteEnabled: normalizeBool(
        sandboxTools.hostFilesystemWriteEnabled,
        defaults.sandboxTools.hostFilesystemWriteEnabled,
      ),
      allowDatabaseConnect: normalizeBool(
        sandboxTools.allowDatabaseConnect,
        defaults.sandboxTools.allowDatabaseConnect,
      ),
      databaseWriteEnabled: normalizeBool(
        sandboxTools.databaseWriteEnabled,
        defaults.sandboxTools.databaseWriteEnabled,
      ),
      allowProcessList: normalizeBool(sandboxTools.allowProcessList, defaults.sandboxTools.allowProcessList),
      maxFetchBytes: toInt(sandboxTools.maxFetchBytes, defaults.sandboxTools.maxFetchBytes, 8192, 5 * 1024 * 1024),
      fetchTimeoutMs: toInt(sandboxTools.fetchTimeoutMs, defaults.sandboxTools.fetchTimeoutMs, 1000, 60000),
      allowedDomains: normalizeDelimitedText(sandboxTools.allowedDomains, defaults.sandboxTools.allowedDomains),
      allowedUrlPrefixes: normalizeDelimitedText(
        sandboxTools.allowedUrlPrefixes,
        defaults.sandboxTools.allowedUrlPrefixes,
      ),
      hostFilesystemAllowedPaths: normalizeDelimitedText(
        sandboxTools.hostFilesystemAllowedPaths,
        defaults.sandboxTools.hostFilesystemAllowedPaths,
      ),
      allowedDatabaseHosts: normalizeDelimitedText(
        sandboxTools.allowedDatabaseHosts,
        defaults.sandboxTools.allowedDatabaseHosts,
      ),
      allowedSqliteRoots: normalizeDelimitedText(
        sandboxTools.allowedSqliteRoots,
        defaults.sandboxTools.allowedSqliteRoots,
      ),
      updatedAt: new Date().toISOString(),
    },
    updatedAt: new Date().toISOString(),
  };
}

function readDifyConsoleConfig() {
  return normalizeDifyConsoleConfig(readRawConfig());
}

function writeDifyConsoleConfig(input = {}) {
  const normalized = normalizeDifyConsoleConfig(input);
  const configPath = ensureStorageFile();
  fs.writeFileSync(configPath, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
  return normalized;
}

function isLocalCodeExecutorEnabled() {
  const config = readDifyConsoleConfig();
  return config.codeExecutor?.enabled === true;
}

module.exports = {
  getDifyConsoleConfigPath,
  readDifyConsoleConfig,
  writeDifyConsoleConfig,
  normalizeDifyConsoleConfig,
  isLocalCodeExecutorEnabled,
};
