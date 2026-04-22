function assertFunction(value, label) {
  if (typeof value !== 'function') {
    throw new TypeError(`[runtime contract] ${label} must be a function`);
  }
}

function assertObject(value, label) {
  if (!value || typeof value !== 'object') {
    throw new TypeError(`[runtime contract] ${label} must be an object`);
  }
}

function validateServerRuntimeContracts({
  apiExports = {},
  dataSchemasExports = {},
} = {}) {
  assertObject(apiExports, '@fk521ai/api exports');
  assertObject(dataSchemasExports, '@fk521ai/data-schemas exports');

  assertFunction(apiExports.isEnabled, '@fk521ai/api.isEnabled');
  assertFunction(apiExports.performStartupChecks, '@fk521ai/api.performStartupChecks');
  assertFunction(apiExports.createStreamServices, '@fk521ai/api.createStreamServices');
  assertFunction(apiExports.initializeFileStorage, '@fk521ai/api.initializeFileStorage');
  assertFunction(apiExports.preAuthTenantMiddleware, '@fk521ai/api.preAuthTenantMiddleware');

  assertObject(dataSchemasExports.logger, '@fk521ai/data-schemas.logger');
  assertFunction(dataSchemasExports.runAsSystem, '@fk521ai/data-schemas.runAsSystem');
}

function validateMulterProviderContract(providerExports = {}) {
  assertObject(providerExports, 'fk521ai-data-provider exports');
  assertFunction(providerExports.mergeFileConfig, 'fk521ai-data-provider.mergeFileConfig');
  assertFunction(providerExports.inferMimeType, 'fk521ai-data-provider.inferMimeType');
  assertFunction(providerExports.getEndpointFileConfig, 'fk521ai-data-provider.getEndpointFileConfig');
  if (!(providerExports.archiveExtensionRegex instanceof RegExp)) {
    throw new TypeError('[runtime contract] fk521ai-data-provider.archiveExtensionRegex must be RegExp');
  }
  assertObject(providerExports.fileConfig, 'fk521ai-data-provider.fileConfig');
}

module.exports = {
  validateServerRuntimeContracts,
  validateMulterProviderContract,
};
