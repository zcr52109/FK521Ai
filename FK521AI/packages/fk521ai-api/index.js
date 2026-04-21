function isEnabled(value) {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return value !== 0;
  }
  if (typeof value === 'string') {
    return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
  }
  return false;
}

function apiNotFound(_req, res) {
  res.status(404).json({ message: 'API endpoint not found' });
}

function ErrorController(err, _req, res, _next) {
  res.status(500).json({ message: err?.message || 'Internal server error' });
}

const memoryDiagnostics = {
  start() {
    return undefined;
  },
};

async function performStartupChecks() {
  return true;
}

function handleJsonParseError(err, _req, res, next) {
  if (err instanceof SyntaxError && 'body' in err) {
    return res.status(400).json({ message: 'Invalid JSON payload' });
  }
  return next(err);
}

const GenerationJobManager = {
  configure() {
    return undefined;
  },
  initialize() {
    return undefined;
  },
};

function createStreamServices() {
  return {};
}

function initializeFileStorage() {
  return undefined;
}

async function updateInterfacePermissions() {
  return true;
}

function preAuthTenantMiddleware(_req, _res, next) {
  next();
}

function sanitizeFilename(input = 'file') {
  return String(input)
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\\/:"*?<>|]+/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180);
}

function getDisplayFilename(originalName = '', fallback = 'file') {
  const base = sanitizeFilename(originalName || fallback);
  return base || fallback;
}

module.exports = {
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
  sanitizeFilename,
  getDisplayFilename,
};
