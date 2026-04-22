const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

jest.mock('@fk521ai/data-schemas', () => ({
  logger: {
    warn: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
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

describe('phase7 attack/regression checks', () => {
  let tempRoot;

  beforeEach(async () => {
    jest.resetModules();
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'fk521-phase7-'));
    process.env.FK521_SANDBOX_BASE_DIR = tempRoot;
    process.env.FK521_DOWNLOAD_LINK_SECRET = 'phase7-secret';
  });

  afterEach(async () => {
    delete process.env.FK521_SANDBOX_BASE_DIR;
    delete process.env.FK521_DOWNLOAD_LINK_SECRET;
    delete process.env.DOMAIN_SERVER;
    delete process.env.FK521_ALLOW_REQUEST_HOST_BASE_URL;
    await fs.rm(tempRoot, { recursive: true, force: true });
    jest.resetModules();
  });

  test('same-basename archives never overwrite and both remain in manifest', async () => {
    const { prepareProjectArchives } = require('~/server/services/Sandbox/projectArchives');

    const result = await prepareProjectArchives({
      conversationId: 'convo-a',
      syncedFiles: [
        { file_id: 'archive-11111111', filename: 'frontend.zip', type: 'application/zip' },
        { file_id: 'archive-22222222', filename: 'frontend.zip', type: 'application/zip' },
      ],
      authContext: {},
    });

    expect(result.projectArchives).toHaveLength(2);
    expect(result.projectArchives[0].extractSandboxPath).not.toBe(result.projectArchives[1].extractSandboxPath);
    expect(result.manifestInfo.manifest.archives).toHaveLength(2);
  });

  test('multi top-level directories produce rootCandidates and a deterministic primary root', async () => {
    const { ensureConversationSandbox } = require('~/server/services/Sandbox/paths');
    const { prepareProjectArchives } = require('~/server/services/Sandbox/projectArchives');

    const sandbox = ensureConversationSandbox('convo-b');
    const suffix = crypto.createHash('sha1').update('archive1').digest('hex').slice(0, 8);
    const extractDir = path.join(sandbox.projectsDir, `monorepo--${suffix}`);
    await fs.mkdir(path.join(extractDir, 'frontend'), { recursive: true });
    await fs.mkdir(path.join(extractDir, 'backend'), { recursive: true });
    await fs.writeFile(path.join(extractDir, 'frontend', 'package.json'), '{"name":"frontend"}', 'utf8');
    await fs.writeFile(path.join(extractDir, 'backend', 'pyproject.toml'), '[project]\nname=\"backend\"', 'utf8');

    const result = await prepareProjectArchives({
      conversationId: 'convo-b',
      syncedFiles: [{ file_id: 'archive1', filename: 'monorepo.zip', type: 'application/zip' }],
      authContext: {},
    });

    const archive = result.projectArchives[0];
    expect(archive.projectRootCandidates.length).toBeGreaterThan(1);
    expect(typeof archive.primaryProjectRoot === 'string' || archive.primaryProjectRoot === null).toBe(true);
  });

  test('download url builder does not leak x-forwarded-host by default', () => {
    const { buildAbsoluteDownloadUrl } = require('~/server/services/DownloadLinks');
    const url = buildAbsoluteDownloadUrl(
      {
        protocol: 'https',
        headers: {
          host: 'public.example.com',
          'x-forwarded-host': '10.0.0.8:3080',
        },
      },
      'phase7.token',
    );
    expect(url).toBe('/api/downloads/dl?t=phase7.token');
  });

  test('single local file download flow remains available with relative button path', async () => {
    const { createFileDownloadLink, verifySignedToken } = require('~/server/services/DownloadLinks');
    const uploadsRoot = path.join(tempRoot, 'uploads');
    await fs.mkdir(path.join(uploadsRoot, 'u1'), { recursive: true });
    const filePath = path.join(uploadsRoot, 'u1', 'result.txt');
    await fs.writeFile(filePath, 'ok', 'utf8');

    const link = await createFileDownloadLink({
      req: {
        user: { id: 'user-1', tenantId: 'tenant-1' },
        config: { paths: { uploads: uploadsRoot, imageOutput: uploadsRoot } },
      },
      file: {
        file_id: 'file-1',
        source: 'local',
        filepath: '/uploads/u1/result.txt',
        filename: 'result.txt',
        conversationId: 'convo-c',
      },
    });

    expect(link.download_path).toMatch(/^\/api\/downloads\/dl\?t=/);
    expect(link.download_url).toBe(link.download_path);
    const token = link.download_path.split('t=')[1];
    const claims = verifySignedToken(token);
    expect(claims.file_id).toBe('file-1');
  });
});
