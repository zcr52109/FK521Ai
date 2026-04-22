function getCachedRuntimePolicySnapshot() {
  return {
    policyVersion: 'runtime-default',
    snapshotId: 'snapshot-default',
  };
}

module.exports = { getCachedRuntimePolicySnapshot };
