const logger = require('./logger');

// Sanitize outside the logger paths. This is useful for sanitizing variables directly with Regex and patterns.
const redactPatterns = [
  // Array of regular expressions for redacting patterns
  /api[-_]?key/i,
  /password/i,
  /token/i,
  /secret/i,
  /key/i,
  /certificate/i,
  /client[-_]?id/i,
  /authorization[-_]?code/i,
  /authorization[-_]?login[-_]?hint/i,
  /authorization[-_]?acr[-_]?values/i,
  /authorization[-_]?response[-_]?mode/i,
  /authorization[-_]?nonce/i,
];

/*
  // Example of redacting sensitive data from object class instances
  function redactSensitiveData(obj) {
    if (obj instanceof User) {
      return {
        ...obj.toObject(),
        password: '***', // Redact the password field
      };
    }
    return obj;
  }

  // Example of redacting sensitive data from object class instances
  logger.info({ newUser: redactSensitiveData(newUser) }, 'newUser');
*/

const levels = {
  TRACE: 10,
  DEBUG: 20,
  INFO: 30,
  WARN: 40,
  ERROR: 50,
  FATAL: 60,
};

let level = levels.INFO;

function shouldRedactFieldName(name = '') {
  return redactPatterns.some((pattern) => pattern.test(String(name)));
}

function sanitizeValue(value, keyName = '') {
  if (shouldRedactFieldName(keyName)) {
    return '***';
  }
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeValue(entry));
  }
  if (!value || typeof value !== 'object') {
    return value;
  }

  const output = {};
  for (const [key, nestedValue] of Object.entries(value)) {
    output[key] = sanitizeValue(nestedValue, key);
  }
  return output;
}

module.exports = {
  levels,
  setLevel: (l) => (level = l),
  log: {
    trace: (msg) => {
      if (level <= levels.TRACE) {
        return;
      }
      logger.trace(msg);
    },
    debug: (msg) => {
      if (level <= levels.DEBUG) {
        return;
      }
      logger.debug(msg);
    },
    info: (msg) => {
      if (level <= levels.INFO) {
        return;
      }
      logger.info(msg);
    },
    warn: (msg) => {
      if (level <= levels.WARN) {
        return;
      }
      logger.warn(msg);
    },
    error: (msg) => {
      if (level <= levels.ERROR) {
        return;
      }
      logger.error(msg);
    },
    fatal: (msg) => {
      if (level <= levels.FATAL) {
        return;
      }
      logger.fatal(msg);
    },

    // Custom loggers
    parameters: (parameters) => {
      if (level <= levels.TRACE) {
        return;
      }
      logger.debug({ parameters: sanitizeValue(parameters) }, 'Function Parameters');
    },
    functionName: (name) => {
      if (level <= levels.TRACE) {
        return;
      }
      logger.debug(`EXECUTING: ${name}`);
    },
    flow: (flow) => {
      if (level <= levels.INFO) {
        return;
      }
      logger.debug(`BEGIN FLOW: ${flow}`);
    },
    variable: ({ name, value }) => {
      if (level <= levels.DEBUG) {
        return;
      }
      // Check if the variable name matches any of the redact patterns and redact the value
      const sanitizedValue = sanitizeValue(value, name);
      logger.debug({ variable: { name, value: sanitizedValue } }, `VARIABLE ${name}`);
    },
    request: () => (req, res, next) => {
      if (level < levels.DEBUG) {
        return next();
      }
      logger.debug(
        { query: sanitizeValue(req.query), body: sanitizeValue(req.body) },
        `Hit URL ${req.url} with following`,
      );
      return next();
    },
  },
};
