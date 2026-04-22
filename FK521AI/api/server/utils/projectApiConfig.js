const fs = require('fs');
const path = require('path');
const { encrypt, decrypt, maskApiKey } = require('~/server/utils/encryption');
const { getStyleText } = require('~/server/utils/managedModelStyles');
const { getPlatformAssistantName } = require('~/server/services/Platform/identity');

const projectRoot = path.resolve(__dirname, '..', '..', '..');
const defaultConfigPath = path.resolve(projectRoot, 'runtime', 'admin', 'project-apis.json');
const megabyte = 1024 * 1024;

const providerPresets = {
  deepseek: { baseURL: 'https://api.deepseek.com/v1' },
  openai: { baseURL: 'https://api.openai.com/v1' },
  openrouter: { baseURL: 'https://openrouter.ai/api/v1' },
  groq: { baseURL: 'https://api.groq.com/openai/v1' },
  mistral: { baseURL: 'https://api.mistral.ai/v1' },
  aliyun: { baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
  qwen: { baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
  moonshot: { baseURL: 'https://api.moonshot.cn/v1' },
  kimi: { baseURL: 'https://api.moonshot.cn/v1' },
  zhipu: { baseURL: 'https://open.bigmodel.cn/api/paas/v4/' },
  glm: { baseURL: 'https://open.bigmodel.cn/api/paas/v4/' },
  siliconflow: { baseURL: 'https://api.siliconflow.cn/v1' },
  custom: { baseURL: '' },
};

let cachedMtimeMs = null;
let cachedValue = null;

function getProjectApiConfigPath() {
  return process.env.FK521_PROJECT_APIS_PATH || defaultConfigPath;
}

function ensureStorageDir() {
  const configPath = getProjectApiConfigPath();
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  if (!fs.existsSync(configPath)) {
    fs.writeFileSync(configPath, '[]\n', 'utf8');
  }
  return configPath;
}

function readProjectApis() {
  try {
    const configPath = ensureStorageDir();
    const stats = fs.statSync(configPath);
    if (cachedValue && cachedMtimeMs === stats.mtimeMs) {
      return cachedValue;
    }
    const raw = fs.readFileSync(configPath, 'utf8');
    const parsed = JSON.parse(raw);
    cachedValue = Array.isArray(parsed) ? normalizeProjectApis(parsed) : [];
    cachedMtimeMs = stats.mtimeMs;
    return cachedValue;
  } catch (_error) {
    cachedValue = [];
    cachedMtimeMs = null;
    return [];
  }
}

function writeProjectApis(items) {
  const configPath = ensureStorageDir();
  const itemsToWrite = Array.isArray(items) ? items : [];

  // Encrypt API keys before writing
  const encryptedItems = itemsToWrite.map(item => {
    if (!item || typeof item !== 'object') return item;
    const encryptedItem = { ...item };
    if (encryptedItem.apiKey && typeof encryptedItem.apiKey === 'string') {
      encryptedItem.apiKey = encrypt(encryptedItem.apiKey);
    }
    return encryptedItem;
  });

  const normalized = normalizeProjectApis(encryptedItems);
  fs.writeFileSync(configPath, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
  cachedValue = normalized;
  cachedMtimeMs = fs.statSync(configPath).mtimeMs;
  return normalized;
}

function slugify(value = '') {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

function uniqueId(base, used) {
  let candidate = base || `project-${Date.now()}`;
  let i = 2;
  while (used.has(candidate)) {
    candidate = `${base}-${i}`;
    i += 1;
  }
  used.add(candidate);
  return candidate;
}

function toInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeProvider(provider = 'custom') {
  const normalized = String(provider || 'custom').trim().toLowerCase();
  if (normalized === 'ali' || normalized === 'dashscope') {
    return 'aliyun';
  }
  if (normalized === 'moonshotai') {
    return 'moonshot';
  }
  if (normalized === 'bigmodel') {
    return 'zhipu';
  }
  return normalized || 'custom';
}

function getProviderPreset(provider = 'custom') {
  const normalized = normalizeProvider(provider);
  return providerPresets[normalized] || providerPresets.custom;
}

function resolveProviderBaseURL(provider = 'custom', baseURL = '') {
  const preset = getProviderPreset(provider);
  const trimmed = String(baseURL || '').trim();
  if (normalizeProvider(provider) === 'custom') {
    return trimmed;
  }
  return preset.baseURL || trimmed;
}

function normalizeAliasList(aliases = [], primaryNames = []) {
  const values = Array.isArray(aliases)
    ? aliases
    : String(aliases || '')
        .split(/[;,\n\r|、]/)
        .map((alias) => alias.trim())
        .filter(Boolean);

  const banned = new Set((primaryNames || []).map((name) => String(name || '').trim().toLowerCase()).filter(Boolean));
  const seen = new Set();
  const result = [];

  for (const alias of values) {
    const trimmed = String(alias || '').trim();
    const key = trimmed.toLowerCase();
    if (!trimmed || seen.has(key) || banned.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(trimmed);
  }

  return result;
}

function normalizeManagedModel(model = {}, context = {}) {
  const { endpointName = '', used = new Set(), fallbackName = '', provider = 'custom' } = context;
  const name = String(model.name || fallbackName || '').trim();
  const base = slugify(model.id || `${endpointName}-${name}` || name || 'model');
  const id = uniqueId(base, used);
  return {
    id,
    name,
    label: String(model.label || name || '').trim() || name || '未命名模型',
    version: String(model.version || model.modelVersion || '').trim(),
    aliases: normalizeAliasList(model.aliases, [name, model.label]),
    provider: normalizeProvider(model.provider || provider),
    enabled: model.enabled !== false,
    description: String(model.description || '').trim(),
    avatarURL: String(model.avatarURL || model.iconURL || '').trim(),
    styleFileIds: Array.isArray(model.styleFileIds)
      ? model.styleFileIds.map((id) => String(id).trim()).filter(Boolean)
      : [],
    showIconInMenu: model.showIconInMenu !== false,
    showIconInHeader: model.showIconInHeader !== false,
    executeCode: model.executeCode === true,
    default: model.default === true,
    updatedAt: new Date().toISOString(),
  };
}

function deriveLegacyModelConfigs(item = {}, endpointName = '') {
  const models = Array.isArray(item.models)
    ? item.models.map((model) => String(model).trim()).filter(Boolean)
    : String(item.models || '')
        .split(',')
        .map((model) => model.trim())
        .filter(Boolean);

  const uniqueModels = Array.from(
    new Set([...(item.defaultModel ? [String(item.defaultModel).trim()] : []), ...models]),
  );
  if (uniqueModels.length === 0) {
    return [];
  }

  const used = new Set();
  return uniqueModels.map((modelName, index) =>
    normalizeManagedModel(
      {
        name: modelName,
        label: modelName,
        default: String(item.defaultModel || '').trim() === modelName || index === 0,
        avatarURL: item.iconURL,
        aliases: item.aliases,
        provider: item.provider,
      },
      { endpointName, used, fallbackName: modelName, provider: item.provider },
    ),
  );
}

function mergeModelConfigs(modelConfigs = []) {
  const byKey = new Map();
  for (const model of modelConfigs) {
    if (!model?.name) {
      continue;
    }
    const key = [normalizeProvider(model.provider || 'custom'), String(model.name).trim().toLowerCase(), String(model.version || '').trim().toLowerCase()].join('::');
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { ...model, aliases: normalizeAliasList(model.aliases, [model.name, model.label]) });
      continue;
    }

    byKey.set(key, {
      ...existing,
      ...model,
      id: existing.id,
      aliases: normalizeAliasList([...(existing.aliases || []), ...(model.aliases || [])], [model.name, model.label]),
      styleFileIds: Array.from(new Set([...(existing.styleFileIds || []), ...(model.styleFileIds || [])])),
      default: existing.default === true || model.default === true,
      enabled: existing.enabled !== false || model.enabled !== false,
      executeCode: existing.executeCode === true || model.executeCode === true,
    });
  }
  return [...byKey.values()];
}

function normalizeProjectApi(item = {}, used = new Set()) {
  const name = String(item.name || item.projectName || '').trim();
  const provider = normalizeProvider(item.provider || 'custom');
  const idBase = slugify(item.id || item.key || name || provider || 'project');
  const id = uniqueId(idBase, used);

  const inputModelConfigs = Array.isArray(item.modelConfigs) ? item.modelConfigs : [];
  const rawModelConfigs = inputModelConfigs.length > 0 ? inputModelConfigs : deriveLegacyModelConfigs(item, name || id);
  const modelUsed = new Set();
  const modelConfigs = mergeModelConfigs(
    rawModelConfigs
      .filter((model) => model && typeof model === 'object')
      .map((model, index) =>
        normalizeManagedModel(model, {
          endpointName: name || id,
          used: modelUsed,
          fallbackName: Array.isArray(item.models) ? item.models[index] : '',
          provider,
        }),
      )
      .filter((model) => model.name),
  );

  if (modelConfigs.length > 0 && !modelConfigs.some((model) => model.default === true)) {
    modelConfigs[0].default = true;
  }

  const enabledModels = modelConfigs.filter((model) => model.enabled !== false);
  const models = Array.from(new Set(enabledModels.map((model) => model.name).filter(Boolean)));
  const defaultModelConfig =
    enabledModels.find((model) => model.default === true) ?? enabledModels[0] ?? modelConfigs[0] ?? null;
  const defaultModel = defaultModelConfig?.name || String(item.defaultModel || '').trim() || models[0] || '';

  // Decrypt API key if present
  const rawApiKey = String(item.apiKey || '').trim();
  const apiKey = rawApiKey ? decrypt(rawApiKey) : '';

  return {
    id,
    name: name || provider || 'Project',
    provider,
    enabled: item.enabled !== false,
    description: String(item.description || '').trim(),
    baseURL: resolveProviderBaseURL(provider, item.baseURL),
    apiKey,
    models,
    modelConfigs,
    defaultModel,
    modelDisplayLabel:
      String(item.modelDisplayLabel || '').trim() ||
      getPlatformAssistantName() ||
      name ||
      'FK521AI',
    iconURL: String(item.iconURL || '').trim(),
    useForRagEmbeddings: item.useForRagEmbeddings === true,
    embeddingModel: String(item.embeddingModel || '').trim(),
    allowFileUpload: item.allowFileUpload !== false,
    fileLimit: Math.max(1, Math.min(50, toInt(item.fileLimit, 10))),
    fileSizeLimit: Math.max(1, Math.min(200, toInt(item.fileSizeLimit, 20))),
    totalSizeLimit: Math.max(1, Math.min(1024, toInt(item.totalSizeLimit, 100))),
    updatedAt: new Date().toISOString(),
  };
}

function normalizeProjectApis(items = []) {
  const used = new Set();
  const normalized = items
    .filter((item) => item && typeof item === 'object')
    .map((item) => normalizeProjectApi(item, used));

  return normalized.map((item) => {
    const modelConfigs = Array.isArray(item.modelConfigs) ? item.modelConfigs : [];
    const itemEnabled = item.enabled === true;

    let nextModelConfigs = modelConfigs.map((model) => ({
      ...model,
      enabled: itemEnabled ? model.enabled !== false : false,
      aliases: normalizeAliasList(model.aliases, [model.name, model.label]),
      provider: normalizeProvider(model.provider || item.provider),
      updatedAt: new Date().toISOString(),
    }));

    const enabledModels = nextModelConfigs.filter((model) => model.enabled === true);
    const preferredModel =
      enabledModels.find((model) => model.default === true) ??
      enabledModels[0] ??
      nextModelConfigs.find((model) => model.default === true) ??
      nextModelConfigs[0] ??
      null;

    nextModelConfigs = nextModelConfigs.map((model) => ({
      ...model,
      default: model.id === preferredModel?.id,
      updatedAt: new Date().toISOString(),
    }));

    const activeModels = nextModelConfigs.filter((model) => model.enabled === true);
    const modelNames = Array.from(new Set(activeModels.map((model) => model.name).filter(Boolean)));
    const resolvedEnabled = itemEnabled && modelNames.length > 0;

    return {
      ...item,
      provider: normalizeProvider(item.provider),
      enabled: resolvedEnabled,
      modelConfigs: nextModelConfigs,
      models: resolvedEnabled ? modelNames : [],
      defaultModel: preferredModel?.name || String(item.defaultModel || '').trim() || modelNames[0] || '',
      baseURL: resolveProviderBaseURL(item.provider, item.baseURL),
      updatedAt: new Date().toISOString(),
    };
  });
}

function getConfiguredIcon(iconURL) {
  return iconURL ? String(iconURL).trim() || undefined : undefined;
}

function getUserFacingManagedModelLabel(item = {}, model = {}) {
  return (
    String(item.modelDisplayLabel || '').trim() ||
    getPlatformAssistantName() ||
    String(item.name || '').trim() ||
    String(model.label || '').trim() ||
    String(model.name || '').trim() ||
    'FK521AI'
  );
}

function getManagedModelVersion(item = {}, model = null) {
  const modelConfigs = Array.isArray(item.modelConfigs) ? item.modelConfigs : deriveLegacyModelConfigs(item, item.name);
  const preferredModel = model || modelConfigs.find((entry) => entry.default === true) || modelConfigs[0] || null;
  return String(preferredModel?.version || preferredModel?.modelVersion || item.modelVersion || '').trim();
}

function toCustomEndpoint(item) {
  if (!item?.enabled || !item.baseURL || !item.apiKey) {
    return null;
  }

  const defaultModels = item.models?.length ? item.models : [item.defaultModel].filter(Boolean);
  if (!defaultModels.length) {
    return null;
  }

  return {
    name: item.name,
    apiKey: item.apiKey, // API key is already decrypted for runtime use
    baseURL: item.baseURL,
    iconURL: getConfiguredIcon(item.iconURL),
    models: {
      default: defaultModels,
      fetch: false,
    },
    titleConvo: true,
    titleModel: item.defaultModel || defaultModels[0],
    modelDisplayLabel: getUserFacingManagedModelLabel(item),
    modelVersion: getManagedModelVersion(item),
  };
}

/**
 * Returns a safe version of the endpoint config without exposing the full API key
 * Use this for admin/management interfaces
 */
function toSafeEndpointConfig(item) {
  if (!item?.enabled || !item.baseURL || !item.apiKey) {
    return null;
  }

  const defaultModels = item.models?.length ? item.models : [item.defaultModel].filter(Boolean);
  if (!defaultModels.length) {
    return null;
  }

  const maskedKey = maskApiKey(item.apiKey);

  return {
    name: item.name,
    apiKey: maskedKey, // Return masked version
    baseURL: item.baseURL,
    iconURL: getConfiguredIcon(item.iconURL),
    models: {
      default: defaultModels,
      fetch: false,
    },
    titleConvo: true,
    titleModel: item.defaultModel || defaultModels[0],
    modelDisplayLabel: getUserFacingManagedModelLabel(item),
    modelVersion: getManagedModelVersion(item),
  };
}

function buildPromptPrefix(item, model) {
  const styleText = getStyleText(model.styleFileIds);
  if (!styleText) {
    return undefined;
  }
  return [
    `以下是管理员为当前模型「${getUserFacingManagedModelLabel(item, model)}」配置的强制执行规范。`,
    '你必须优先遵守这些规范；若与普通表达习惯冲突，以这些规范为准。',
    '',
    styleText,
  ].join('\n');
}

function buildManagedModelSpec(item, model, index) {
  if (!item?.enabled || !model?.enabled || !model.name) {
    return null;
  }

  return {
    name: `${slugify(item.name)}__${slugify(model.name) || index + 1}`,
    label: model.label || model.name,
    description: model.description || item.description || `${item.name} / ${model.name}`,
    version: model.version || '',
    aliases: normalizeAliasList(model.aliases, [model.name, model.label]),
    default: model.default === true,
    group: item.name,
    groupIcon: getConfiguredIcon(item.iconURL),
    iconURL: model.avatarURL || getConfiguredIcon(item.iconURL),
    showIconInMenu: model.showIconInMenu !== false,
    showIconInHeader: model.showIconInHeader !== false,
    executeCode: model.executeCode === true,
    preset: {
      endpoint: item.name,
      model: model.name,
      modelLabel: getUserFacingManagedModelLabel(item, model),
      modelVersion: model.version || '',
      modelAliases: normalizeAliasList(model.aliases, [model.name, model.label]),
      iconURL: model.avatarURL || getConfiguredIcon(item.iconURL),
      promptPrefix: buildPromptPrefix(item, model),
    },
  };
}

function loadManagedCustomEndpoints() {
  return readProjectApis().map(toCustomEndpoint).filter(Boolean);
}

function loadManagedModelSpecs() {
  const specs = [];
  for (const item of readProjectApis()) {
    const models = Array.isArray(item.modelConfigs) ? item.modelConfigs : deriveLegacyModelConfigs(item, item.name);
    models.forEach((model, index) => {
      const spec = buildManagedModelSpec(item, model, index);
      if (spec) {
        specs.push(spec);
      }
    });
  }
  if (specs.length > 0 && !specs.some((spec) => spec.default === true)) {
    specs[0].default = true;
  }
  return specs;
}

function loadManagedFileConfig() {
  const endpoints = {};
  for (const item of readProjectApis()) {
    if (!item?.name) {
      continue;
    }
    endpoints[item.name] = item.allowFileUpload === false
      ? { disabled: true }
      : {
          disabled: false,
          fileLimit: Math.max(1, toInt(item.fileLimit, 10)),
          fileSizeLimit: Math.max(1, toInt(item.fileSizeLimit, 20)) * megabyte,
          totalSizeLimit: Math.max(1, toInt(item.totalSizeLimit, 100)) * megabyte,
        };
  }
  return { endpoints };
}

function isMaskedApiKeyValue(value) {
  const key = String(value || '').trim();
  return key.length >= 8 && key.includes('*');
}

function sanitizeProjectApiForAdmin(item = {}) {
  const apiKey = String(item.apiKey || '').trim();
  if (!apiKey) {
    return {
      ...item,
      hasApiKey: false,
      apiKey: '',
    };
  }
  return {
    ...item,
    hasApiKey: true,
    apiKey: maskApiKey(apiKey),
  };
}

function sanitizeProjectApisForAdmin(items = []) {
  return (Array.isArray(items) ? items : []).map(sanitizeProjectApiForAdmin);
}

function findProjectApiByName(endpointName = '') {
  const normalizedName = String(endpointName || '').trim().toLowerCase();
  if (!normalizedName) {
    return null;
  }

  return (
    readProjectApis().find(
      (item) => item?.enabled === true && String(item.name || '').trim().toLowerCase() === normalizedName,
    ) ?? null
  );
}

function findManagedModelConfig(item = {}, modelName = '') {
  const normalizedModel = String(modelName || '').trim().toLowerCase();
  const modelConfigs = Array.isArray(item.modelConfigs) ? item.modelConfigs : [];
  const enabledModels = modelConfigs.filter((model) => model?.enabled !== false && model?.name);

  if (!normalizedModel) {
    return enabledModels.find((model) => model.default === true) ?? enabledModels[0] ?? null;
  }

  return (
    enabledModels.find((model) => String(model.name || '').trim().toLowerCase() === normalizedModel) ??
    enabledModels.find((model) =>
      (Array.isArray(model.aliases) ? model.aliases : []).some(
        (alias) => String(alias || '').trim().toLowerCase() === normalizedModel,
      ),
    ) ??
    null
  );
}

function loadRagEmbeddingConfig() {
  const item = readProjectApis().find(
    (entry) =>
      entry?.enabled === true &&
      entry?.useForRagEmbeddings === true &&
      entry?.baseURL &&
      entry?.apiKey &&
      entry?.embeddingModel,
  );

  if (!item) {
    return null;
  }

  return {
    endpointName: item.name,
    provider: item.provider,
    apiKey: item.apiKey,
    baseURL: item.baseURL,
    embeddingModel: item.embeddingModel,
  };
}

module.exports = {
  getProjectApiConfigPath,
  readProjectApis,
  writeProjectApis,
  normalizeProjectApis,
  loadManagedCustomEndpoints,
  loadManagedModelSpecs,
  loadManagedFileConfig,
  loadRagEmbeddingConfig,
  findProjectApiByName,
  findManagedModelConfig,
  normalizeProvider,
  resolveProviderBaseURL,
  normalizeAliasList,
  isMaskedApiKeyValue,
  sanitizeProjectApiForAdmin,
  sanitizeProjectApisForAdmin,
  toSafeEndpointConfig, // For admin interfaces - returns masked API key
};
