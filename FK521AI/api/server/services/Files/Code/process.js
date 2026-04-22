async function processCodeOutput() {
  const error = new Error('processCodeOutput is unavailable in this runtime build.');
  error.code = 'CODE_PROCESS_UNAVAILABLE';
  throw error;
}

module.exports = { processCodeOutput };
