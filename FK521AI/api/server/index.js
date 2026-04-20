require('dotenv').config();
const fs = require('fs');
const path = require('path');
require('module-alias')({ base: path.resolve(__dirname, '..') });
const cors = require('cors');
const axios = require('axios');
const express = require('express');
const passport = require('passport');
const compression = require('compression');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const mongoSanitize = require('express-mongo-sanitize');
const { logger, runAsSystem } = require('@fk521ai/data-schemas');
const {
  isEnabled,
  apiNotFound,
  ErrorController,
  memoryDiagnostics,
  performStartupChecks,
  handleJsonParseError,
  GenerationJobManager,
  createStreamServices,
  initializeFileStorage,
  updateInterfacePermissions,
  preAuthTenantMiddleware,
} = require('@fk521ai/api');
const { connectDb, indexSync } = require('~/db');
const initializeOAuthReconnectManager = require('./services/initializeOAuthReconnectManager');
const initializeMCPs = require('./services/initializeMCPs');
const { getRoleByName, updateAccessPermissions, seedDatabase } = require('~/models');
const { capabilityContextMiddleware } = require('./middleware/roles/capabilities');
const createValidateImageRequest = require('./middleware/validateImageRequest');
const { jwtLogin, ldapLogin, passportLogin } = require('~/strategies');
const { checkMigrations } = require('./services/start/migration');
const { getAppConfig } = require('./services/Config');
const staticCache = require('./utils/staticCache');
const optionalJwtAuth = require('./middleware/optionalJwtAuth');
const noIndex = require('./middleware/noIndex');
const routes = require('./routes');
const { configMiddleware } = require('./middleware');
const { startAdminConfigWatchers } = require('./services/Config/hotReload');
const { verifySignedToken, streamSignedDownload } = require('./services/DownloadLinks');

const { PORT, HOST, DISABLE_COMPRESSION, TRUST_PROXY } = process.env ?? {};

// Allow PORT=0 to be used for automatic free port assignment
const port = isNaN(Number(PORT)) ? 3080 : Number(PORT);
const host = HOST || 'localhost';
const trusted_proxy = Number(TRUST_PROXY) || 1; /* trust first proxy by default */

const app = express();
const DEFAULT_ALLOWED_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];
const ALLOWED_CORS_ORIGINS = String(process.env.CORS_ALLOWED_ORIGINS || '')
  .split(',')
  .map((item) => item.trim())
  .filter(Boolean);

function buildCorsOriginValidator() {
  if (ALLOWED_CORS_ORIGINS.length === 0) {
    return false;
  }
  const allowSet = new Set(ALLOWED_CORS_ORIGINS);
  return (origin, callback) => {
    if (!origin || allowSet.has(origin)) {
      return callback(null, true);
    }
    return callback(new Error('CORS origin denied'));
  };
}

function secureHeadersMiddleware(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; img-src 'self' data: blob:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self' https: http:; frame-ancestors 'none'; base-uri 'self';",
  );
  if (req.secure || req.headers['x-forwarded-proto'] === 'https') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
}

function csrfProtectionMiddleware(req, res, next) {
  const method = String(req.method || '').toUpperCase();
  if (['GET', 'HEAD', 'OPTIONS'].includes(method)) {
    return next();
  }
  const csrfCookie = req.cookies?.csrf_token;
  const csrfHeader = req.headers['x-csrf-token'];
  if (!csrfCookie || !csrfHeader || csrfCookie !== csrfHeader) {
    return res.status(403).json({ message: 'CSRF token validation failed' });
  }
  return next();
}


if (!process.env.DOMAIN_SERVER) {
  if (process.env.DOMAIN_CLIENT) {
    process.env.DOMAIN_SERVER = process.env.DOMAIN_CLIENT;
  } else {
    process.env.DOMAIN_SERVER = `http://${host}:${port}`;
  }
}

const startServer = async () => {
  if (typeof Bun !== 'undefined') {
    axios.defaults.headers.common['Accept-Encoding'] = 'gzip';
  }
  await connectDb();

  logger.info('Connected to MongoDB');
  indexSync().catch((err) => {
    logger.error('[indexSync] Background sync failed:', err);
  });

  app.disable('x-powered-by');
  app.set('trust proxy', trusted_proxy);

  if (isEnabled(process.env.TENANT_ISOLATION_STRICT)) {
    logger.warn(
      '[Security] TENANT_ISOLATION_STRICT is active. Ensure your reverse proxy strips or sets ' +
        'the X-Tenant-Id header — untrusted clients must not be able to set it directly.',
    );
  }

  await runAsSystem(seedDatabase);
  const appConfig = await getAppConfig({ baseOnly: true });
  initializeFileStorage(appConfig);
  await runAsSystem(async () => {
    await performStartupChecks(appConfig);
    await updateInterfacePermissions({ appConfig, getRoleByName, updateAccessPermissions });
  });
  startAdminConfigWatchers();

  const indexPath = path.join(appConfig.paths.dist, 'index.html');
  let indexHTML = fs.readFileSync(indexPath, 'utf8');

  // In order to provide support to serving the application in a sub-directory
  // We need to update the base href if the DOMAIN_CLIENT is specified and not the root path
  if (process.env.DOMAIN_CLIENT) {
    const clientUrl = new URL(process.env.DOMAIN_CLIENT);
    const baseHref = clientUrl.pathname.endsWith('/')
      ? clientUrl.pathname
      : `${clientUrl.pathname}/`;
    if (baseHref !== '/') {
      logger.info(`Setting base href to ${baseHref}`);
      indexHTML = indexHTML.replace(/base href="\/"/, `base href="${baseHref}"`);
    }
  }

  app.get('/health', (_req, res) => res.status(200).send('OK'));

  /* Middleware */
  app.use(noIndex);
  app.use(express.json({ limit: '3mb' }));
  app.use(express.urlencoded({ extended: true, limit: '3mb' }));
  app.use(handleJsonParseError);

  /**
   * Express 5 Compatibility: Make req.query writable for mongoSanitize
   * In Express 5, req.query is read-only by default, but express-mongo-sanitize needs to modify it
   */
  app.use((req, _res, next) => {
    Object.defineProperty(req, 'query', {
      ...Object.getOwnPropertyDescriptor(req, 'query'),
      value: req.query,
      writable: true,
    });
    next();
  });

  app.use(mongoSanitize());
  app.use(cookieParser());
  app.use(secureHeadersMiddleware);
  app.use(
    cors({
      origin: buildCorsOriginValidator(),
      methods: DEFAULT_ALLOWED_METHODS,
      credentials: true,
      allowedHeaders: ['Content-Type', 'Authorization', 'X-CSRF-Token'],
      optionsSuccessStatus: 204,
      maxAge: 86400,
    }),
  );
  app.use((req, res, next) => {
    if (!req.cookies?.csrf_token) {
      const token = require('crypto').randomBytes(24).toString('hex');
      res.cookie('csrf_token', token, {
        httpOnly: false,
        sameSite: 'lax',
        secure: req.secure || req.headers['x-forwarded-proto'] === 'https',
      });
    }
    next();
  });
  app.use(
    '/api',
    rateLimit({
      windowMs: Number(process.env.API_RATE_LIMIT_WINDOW_MS || 60_000),
      max: Number(process.env.API_RATE_LIMIT_MAX || 120),
      standardHeaders: true,
      legacyHeaders: false,
      message: { message: 'Too many requests, please retry later.' },
    }),
  );
  app.use('/api', csrfProtectionMiddleware);

  if (!isEnabled(DISABLE_COMPRESSION)) {
    app.use(compression());
  } else {
    console.warn('Response compression has been disabled via DISABLE_COMPRESSION.');
  }

  app.use(staticCache(appConfig.paths.dist));
  app.use(staticCache(appConfig.paths.fonts));
  app.use(staticCache(appConfig.paths.assets));

  logger.info('Social login providers have been removed from this build.');

  /* OAUTH */
  app.use(passport.initialize());
  passport.use(jwtLogin());
  passport.use(passportLogin());

  /* LDAP Auth */
  if (process.env.LDAP_URL && process.env.LDAP_USER_SEARCH_BASE) {
    passport.use(ldapLogin);
  }

  /* Per-request capability cache — must be registered before any route that calls hasCapability */
  app.use(capabilityContextMiddleware);

  /* Pre-auth tenant context for unauthenticated routes that need tenant scoping.
   * The reverse proxy / auth gateway sets `X-Tenant-Id` header for multi-tenant deployments. */
  app.use('/oauth', preAuthTenantMiddleware, routes.oauth);
  /* API Endpoints */
  app.use('/api/auth', preAuthTenantMiddleware, routes.auth);
  app.use('/api/admin', routes.adminAuth);
  app.use('/api/admin/config', routes.adminConfig);
  app.use('/api/admin/grants', routes.adminGrants);
  app.use('/api/admin/groups', routes.adminGroups);
  app.use('/api/admin/roles', routes.adminRoles);
  app.use('/api/admin/users', routes.adminUsers);
  app.use('/api/admin/project-apis', routes.adminProjectApis);
  app.get('/api/downloads/dl', configMiddleware, async (req, res) => {
    try {
      const claims = verifySignedToken(req.query?.t);
      return await streamSignedDownload(req, res, claims);
    } catch (error) {
      const code = error?.code;
      const status =
        code === 'DOWNLOAD_TOKEN_MALFORMED' ? 400 :
        code === 'DOWNLOAD_TOKEN_INVALID' || code === 'DOWNLOAD_TOKEN_EXPIRED' ? 401 :
        code === 'FILE_NOT_FOUND' || code === 'CONVERSATION_NOT_FOUND' ? 404 :
        code === 'FILE_ACCESS_DENIED' || code === 'SANDBOX_DOWNLOAD_FORBIDDEN' ? 403 : 500;
      logger.error('[downloads] signed download failed', error);
      return res.status(status).json({
        error_code: code || 'DOWNLOAD_LINK_ERROR',
        message: error?.message || 'Download failed',
      });
    }
  });
  app.use('/api/admin/system-settings', routes.adminSystemSettings);
  app.use('/api/admin/dify-console', routes.adminDifyConsole);
  app.use('/api/actions', routes.actions);
  app.use('/api/keys', routes.keys);
  app.use('/api/api-keys', routes.apiKeys);
  app.use('/api/user', routes.user);
  app.use('/api/search', routes.search);
  app.use('/api/messages', routes.messages);
  app.use('/api/convos', routes.convos);
  app.use('/api/presets', routes.presets);
  app.use('/api/prompts', routes.prompts);
  app.use('/api/categories', routes.categories);
  app.use('/api/endpoints', routes.endpoints);
  app.use('/api/balance', routes.balance);
  app.use('/api/models', routes.models);
  app.use('/api/config', preAuthTenantMiddleware, optionalJwtAuth, routes.config);
  app.use('/api/assistants', routes.assistants);
  app.use('/api/files', await routes.files.initialize());
  app.use('/images/', createValidateImageRequest(appConfig.secureImageLinks), routes.staticRoute);
  app.use('/api/share', preAuthTenantMiddleware, routes.share);
  app.use('/api/roles', routes.roles);
  app.use('/api/agents', routes.agents);
  app.use('/api/banner', routes.banner);
  app.use('/api/memories', routes.memories);
  app.use('/api/permissions', routes.accessPermissions);

  app.use('/api/tags', routes.tags);

  /** 404 for unmatched API routes */
  app.use('/api', apiNotFound);

  /** SPA fallback - serve index.html for all unmatched routes */
  app.use((req, res) => {
    res.set({
      'Cache-Control': process.env.INDEX_CACHE_CONTROL || 'no-cache, no-store, must-revalidate',
      Pragma: process.env.INDEX_PRAGMA || 'no-cache',
      Expires: process.env.INDEX_EXPIRES || '0',
    });

    const lang = req.cookies.lang || req.headers['accept-language']?.split(',')[0] || 'en-US';
    const saneLang = lang.replace(/"/g, '&quot;');
    let updatedIndexHtml = indexHTML.replace(/lang="en-US"/g, `lang="${saneLang}"`);

    res.type('html');
    res.send(updatedIndexHtml);
  });

  /** Error handler (must be last - Express identifies error middleware by its 4-arg signature) */
  app.use(ErrorController);

  app.listen(port, host, async (err) => {
    if (err) {
      logger.error('Failed to start server:', err);
      process.exit(1);
    }

    if (host === '0.0.0.0') {
      logger.info(
        `Server listening on all interfaces at port ${port}. Use http://localhost:${port} to access it`,
      );
    } else {
      logger.info(`Server listening at http://${host == '0.0.0.0' ? 'localhost' : host}:${port}`);
    }

    await checkMigrations();

    // Configure stream services (auto-detects Redis from USE_REDIS env var)
    const streamServices = createStreamServices();
    GenerationJobManager.configure(streamServices);
    GenerationJobManager.initialize();

    const inspectFlags = process.execArgv.some((arg) => arg.startsWith('--inspect'));
    if (inspectFlags || isEnabled(process.env.MEM_DIAG)) {
      memoryDiagnostics.start();
    }
  });
};

startServer();

let messageCount = 0;
process.on('uncaughtException', (err) => {
  if (!err.message.includes('fetch failed')) {
    logger.error('There was an uncaught error:', err);
  }

  if (err.message && err.message?.toLowerCase()?.includes('abort')) {
    logger.warn('There was an uncatchable abort error.');
    return;
  }

  if (err.message.includes('GoogleGenerativeAI')) {
    logger.warn(
      '\n\n`GoogleGenerativeAI` errors cannot be caught due to an upstream issue, see: https://github.com/google-gemini/generative-ai-js/issues/303',
    );
    return;
  }

  if (err.message.includes('fetch failed')) {
    if (messageCount === 0) {
      logger.warn('Meilisearch error, search will be disabled');
      messageCount++;
    }

    return;
  }

  if (err.message.includes('OpenAIError') || err.message.includes('ChatCompletionMessage')) {
    logger.error(
      '\n\nAn Uncaught `OpenAIError` error may be due to your reverse-proxy setup or stream configuration, or a bug in the `openai` node package.',
    );
    return;
  }

  if (err.stack && err.stack.includes('@fk521ai/agents')) {
    logger.error(
      '\n\nAn error occurred in the agents system. The error has been logged and the app will continue running.',
      {
        message: err.message,
        stack: err.stack,
      },
    );
    return;
  }

  if (isEnabled(process.env.CONTINUE_ON_UNCAUGHT_EXCEPTION)) {
    logger.error('Unhandled error encountered. The app will continue running.', {
      name: err?.name,
      message: err?.message,
      stack: err?.stack,
    });
    return;
  }

  process.exit(1);
});

/** Export app for easier testing purposes */
module.exports = app;
