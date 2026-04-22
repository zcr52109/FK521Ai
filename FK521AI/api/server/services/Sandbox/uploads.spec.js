const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

jest.mock('~/models', () => ({
  getFiles: jest.fn(),
}), { virtual: true });

jest.mock('@fk521ai/api', () => ({
  sanitizeFilename: (value) => String(value || '').replace(/[^\w.\-\u4e00-\u9fa5]/g, ''),
  getDisplayFilename: (value, fallback) => value || fallback,
}), { virtual: true });

jest.mock('mime-types', () => ({
  lookup: () => 'application/octet-stream',
}), { virtual: true });

jest.mock('@fk521ai/data-schemas', () => ({
  logger: {
    warn: jest.fn(),
  },
}), { virtual: true });

jest.mock('./runtimeContract', () => ({
  SANDBOX_PATHS: {
    uploads: '/workspace/uploads',
    projects: '/workspace/projects',
    outputs: '/workspace/outputs',
  },
  ensureSandboxCapabilityManifest: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('./projectArchives', () => ({
  prepareProjectArchives: jest.fn().mockResolvedValue({
    projectArchives: [],
    archiveFailures: [],
    manifestInfo: { virtualPath: '/workspace/manifests/project-archives.json' },
  }),
  buildProjectArchivesContext: jest.fn(() => ''),
}));

describe('syncConversationFilesToSandbox', () => {
  let tempRoot;
  let uploadsRoot;

  beforeEach(async () => {
    jest.resetModules();
    tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'fk521-uploads-'));
    uploadsRoot = path.join(tempRoot, 'uploads');
    await fsp.mkdir(uploadsRoot, { recursive: true });
    process.env.FK521_SANDBOX_BASE_DIR = path.join(tempRoot, 'sandboxes');

    jest.doMock('~/config/paths', () => ({
      uploads: uploadsRoot,
      publicPath: path.join(tempRoot, 'public'),
      imageOutput: path.join(tempRoot, 'public', 'images'),
    }), { virtual: true });
  });

  afterEach(async () => {
    delete process.env.FK521_SANDBOX_BASE_DIR;
    await fsp.rm(tempRoot, { recursive: true, force: true });
    jest.resetModules();
  });

  it('copies /uploads/... files into the workspace sandbox', async () => {
    const userDir = path.join(uploadsRoot, 'user-1');
    await fsp.mkdir(userDir, { recursive: true });
    const storedFile = path.join(userDir, '测试.zip');
    await fsp.writeFile(storedFile, 'zip-bytes');

    const { syncConversationFilesToSandbox } = require('./uploads');
    const { getFiles } = require('~/models');
    getFiles.mockResolvedValue([
      {
        file_id: 'file-1',
        filename: '测试.zip',
        filepath: '/uploads/user-1/测试.zip',
        type: 'application/zip',
        source: 'local',
        createdAt: new Date('2026-04-10T07:00:00.000Z'),
      },
    ]);
    const result = await syncConversationFilesToSandbox({
      conversationId: 'conversation-1',
      conversationFileIds: ['file-1'],
      user: { id: 'user-1', tenantId: 'tenant-1' },
    });

    expect(result.syncedFiles).toHaveLength(1);
    expect(result.skippedFiles).toHaveLength(0);
    expect(result.syncedFiles[0].virtualPath).toMatch(/^\/workspace\/uploads\//);
    expect(fs.existsSync(result.syncedFiles[0].hostPath)).toBe(true);

    const manifestContent = JSON.parse(await fsp.readFile(result.uploadManifest.hostPath, 'utf8'));
    expect(manifestContent.files).toHaveLength(1);
    expect(manifestContent.files[0].originalName).toBe('测试.zip');
    expect(getFiles).toHaveBeenCalledWith(
      {
        file_id: { $in: ['file-1'] },
        conversationId: 'conversation-1',
        user: 'user-1',
        tenantId: 'tenant-1',
      },
      null,
      { text: 0 },
    );
  });

  it('fails closed for file sync when user context is missing', async () => {
    const { syncConversationFilesToSandbox } = require('./uploads');
    const { getFiles } = require('~/models');
    getFiles.mockResolvedValue([
      {
        file_id: 'file-1',
        filename: 'data.txt',
        filepath: '/uploads/user-1/data.txt',
      },
    ]);
    const result = await syncConversationFilesToSandbox({
      conversationId: 'conversation-1',
      conversationFileIds: ['file-1'],
      user: null,
    });

    expect(result.syncedFiles).toHaveLength(0);
    expect(getFiles).not.toHaveBeenCalled();
  });

  it('builds grouped context for archives and context docs', async () => {
    const { buildSandboxUploadsContext } = require('./uploads');
    const context = buildSandboxUploadsContext(
      [
        {
          file_id: 'archive-1',
          filename: 'frontend.zip',
          originalName: 'frontend.zip',
          virtualPath: '/workspace/uploads/frontend.zip',
          path: '/workspace/uploads/frontend.zip',
          size: 100,
          type: 'application/zip',
          sha256: 'a'.repeat(64),
          uploadedAt: new Date().toISOString(),
          permission: 'ro',
        },
        {
          file_id: 'doc-1',
          filename: 'spec.md',
          originalName: 'spec.md',
          virtualPath: '/workspace/uploads/spec.md',
          path: '/workspace/uploads/spec.md',
          size: 100,
          type: 'text/markdown',
          sha256: 'b'.repeat(64),
          uploadedAt: new Date().toISOString(),
          permission: 'ro',
        },
      ],
      [],
      [{ file_id: 'archive-1', archiveFilename: 'frontend.zip' }],
      { virtualPath: '/workspace/manifests/uploaded-files.json' },
      [],
      { virtualPath: '/workspace/manifests/project-archives.json' },
    );

    expect(context).toContain('project_archive_files:');
    expect(context).toContain('context_files:');
    expect(context).toContain('/workspace/manifests/project-archives.json');
    expect(context).toContain('不要在回复中输出原始下载 URL');
  });
});
