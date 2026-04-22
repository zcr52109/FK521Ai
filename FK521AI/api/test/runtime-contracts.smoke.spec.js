const {
  validateServerRuntimeContracts,
  validateMulterProviderContract,
} = require('~/server/services/start/runtimeContracts');

describe('runtime contract smoke', () => {
  test('validates server package export contract', () => {
    expect(() =>
      validateServerRuntimeContracts({
        apiExports: {
          isEnabled: () => true,
          performStartupChecks: async () => {},
          createStreamServices: () => ({}),
          initializeFileStorage: () => {},
          preAuthTenantMiddleware: (_req, _res, next) => next(),
        },
        dataSchemasExports: {
          logger: { info: () => {} },
          runAsSystem: async (fn) => fn(),
        },
      }),
    ).not.toThrow();
  });

  test('fails closed on broken server export contract', () => {
    expect(() =>
      validateServerRuntimeContracts({
        apiExports: {},
        dataSchemasExports: { logger: {}, runAsSystem: async () => {} },
      }),
    ).toThrow(/@fk521ai\/api\.isEnabled/);
  });

  test('validates multer provider export contract', () => {
    expect(() =>
      validateMulterProviderContract({
        mergeFileConfig: () => ({}),
        inferMimeType: () => 'text/plain',
        getEndpointFileConfig: () => ({}),
        archiveExtensionRegex: /\.(zip|tar)$/i,
        fileConfig: {},
      }),
    ).not.toThrow();
  });
});
