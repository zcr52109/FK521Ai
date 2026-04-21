const noop = () => undefined;
const logger = {
  info: noop,
  warn: noop,
  error: noop,
  debug: noop,
};

async function runAsSystem(fn) {
  if (typeof fn === 'function') {
    return fn();
  }
  return undefined;
}

module.exports = { logger, runAsSystem };
