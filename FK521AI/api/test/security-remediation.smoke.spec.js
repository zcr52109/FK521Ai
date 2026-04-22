jest.mock('@fk521ai/api', () => ({ checkAccess: jest.fn() }), { virtual: true });
jest.mock('fk521ai-data-provider', () => ({
  Permissions: { USE: 'use' },
  PermissionTypes: { RUN_CODE: 'run_code' },
  Tools: { execute_code: 'execute_code' },
  AuthType: {},
  ToolCallTypes: { TOOL_CALL: 'tool_call' },
}), { virtual: true });
jest.mock('@fk521ai/data-schemas', () => ({ logger: { warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }), {
  virtual: true,
});
jest.mock('@fk521ai/agents', () => ({ EnvVar: { CODE_API_KEY: 'CODE_API_KEY' } }), { virtual: true });

describe('security remediation smoke anchors', () => {
  it('loads phase-1 security modules', () => {
    // eslint-disable-next-line global-require
    const authorization = require('~/server/services/Sandbox/authorization');
    // eslint-disable-next-line global-require
    const uploads = require('~/server/services/Sandbox/uploads');
    // eslint-disable-next-line global-require
    const toolsController = require('~/server/controllers/tools');

    expect(typeof authorization.authorizeSandboxAction).toBe('function');
    expect(typeof uploads.syncConversationFilesToSandbox).toBe('function');
    expect(typeof toolsController.callTool).toBe('function');
  });
});
