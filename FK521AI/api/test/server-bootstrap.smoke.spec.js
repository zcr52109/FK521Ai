describe('server bootstrap smoke', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  test('exports startServer and passes runtime contract validation path', async () => {
    const appMock = {
      disable: jest.fn(),
      set: jest.fn(),
      use: jest.fn(),
      get: jest.fn(),
      listen: jest.fn((_port, _host, cb) => {
        if (typeof cb === 'function') {
          cb();
        }
      }),
    };

    jest.doMock('dotenv', () => ({ config: jest.fn() }), { virtual: true });
    jest.doMock('module-alias', () => jest.fn(), { virtual: true });
    jest.doMock('express', () => {
      const fn = () => appMock;
      fn.json = () => (_req, _res, next) => next();
      fn.urlencoded = () => (_req, _res, next) => next();
      return fn;
    }, { virtual: true });
    jest.doMock('cors', () => () => (_req, _res, next) => next(), { virtual: true });
    jest.doMock('axios', () => ({ defaults: { headers: { common: {} } } }), { virtual: true });
    jest.doMock('passport', () => ({ initialize: () => (_req, _res, next) => next(), use: jest.fn() }), { virtual: true });
    jest.doMock('compression', () => () => (_req, _res, next) => next(), { virtual: true });
    jest.doMock('cookie-parser', () => () => (_req, _res, next) => next(), { virtual: true });
    jest.doMock('express-mongo-sanitize', () => () => (_req, _res, next) => next(), { virtual: true });

    jest.doMock('@fk521ai/data-schemas', () => ({
      logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
      runAsSystem: async (fn) => fn(),
    }), { virtual: true });
    jest.doMock('@fk521ai/api', () => ({
      isEnabled: () => false,
      apiNotFound: (_req, _res, next) => next(),
      ErrorController: (_err, _req, _res, _next) => {},
      memoryDiagnostics: { start: jest.fn() },
      performStartupChecks: async () => {},
      handleJsonParseError: (_err, _req, _res, next) => next(),
      GenerationJobManager: { configure: jest.fn(), initialize: jest.fn() },
      createStreamServices: () => ({}),
      initializeFileStorage: jest.fn(),
      updateInterfacePermissions: async () => {},
      preAuthTenantMiddleware: (_req, _res, next) => next(),
    }), { virtual: true });
    jest.doMock('fk521ai-data-provider', () => ({
      FileSources: { local: 'local', firebase: 'firebase', s3: 's3', azure_blob: 'azure_blob' },
    }), { virtual: true });

    jest.doMock('~/db', () => ({
      connectDb: async () => {},
      indexSync: async () => {},
    }), { virtual: true });
    jest.doMock('~/models', () => ({
      getRoleByName: jest.fn(),
      updateAccessPermissions: jest.fn(),
      seedDatabase: async () => {},
    }), { virtual: true });
    jest.doMock('~/strategies', () => ({
      jwtLogin: () => ({}),
      ldapLogin: {},
      passportLogin: () => ({}),
    }), { virtual: true });
    jest.doMock('~/server/services/Config', () => ({ getAppConfig: async () => ({
      paths: { dist: __dirname, fonts: __dirname, assets: __dirname },
      secureImageLinks: false,
    }) }), { virtual: true });
    jest.doMock('fs', () => ({ readFileSync: () => '<html lang=\"en-US\"></html>' }), { virtual: true });
    jest.doMock('~/server/routes', () => ({
      oauth: (_req, _res, next) => next(),
      auth: (_req, _res, next) => next(),
      adminAuth: (_req, _res, next) => next(),
      adminConfig: (_req, _res, next) => next(),
      adminGrants: (_req, _res, next) => next(),
      adminGroups: (_req, _res, next) => next(),
      adminRoles: (_req, _res, next) => next(),
      adminUsers: (_req, _res, next) => next(),
      adminProjectApis: (_req, _res, next) => next(),
      adminSystemSettings: (_req, _res, next) => next(),
      adminDifyConsole: (_req, _res, next) => next(),
      actions: (_req, _res, next) => next(),
      keys: (_req, _res, next) => next(),
      apiKeys: (_req, _res, next) => next(),
      user: (_req, _res, next) => next(),
      search: (_req, _res, next) => next(),
      messages: (_req, _res, next) => next(),
      convos: (_req, _res, next) => next(),
      presets: (_req, _res, next) => next(),
      prompts: (_req, _res, next) => next(),
      categories: (_req, _res, next) => next(),
      endpoints: (_req, _res, next) => next(),
      balance: (_req, _res, next) => next(),
      models: (_req, _res, next) => next(),
      config: (_req, _res, next) => next(),
      assistants: (_req, _res, next) => next(),
      files: { initialize: async () => (_req, _res, next) => next() },
      staticRoute: (_req, _res, next) => next(),
      share: (_req, _res, next) => next(),
      roles: (_req, _res, next) => next(),
      agents: (_req, _res, next) => next(),
      banner: (_req, _res, next) => next(),
      memories: (_req, _res, next) => next(),
      accessPermissions: (_req, _res, next) => next(),
      tags: (_req, _res, next) => next(),
    }), { virtual: true });
    jest.doMock('~/server/middleware', () => ({ configMiddleware: (_req, _res, next) => next() }), { virtual: true });
    jest.doMock('~/server/middleware/roles/capabilities', () => ({ capabilityContextMiddleware: (_req, _res, next) => next() }), { virtual: true });
    jest.doMock('~/server/middleware/validateImageRequest', () => () => (_req, _res, next) => next(), { virtual: true });
    jest.doMock('~/server/middleware/optionalJwtAuth', () => (_req, _res, next) => next(), { virtual: true });
    jest.doMock('~/server/middleware/noIndex', () => (_req, _res, next) => next(), { virtual: true });
    jest.doMock('~/server/services/start/migration', () => ({ checkMigrations: async () => {} }), { virtual: true });
    jest.doMock('~/server/services/Config/hotReload', () => ({ startAdminConfigWatchers: jest.fn() }), { virtual: true });
    jest.doMock('~/server/services/DownloadLinks', () => ({
      verifySignedToken: jest.fn(() => ({})),
      streamSignedDownload: jest.fn(async () => {}),
      assertDownloadSecretConfigured: jest.fn(),
    }), { virtual: true });
    jest.doMock('~/server/services/Sandbox/runtimeContract', () => ({ assertSandboxContractSecretConfigured: jest.fn() }), {
      virtual: true,
    });
    jest.doMock('~/server/services/initializeOAuthReconnectManager', () => jest.fn(), { virtual: true });
    jest.doMock('~/server/services/initializeMCPs', () => jest.fn(), { virtual: true });
    jest.doMock('~/server/utils/staticCache', () => () => (_req, _res, next) => next(), { virtual: true });

    const server = require('~/server/index');
    expect(typeof server.startServer).toBe('function');
  });
});
