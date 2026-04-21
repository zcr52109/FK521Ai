const { ModelRegistry } = require('~/models');

async function listModels() {
  const items = await ModelRegistry.find({}).sort({ updatedAt: -1 }).lean();
  const version = items.reduce((acc, item) => acc + Number(new Date(item.updatedAt || item.createdAt || 0).getTime() || 0), 0);
  return { version, items };
}

async function saveModel(input = {}) {
  const modelId = String(input.id || input.modelId || input.name || '').trim() || `model-${Date.now()}`;
  const payload = {
    modelId,
    name: String(input.name || modelId),
    provider: String(input.provider || 'custom'),
    endpoint: String(input.endpoint || ''),
    apiKey: String(input.apiKey || ''),
    enabled: input.enabled !== false,
  };
  const updated = await ModelRegistry.findOneAndUpdate(
    { modelId },
    { $set: payload },
    {
      upsert: true,
      new: true,
      setDefaultsOnInsert: true,
    },
  ).lean();
  const listed = await listModels();
  return {
    version: listed.version,
    model: {
      id: updated.modelId,
      name: updated.name,
      provider: updated.provider,
      endpoint: updated.endpoint,
      apiKey: updated.apiKey,
      enabled: updated.enabled,
      createdAt: updated.createdAt,
      updatedAt: updated.updatedAt,
    },
    items: listed.items.map((item) => ({
      id: item.modelId,
      name: item.name,
      provider: item.provider,
      endpoint: item.endpoint,
      apiKey: item.apiKey,
      enabled: item.enabled,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    })),
  };
}

module.exports = {
  listModels,
  saveModel,
};
