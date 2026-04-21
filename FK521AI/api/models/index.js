const mongoose = require('mongoose');

const SystemSettingSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, index: true },
    value: { type: mongoose.Schema.Types.Mixed, default: {} },
    version: { type: Number, default: 1 },
  },
  { timestamps: true, collection: 'system_settings' },
);

const ModelRegistrySchema = new mongoose.Schema(
  {
    modelId: { type: String, required: true, unique: true, index: true },
    name: { type: String, required: true },
    provider: { type: String, default: 'custom' },
    endpoint: { type: String, default: '' },
    apiKey: { type: String, default: '' },
    enabled: { type: Boolean, default: true },
  },
  { timestamps: true, collection: 'model_registry' },
);

const RoleSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, unique: true },
    permissions: { type: [String], default: [] },
  },
  { timestamps: true, collection: 'roles' },
);

const SystemSetting = mongoose.models.SystemSetting || mongoose.model('SystemSetting', SystemSettingSchema);
const ModelRegistry = mongoose.models.ModelRegistry || mongoose.model('ModelRegistry', ModelRegistrySchema);
const Role = mongoose.models.Role || mongoose.model('Role', RoleSchema);

async function getRoleByName(name = 'admin') {
  return await Role.findOne({ name }).lean();
}

async function updateAccessPermissions() {
  return true;
}

async function seedDatabase() {
  await Role.updateOne(
    { name: 'admin' },
    { $setOnInsert: { name: 'admin', permissions: ['*'] } },
    { upsert: true },
  );
  return true;
}

module.exports = {
  SystemSetting,
  ModelRegistry,
  Role,
  getRoleByName,
  updateAccessPermissions,
  seedDatabase,
};
