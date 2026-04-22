jest.mock('nanoid', () => ({ nanoid: () => 'fixed-nanoid' }), { virtual: true });
jest.mock('@fk521ai/agents', () => ({ EnvVar: { CODE_API_KEY: 'CODE_API_KEY' } }), { virtual: true });
jest.mock('@fk521ai/data-schemas', () => ({ logger: { warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }), {
  virtual: true,
});
jest.mock('@fk521ai/api', () => ({ checkAccess: jest.fn() }), { virtual: true });
jest.mock('fk521ai-data-provider', () => ({
  Tools: { execute_code: 'execute_code' },
  AuthType: {},
  Permissions: { USE: 'use' },
  ToolCallTypes: { TOOL_CALL: 'tool_call' },
  PermissionTypes: { RUN_CODE: 'run_code' },
}), { virtual: true });

jest.mock('~/models', () => ({
  getRoleByName: jest.fn(),
  createToolCall: jest.fn(),
  getToolCallsByConvo: jest.fn(),
  getMessage: jest.fn(),
  getConvoFiles: jest.fn(),
}), { virtual: true });

jest.mock('~/server/services/Files/process', () => ({ processFileURL: jest.fn(), uploadImageBuffer: jest.fn() }), { virtual: true });
jest.mock('~/server/services/Files/Code/process', () => ({ processCodeOutput: jest.fn() }), { virtual: true });
jest.mock('~/server/services/Tools/credentials', () => ({ loadAuthValues: jest.fn() }), { virtual: true });
jest.mock('~/app/clients/tools/util', () => ({ loadTools: jest.fn() }), { virtual: true });
jest.mock('~/server/services/Sandbox/dockerExecutor', () => ({
  executeDockerSandbox: jest.fn().mockResolvedValue({ image: 'sandbox', cwd: '/workspace', attachments: [] }),
}), { virtual: true });
jest.mock('~/server/services/Sandbox/uploads', () => ({
  syncConversationFilesToSandbox: jest.fn().mockResolvedValue({ syncedFiles: [], skippedFiles: [] }),
}), { virtual: true });
jest.mock('~/server/services/Sandbox/runtimeContract', () => ({
  ensureSandboxCapabilityManifest: jest.fn().mockResolvedValue({ manifest: {}, sandboxPath: '/workspace/manifest' }),
}), { virtual: true });
jest.mock('~/server/services/Sandbox/authorization', () => ({
  SANDBOX_ACTIONS: { EXECUTE_CODE: 'sandbox:execute_code' },
  authorizeSandboxAction: jest.fn(),
}), { virtual: true });
jest.mock('~/server/services/DownloadLinks', () => ({ createAttachmentDownloadLink: jest.fn() }), { virtual: true });
jest.mock('~/server/utils/difyConsoleConfig', () => ({
  readDifyConsoleConfig: jest.fn(() => ({ codeExecutor: { allowNetwork: false } })),
}), { virtual: true });

const { getMessage, getConvoFiles, createToolCall } = require('~/models');
const { authorizeSandboxAction } = require('~/server/services/Sandbox/authorization');
const { executeDockerSandbox } = require('~/server/services/Sandbox/dockerExecutor');
const { createAttachmentDownloadLink } = require('~/server/services/DownloadLinks');
const { callTool } = require('./tools');

function createRes() {
  return {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };
}

describe('tools controller security bindings', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    createToolCall.mockResolvedValue({});
  });

  test('rejects mixed messageId + foreign conversationId', async () => {
    getMessage.mockResolvedValue({ messageId: 'msg-1', conversationId: 'convo-owner' });
    const req = {
      params: { toolId: 'execute_code' },
      body: { messageId: 'msg-1', conversationId: 'convo-foreign', code: 'print(1)', language: 'python' },
      user: { id: 'user-1', tenantId: 'tenant-1' },
      config: { endpoints: { agents: { capabilities: ['execute_code'] } } },
    };
    const res = createRes();

    await callTool(req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error_code: 'CONVERSATION_MISMATCH' }));
  });

  test('passes allowExecuteCode=false when endpoint capability is not enabled', async () => {
    getMessage.mockResolvedValue({ messageId: 'msg-1', conversationId: 'convo-1' });
    authorizeSandboxAction.mockResolvedValue({ allow: false, reasonCode: 'EXECUTE_CODE_CAPABILITY_REQUIRED' });
    const req = {
      params: { toolId: 'execute_code' },
      body: { messageId: 'msg-1', code: 'print(1)', language: 'python' },
      user: { id: 'user-1', tenantId: 'tenant-1' },
      config: { endpoints: { agents: { capabilities: ['tools'] } } },
    };
    const res = createRes();

    await callTool(req, res);

    expect(authorizeSandboxAction).toHaveBeenCalledWith(
      expect.objectContaining({ allowExecuteCode: false }),
    );
    expect(res.status).toHaveBeenCalledWith(403);
  });

  test('binds file sync lookup to message conversation + owner context', async () => {
    getMessage.mockResolvedValue({ messageId: 'msg-1', conversationId: 'convo-1' });
    authorizeSandboxAction.mockResolvedValue({ allow: true });
    const req = {
      params: { toolId: 'execute_code' },
      body: { messageId: 'msg-1', code: 'print(1)', language: 'python' },
      user: { id: 'user-1', tenantId: 'tenant-1' },
      config: { endpoints: { agents: { capabilities: ['execute_code'] } } },
    };
    const res = createRes();

    await callTool(req, res);

    expect(getConvoFiles).toHaveBeenCalledWith('convo-1', { user: 'user-1', tenantId: 'tenant-1' });
  });

  test('returns button-friendly relative download path fields for attachments', async () => {
    getMessage.mockResolvedValue({ messageId: 'msg-2', conversationId: 'convo-2' });
    authorizeSandboxAction.mockResolvedValue({ allow: true });
    executeDockerSandbox.mockResolvedValue({
      image: 'sandbox',
      cwd: '/workspace',
      attachments: [{ file_id: 'file-1', filename: 'result.zip' }],
    });
    createAttachmentDownloadLink.mockResolvedValue({
      download_path: '/api/downloads/dl?t=token123',
      download_url: '/api/downloads/dl?t=token123',
      expires_at: '2026-04-22T00:00:00.000Z',
      policy_version: 'v1',
      policy_snapshot_id: 's1',
    });

    const req = {
      params: { toolId: 'execute_code' },
      body: { messageId: 'msg-2', code: 'print(2)', language: 'python' },
      user: { id: 'user-1', tenantId: 'tenant-1' },
      config: { endpoints: { agents: { capabilities: ['execute_code'] } } },
    };
    const res = createRes();

    await callTool(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    const payload = res.json.mock.calls[0][0];
    expect(payload.attachments[0].downloadPath).toBe('/api/downloads/dl?t=token123');
    expect(payload.attachments[0].downloadTokenizedPath).toBe('/api/downloads/dl?t=token123');
    expect(payload.attachments[0].downloadURL).toBe('/api/downloads/dl?t=token123');
  });
});
