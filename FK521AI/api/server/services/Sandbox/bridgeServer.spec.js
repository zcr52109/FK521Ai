const { createSandboxBridge } = require('./bridgeServer');

describe('bridgeServer security controls', () => {
  test('fails closed when bridge network is disabled', async () => {
    delete process.env.FK521_ENABLE_PROGRAMMATIC_BRIDGE_NETWORK;
    await expect(
      createSandboxBridge({
        toolMap: new Map(),
        toolDefs: [],
      }),
    ).rejects.toThrow('Programmatic bridge network is disabled');
  });
});
