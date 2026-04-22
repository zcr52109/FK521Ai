const { validateMulterProviderContract } = require('~/server/services/start/runtimeContracts');
const provider = require('fk521ai-data-provider');

let multerFactory = null;
try {
  // eslint-disable-next-line global-require
  multerFactory = require('multer');
} catch (_error) {
  multerFactory = null;
}

function createMulterInstance(appConfig = {}) {
  validateMulterProviderContract(provider);
  if (typeof multerFactory !== 'function') {
    const error = new Error('multer is not available in runtime');
    error.code = 'MULTER_UNAVAILABLE';
    throw error;
  }

  const mergedConfig = provider.mergeFileConfig(appConfig?.fileConfig || provider.fileConfig || {});
  const limits = mergedConfig?.limits && typeof mergedConfig.limits === 'object'
    ? mergedConfig.limits
    : { fileSize: 50 * 1024 * 1024 };

  return multerFactory({
    storage: multerFactory.memoryStorage(),
    limits,
  });
}

module.exports = {
  createMulterInstance,
};
