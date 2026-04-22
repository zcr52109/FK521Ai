const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { createMethods } = require('@fk521ai/data-schemas');
const { SystemRoles } = require('fk521ai-data-provider');
const { matchModelName, findMatchingPattern } = require('@fk521ai/api');
const getLogStores = require('~/cache/getLogStores');

const methods = createMethods(mongoose, {
  matchModelName,
  findMatchingPattern,
  getCache: getLogStores,
});

const ensureDefaultAdminAccount = async () => {
  const defaultEmail = (process.env.DEFAULT_ADMIN_EMAIL || 'admin@fk521ai.local').trim().toLowerCase();
  const defaultUsername = (process.env.DEFAULT_ADMIN_USERNAME || 'admin').trim();
  const defaultName = (process.env.DEFAULT_ADMIN_NAME || 'FK521AI 管理员').trim();
  const configuredPassword = String(process.env.DEFAULT_ADMIN_PASSWORD || '').trim();
  const defaultPassword = configuredPassword || crypto.randomBytes(18).toString('base64url');

  const existingAdmin = await methods.findUser({ email: defaultEmail }, '_id email role provider username name');
  if (existingAdmin) {
    if (existingAdmin.role !== SystemRoles.ADMIN || existingAdmin.provider !== 'local') {
      await methods.updateUser(existingAdmin._id, {
        role: SystemRoles.ADMIN,
        provider: 'local',
        emailVerified: true,
        username: existingAdmin.username || defaultUsername,
        name: existingAdmin.name || defaultName,
      });
    }
    return;
  }

  const salt = bcrypt.genSaltSync(10);
  await methods.createUser(
    {
      provider: 'local',
      email: defaultEmail,
      username: defaultUsername,
      name: defaultName,
      avatar: null,
      role: SystemRoles.ADMIN,
      emailVerified: true,
      password: bcrypt.hashSync(defaultPassword, salt),
    },
    undefined,
    true,
    false,
  );

  if (!configuredPassword) {
    console.warn(
      '[Security] DEFAULT_ADMIN_PASSWORD is not set. Generated a random bootstrap admin password for this startup.',
    );
  }
};

const seedDatabase = async () => {
  await methods.initializeRoles();
  await methods.seedDefaultRoles();
  await methods.ensureDefaultCategories();
  await methods.seedSystemGrants();
  await ensureDefaultAdminAccount();
};

module.exports = {
  ...methods,
  seedDatabase,
};
