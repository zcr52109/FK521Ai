jest.mock('@fk521ai/data-schemas', () => ({
  logger: {
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
  },
}), { virtual: true });

jest.mock('fk521ai-data-provider', () => ({
  FileSources: {
    local: 'local',
    firebase: 'firebase',
    s3: 's3',
    azure_blob: 'azure_blob',
  },
}), { virtual: true });

jest.mock('@fk521ai/api', () => ({
  buildContentDisposition: (filename) => `attachment; filename=\"${filename}\"`,
  getDisplayFilename: (filename, fallback) => filename || fallback,
}), { virtual: true });

jest.mock('~/models', () => ({
  getFiles: jest.fn(async () => []),
  getConvo: jest.fn(async () => null),
}), { virtual: true });

jest.mock('~/server/utils/files', () => ({
  cleanFileName: jest.fn((value) => String(value || '').replace(/[^a-zA-Z0-9._-]/g, '_')),
}), { virtual: true });

jest.mock('~/server/services/Files/strategies', () => ({
  getStrategyFunctions: jest.fn(() => ({ getDownloadStream: undefined })),
}), { virtual: true });

jest.mock('~/server/services/Sandbox/paths', () => ({
  resolveConversationFile: jest.fn(),
  classifySandboxRelativePath: jest.fn((relativePath) => {
    const normalizedPath = String(relativePath || '').replace(/^\/+/, '');
    return {
      normalizedPath,
      rootId: normalizedPath.startsWith('outputs/') ? 'outputs' : null,
      downloadAllowed: normalizedPath.startsWith('outputs/'),
    };
  }),
}), { virtual: true });

jest.mock('~/server/services/RuntimePolicy', () => ({
  getCachedRuntimePolicySnapshot: jest.fn(() => ({
    policyVersion: 'policy-test',
    snapshotId: 'snapshot-test',
  })),
}), { virtual: true });

const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { getFiles, getConvo } = require('~/models');
const { resolveConversationFile } = require('~/server/services/Sandbox/paths');
const {
  signPayload,
  verifySignedToken,
  buildAbsoluteDownloadUrl,
  buildRelativeDownloadPath,
  createSandboxDownloadLink,
  resolveDownloadResource,
  assertDownloadSecretConfigured,
} = require('./index');

describe('DownloadLinks', () => {
  beforeEach(() => {
    process.env.FK521_DOWNLOAD_LINK_SECRET = 'test-download-secret';
    getConvo.mockResolvedValue({
      conversationId: 'convo-1',
      user: 'user-1',
      tenantId: 'tenant-1',
    });
    getFiles.mockResolvedValue([
      {
        file_id: 'file-1',
        user: 'user-1',
        tenantId: 'tenant-1',
        conversationId: 'convo-1',
        source: 'local',
        filepath: '/uploads/u/file-1.txt',
        filename: 'file-1.txt',
        type: 'text/plain',
      },
    ]);
  });

  afterEach(() => {
    delete process.env.FK521_DOWNLOAD_LINK_SECRET;
    delete process.env.DOMAIN_SERVER;
    delete process.env.FK521_ALLOW_REQUEST_HOST_BASE_URL;
  });

  test('signs and verifies download tokens', () => {
    const payload = {
      kind: 'sandbox',
      conversationId: 'convo-1',
      relativePath: 'outputs/fix.zip',
      exp: Date.now() + 60_000,
      method: 'GET',
      nonce: 'nonce-1',
    };

    const token = signPayload(payload);
    const verified = verifySignedToken(token);

    expect(verified.kind).toBe('sandbox');
    expect(verified.relativePath).toBe('outputs/fix.zip');
  });

  test('rejects expired tokens', () => {
    const payload = {
      kind: 'file',
      file_id: 'file-1',
      exp: Date.now() - 1_000,
      method: 'GET',
      nonce: 'nonce-2',
    };

    const token = signPayload(payload);
    expect(() => verifySignedToken(token)).toThrow(/expired/i);
  });

  test('builds absolute download url only from configured domain by default', () => {
    process.env.DOMAIN_SERVER = 'https://api.fk521.example';
    const url = buildAbsoluteDownloadUrl(
      {
        headers: {
          'x-forwarded-proto': 'https',
          'x-forwarded-host': 'example.com',
        },
      },
      'abc.token',
    );

    expect(url).toBe('https://api.fk521.example/api/downloads/dl?t=abc.token');
    delete process.env.DOMAIN_SERVER;
  });

  test('does not trust x-forwarded-host for frontend-facing links', () => {
    const url = buildAbsoluteDownloadUrl(
      {
        protocol: 'https',
        headers: {
          host: 'public.example.com',
          'x-forwarded-host': '10.0.0.8:3080',
        },
      },
      'abc.token',
    );
    expect(url).toBe('/api/downloads/dl?t=abc.token');
  });

  test('can opt-in host based absolute url for internal out-of-band use', () => {
    process.env.FK521_ALLOW_REQUEST_HOST_BASE_URL = 'true';
    const url = buildAbsoluteDownloadUrl(
      {
        protocol: 'https',
        headers: {
          host: 'public.example.com',
          'x-forwarded-host': '10.0.0.8:3080',
        },
      },
      'abc.token',
    );
    expect(url).toBe('https://public.example.com/api/downloads/dl?t=abc.token');
    delete process.env.FK521_ALLOW_REQUEST_HOST_BASE_URL;
  });

  test('builds relative tokenized path for frontend delivery', () => {
    expect(buildRelativeDownloadPath('abc.token')).toBe('/api/downloads/dl?t=abc.token');
  });

  test('creates sandbox links only for readable existing files', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'download-link-'));
    const filePath = path.join(tempDir, 'fix.zip');
    await fs.writeFile(filePath, 'ok', 'utf8');
    resolveConversationFile.mockResolvedValue({
      normalizedPath: 'outputs/fix.zip',
      absolutePath: filePath,
    });

    const link = await createSandboxDownloadLink({
      req: {
        protocol: 'https',
        headers: { host: 'example.com' },
        user: { id: 'user-1', tenantId: 'tenant-1' },
      },
      conversationId: 'convo-1',
      relativePath: 'outputs/fix.zip',
      filename: 'fix.zip',
    });

    expect(link.download_path).toContain('/api/downloads/dl?t=');
    expect(link.download_url).toBe(link.download_path);
    const token = new URL(`https://example.com${link.download_path}`).searchParams.get('t');
    const claims = verifySignedToken(token);
    expect(claims.relativePath).toBe('outputs/fix.zip');
  });

  test('refuses sandbox links for missing files', async () => {
    resolveConversationFile.mockResolvedValue({
      normalizedPath: 'outputs/missing.zip',
      absolutePath: path.join(os.tmpdir(), `missing-${Date.now()}.zip`),
    });

    await expect(
      createSandboxDownloadLink({
        req: { protocol: 'https', headers: { host: 'example.com' }, user: { id: 'user-1' } },
        conversationId: 'convo-1',
        relativePath: 'outputs/missing.zip',
        filename: 'missing.zip',
      }),
    ).rejects.toMatchObject({ code: 'FILE_NOT_FOUND' });
  });

  test('requires explicit download signing secret', () => {
    delete process.env.FK521_DOWNLOAD_LINK_SECRET;
    expect(() => assertDownloadSecretConfigured()).toThrow(/FK521_DOWNLOAD_LINK_SECRET/);
  });

  test('revalidates file owner/tenant/conversation when streaming by claims', async () => {
    const req = {
      config: { paths: { uploads: '/tmp', imageOutput: '/tmp' } },
    };
    const claims = {
      kind: 'file',
      file_id: 'file-1',
      owner: 'user-1',
      tenantId: 'tenant-1',
      conversationId: 'convo-1',
      filename: 'file-1.txt',
      exp: Date.now() + 60_000,
    };

    const resource = await resolveDownloadResource(req, claims);
    expect(resource.filename).toBe('file-1.txt');

    getFiles.mockResolvedValue([
      {
        file_id: 'file-1',
        user: 'user-2',
        tenantId: 'tenant-9',
        conversationId: 'convo-1',
        source: 'local',
        filepath: '/uploads/u/file-1.txt',
      },
    ]);
    await expect(resolveDownloadResource(req, claims)).rejects.toMatchObject({
      code: 'FILE_ACCESS_DENIED',
    });
  });
});
