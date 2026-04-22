jest.mock('@fk521ai/api', () => ({
  checkAccess: jest.fn(),
}), { virtual: true });

jest.mock('~/models', () => ({
  getRoleByName: jest.fn(),
}));

jest.mock('fk521ai-data-provider', () => ({
  Permissions: { USE: 'use' },
  PermissionTypes: { RUN_CODE: 'run_code' },
}), { virtual: true });

const { checkAccess } = require('@fk521ai/api');
const {
  authorizeSandboxAction,
  resolveSandboxCapabilities,
  SANDBOX_ACTIONS,
  SANDBOX_REASON_CODES,
} = require('./authorization');

describe('Sandbox authorization', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('denies execute_code when execute_code capability is disabled', async () => {
    checkAccess.mockResolvedValue(true);

    const decision = await authorizeSandboxAction({
      user: { id: 'user-1', role: 'limited' },
      action: SANDBOX_ACTIONS.EXECUTE_CODE,
      allowExecuteCode: false,
    });

    expect(decision.allow).toBe(false);
    expect(decision.reasonCode).toBe(SANDBOX_REASON_CODES.EXECUTE_CODE_CAPABILITY_REQUIRED);
  });

  test('denies execute_code when RUN_CODE is missing', async () => {
    checkAccess.mockResolvedValue(false);

    const decision = await authorizeSandboxAction({
      user: { id: 'user-1', role: 'limited' },
      action: SANDBOX_ACTIONS.EXECUTE_CODE,
      allowExecuteCode: true,
    });

    expect(decision.allow).toBe(false);
    expect(decision.reasonCode).toBe(SANDBOX_REASON_CODES.ROLE_MISSING_RUN_CODE);
  });

  test('allows execute_code only when capability and RUN_CODE are both granted', async () => {
    checkAccess.mockResolvedValue(true);

    const decision = await authorizeSandboxAction({
      user: { id: 'user-1', role: 'developer' },
      action: SANDBOX_ACTIONS.EXECUTE_CODE,
      allowExecuteCode: true,
    });

    expect(decision.allow).toBe(true);
  });

  test('exposes execute_code capability by default', async () => {
    checkAccess.mockResolvedValue(true);

    const capabilities = await resolveSandboxCapabilities({
      user: { id: 'user-1', role: 'user' },
    });

    expect(capabilities).toContain('tool:execute_code');
    expect(capabilities).toContain('fs:write_outputs');
  });

  test('denies sandbox download from uploads root', async () => {
    const decision = await authorizeSandboxAction({
      user: { id: 'user-1', role: 'user' },
      action: SANDBOX_ACTIONS.DOWNLOAD_FILE,
      relativePath: 'uploads/private.txt',
    });

    expect(decision.allow).toBe(false);
    expect(decision.reasonCode).toBe(SANDBOX_REASON_CODES.ROOT_NOT_DOWNLOADABLE);
  });
});
