jest.mock('./authorization', () => ({
  buildSandboxSubject: jest.fn(() => ({
    principalId: 'user-1',
    roles: ['user'],
    scopes: ['sandbox:read'],
  })),
  getTenantId: jest.fn(() => 'tenant-1'),
  resolveSandboxCapabilities: jest.fn(async () => ['tool:execute_code', 'fs:write_outputs']),
  SANDBOX_POLICY_MODEL: 'hybrid',
  SANDBOX_POLICY_VERSION: 'sandbox-policy-test',
}));

jest.mock('~/server/services/Platform/identity', () => ({
  getPlatformAssistantName: jest.fn(() => 'FK521AI'),
  getPlatformIdentityMetadata: jest.fn(() => ({
    applicationTitle: 'FK521AI',
    assistantName: 'FK521AI',
  })),
}));

jest.mock('~/server/services/Sandbox/archiveUtils', () => ({
  getSupportedArchiveSummary: jest.fn(() => 'zip, tar'),
  getArchiveToolStatus: jest.fn(() => ({
    commands: { zip: true, unzip: true, tar: true, '7z': false, python3: true },
    operations: {
      listZip: { available: true, backend: 'yauzl' },
      extractZip: { available: true, backend: 'yauzl' },
      listTar: { available: true, backend: 'tar' },
      extractTar: { available: true, backend: 'python3' },
      createZip: { available: true, backend: 'zip' },
      createTar: { available: true, backend: 'tar' },
    },
  })),
}));

const {
  getSandboxCapabilityManifest,
  signManifest,
  assertSandboxContractSecretConfigured,
} = require('./runtimeContract');

describe('Sandbox runtime contract', () => {
  beforeEach(() => {
    process.env.FK521_SANDBOX_CONTRACT_SECRET = 'test-sandbox-secret';
  });

  afterEach(() => {
    delete process.env.FK521_SANDBOX_CONTRACT_SECRET;
  });

  test('builds a signed v7 manifest with subject, policy, filesystem rules, and archive status', async () => {
    const manifest = await getSandboxCapabilityManifest('convo-1', {
      user: { id: 'user-1', role: 'user', tenantId: 'tenant-1' },
    });

    expect(manifest.version).toBe(7);
    expect(manifest.tenantId).toBe('tenant-1');
    expect(manifest.subject.principalId).toBe('user-1');
    expect(manifest.policy.policyVersion).toBe('sandbox-policy-test');
    expect(manifest.capabilities).toContain('tool:execute_code');
    expect(manifest.filesystem.pathRules).toEqual({
      normalize: true,
      denySymlinkEscape: true,
      denyPathTraversal: true,
    });
    expect(manifest.filesystem.downloadPolicy.allowedRoots).toEqual(['outputs', 'workspace/tasks']);
    expect(manifest.archive).toMatchObject({
      supportedFormats: 'zip, tar',
      toolStatus: {
        commands: expect.objectContaining({ zip: true, tar: true, python3: true }),
      },
    });
    expect(manifest.signature).toMatchObject({
      alg: 'HS256',
      kid: expect.any(String),
      sig: expect.any(String),
    });
  });

  test('signManifest is stable for identical payloads', () => {
    const payload = { hello: 'world', nested: { a: 1, b: 2 } };
    expect(signManifest(payload)).toEqual(signManifest(payload));
  });

  test('requires explicit sandbox contract secret', () => {
    delete process.env.FK521_SANDBOX_CONTRACT_SECRET;
    expect(() => assertSandboxContractSecretConfigured()).toThrow(/FK521_SANDBOX_CONTRACT_SECRET/);
  });
});
