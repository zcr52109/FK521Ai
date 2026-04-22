async function executeDockerSandbox() {
  const error = new Error('Local docker sandbox executor is not available in this runtime build.');
  error.code = 'SANDBOX_EXECUTOR_UNAVAILABLE';
  throw error;
}

module.exports = { executeDockerSandbox };
