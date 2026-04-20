const noop = () => undefined;
const logger = {
  info: noop,
  warn: noop,
  error: noop,
  debug: noop,
};
module.exports = { logger };
