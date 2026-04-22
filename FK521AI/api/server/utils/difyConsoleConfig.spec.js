const { normalizeDifyConsoleConfig } = require('./difyConsoleConfig');

describe('difyConsoleConfig security defaults', () => {
  test('defaults allowProgrammaticToolBridge to false when missing', () => {
    const normalized = normalizeDifyConsoleConfig({});
    expect(normalized.sandboxTools.allowProgrammaticToolBridge).toBe(false);
  });
});
