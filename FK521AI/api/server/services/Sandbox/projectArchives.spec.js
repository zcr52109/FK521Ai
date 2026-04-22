const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

jest.mock('@fk521ai/data-schemas', () => ({
  logger: {
    warn: jest.fn(),
  },
}), { virtual: true });

describe('projectArchives', () => {
  let tempRoot;

  beforeEach(async () => {
    jest.resetModules();
    tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'fk521-project-archives-'));
    process.env.FK521_SANDBOX_BASE_DIR = tempRoot;
  });

  afterEach(async () => {
    delete process.env.FK521_SANDBOX_BASE_DIR;
    await fsp.rm(tempRoot, { recursive: true, force: true });
    jest.resetModules();
  });

  test('creates unique extract directories for same archive basename', async () => {
    const { extractProjectArchive } = require('./projectArchives');
    const first = await extractProjectArchive(
      { file_id: 'file-aaaaaaaa', filename: 'frontend.zip', type: 'application/zip' },
      { conversationId: 'c1' },
    );
    const second = await extractProjectArchive(
      { file_id: 'file-bbbbbbbb', filename: 'frontend.zip', type: 'application/zip' },
      { conversationId: 'c1' },
    );

    expect(first.extractSandboxPath).not.toBe(second.extractSandboxPath);
    expect(first.extractSandboxPath).toContain('frontend--');
    expect(second.extractSandboxPath).toContain('frontend--');
  });

  test('produces root candidates and manifest file', async () => {
    const { prepareProjectArchives } = require('./projectArchives');
    const { ensureConversationSandbox } = require('./paths');
    const sandbox = ensureConversationSandbox('c2');

    const extractPath = path.join(sandbox.projectsDir, 'backend--file-1');
    await fsp.mkdir(path.join(extractPath, 'backend'), { recursive: true });
    await fsp.mkdir(path.join(extractPath, 'frontend'), { recursive: true });
    await fsp.writeFile(path.join(extractPath, 'backend', 'pyproject.toml'), '[project]\nname="api"\n', 'utf8');
    await fsp.writeFile(path.join(extractPath, 'frontend', 'package.json'), '{"name":"web"}', 'utf8');
    await fsp.writeFile(path.join(extractPath, '.gitignore'), 'node_modules', 'utf8');

    const result = await prepareProjectArchives({
      conversationId: 'c2',
      syncedFiles: [{ file_id: 'file-1', filename: 'backend.zip', type: 'application/zip' }],
      authContext: {},
    });

    expect(result.projectArchives).toHaveLength(1);
    expect(result.projectArchives[0].projectRootCandidates.length).toBeGreaterThan(0);
    expect(result.manifestInfo.virtualPath).toBe('/workspace/manifests/project-archives.json');
    expect(fs.existsSync(result.manifestInfo.hostPath)).toBe(true);
  });

  test('buildProjectArchivesContext includes primary root contract text', () => {
    const { buildProjectArchivesContext } = require('./projectArchives');
    const context = buildProjectArchivesContext(
      [
        {
          archiveFilename: 'app.zip',
          extractSandboxPath: '/workspace/projects/app--abcd1234',
          primaryProjectRoot: '/workspace/projects/app--abcd1234/app',
          projectRootCandidates: [{ sandboxPath: '/workspace/projects/app--abcd1234/app' }],
          languageHints: ['javascript'],
        },
      ],
      [],
      { virtualPath: '/workspace/manifests/project-archives.json' },
    );

    expect(context).toContain('manifest_path: /workspace/manifests/project-archives.json');
    expect(context).toContain('primaryProjectRoot');
    expect(context).toContain('不要输出原始下载 URL');
  });
});
