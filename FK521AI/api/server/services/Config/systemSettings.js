const { SystemSetting } = require('~/models');

const SETTINGS_KEY = 'runtime.system-settings';
const DEFAULT_SETTINGS = Object.freeze({
  featureToggles: {
    rateLimitEnabled: false,
    allowAllUploadTypes: true,
    csrfStrictMode: true,
  },
  limits: {
    uploadMaxFileSize: 0,
    jsonBodyLimit: '50mb',
    formBodyLimit: '50mb',
    workspaceMaxFileBytes: 0,
    workspaceMaxTotalWriteBytes: 0,
    archiveMaxEntries: 0,
    archiveMaxTotalBytes: 0,
  },
});

function deepMerge(base, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return base;
  }
  const output = { ...base };
  for (const [key, value] of Object.entries(input)) {
    if (value && typeof value === 'object' && !Array.isArray(value) && base[key] && typeof base[key] === 'object') {
      output[key] = deepMerge(base[key], value);
    } else {
      output[key] = value;
    }
  }
  return output;
}

function normalizeSettings(value) {
  return deepMerge(JSON.parse(JSON.stringify(DEFAULT_SETTINGS)), value || {});
}

async function ensureDocument() {
  const existing = await SystemSetting.findOne({ key: SETTINGS_KEY });
  if (existing) {
    return existing;
  }
  return await SystemSetting.create({
    key: SETTINGS_KEY,
    value: normalizeSettings({}),
    version: 1,
  });
}

async function getSystemSettings() {
  const doc = await ensureDocument();
  return {
    version: Number(doc.version || 1),
    settings: normalizeSettings(doc.value),
    defaults: DEFAULT_SETTINGS,
  };
}

async function updateSystemSettings(partial = {}) {
  const current = await ensureDocument();
  const merged = normalizeSettings(deepMerge(current.value, partial));
  const updated = await SystemSetting.findOneAndUpdate(
    { key: SETTINGS_KEY },
    {
      $set: { value: merged },
      $inc: { version: 1 },
    },
    { new: true },
  ).lean();
  return {
    version: Number(updated?.version || 1),
    settings: normalizeSettings(updated?.value),
    defaults: DEFAULT_SETTINGS,
  };
}

module.exports = {
  getSystemSettings,
  updateSystemSettings,
  DEFAULT_SETTINGS,
};
