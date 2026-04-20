const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const vm = require('vm');

function loadWorkspaceFs({ sandboxPaths }) {
  const modulePath = path.resolve(__dirname, '../api/server/services/Sandbox/workspaceFs.js');
  const source = fs.readFileSync(modulePath, 'utf8');
  const module = { exports: {} };

  const mockRequire = (request) => {
    if (request === 'crypto' || request === 'fs/promises' || request === 'path') {
      return require(request);
    }
    if (request === './paths') {
      return { ensureConversationSandbox: () => sandboxPaths };
    }
    if (request === './sandboxInfo') {
      return { sandboxInfo: async () => ({ ok: true }) };
    }
    if (request === './processList') {
      return { processList: async () => [] };
    }
    if (request === './hostFilesystemAccess') {
      return { hostFilesystemAccess: async () => ({}) };
    }
    if (request === './databaseConnect') {
      return { databaseConnect: async () => ({}) };
    }
    if (request === './requester') {
      return { assertAdmin: () => undefined };
    }
    if (request === './archiveUtils') {
      return {
        inferArchiveFormat: () => ({ id: 'zip' }),
        createArchive: async () => undefined,
        extractArchive: async () => ({ id: 'zip' }),
        inspectArchive: async () => ({ format: { id: 'zip' }, entryCount: 0, truncated: false, encryptedEntries: 0, dangerousEntries: 0, totalUncompressedBytes: 0, totalCompressedBytes: 0, members: [] }),
        validateArchive: async () => ({ format: { id: 'zip' }, memberCount: 0, archiveSha256: '', expectedSha256: '', sha256Matches: true, encryptedEntries: [], crc32: { status: 'ok' }, structure: { ok: true }, integrity: { ok: true }, memberHashes: [] }),
      };
    }
    if (request === '~/server/services/Platform/runtimeContext') {
      return {
        WORKSPACE_VIRTUAL_ROOT: '/workspace',
        WORKSPACE_VIRTUAL_PATHS: {
          root: '/workspace',
          uploads: '/workspace/uploads',
          workdir: '/workspace/workdir',
          projects: '/workspace/projects',
          outputs: '/workspace/outputs',
          manifests: '/workspace/manifests',
          uploadManifest: '/workspace/manifests/uploaded-files.json',
        },
      };
    }
    if (request === '~/server/services/RuntimePolicy') {
      return { readPolicyAuditLog: () => [] };
    }
    throw new Error(`Unexpected require: ${request}`);
  };

  const wrapper = `(function(require, module, exports, __filename, __dirname){${source}\n})`;
  const compiled = vm.runInThisContext(wrapper, { filename: modulePath });
  compiled(mockRequire, module, module.exports, modulePath, path.dirname(modulePath));
  return module.exports;
}

test('workspace tools: glob/grep pagination/search-replace/delete/todo/summary', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'fk521-tools-'));
  const sandboxPaths = {
    uploadsDir: path.join(root, 'uploads'),
    workspaceDir: path.join(root, 'workdir'),
    projectsDir: path.join(root, 'projects'),
    outputsDir: path.join(root, 'outputs'),
  };
  await Promise.all(Object.values(sandboxPaths).map((dir) => fsp.mkdir(dir, { recursive: true })));

  const workspaceFs = loadWorkspaceFs({ sandboxPaths });
  const authContext = { user: { id: 'u1' } };

  await workspaceFs.workspaceWrite({
    conversationId: 'c1',
    path: '/workspace/workdir/src/a.txt',
    content: 'alpha\nneedle-one\nneedle-two\nneedle-three\n',
    authContext,
  });
  await workspaceFs.workspaceWrite({
    conversationId: 'c1',
    path: '/workspace/workdir/src/b.js',
    content: 'const needle = 1;\n',
    authContext,
  });

  const globResult = await workspaceFs.workspaceGlobFind({
    conversationId: 'c1',
    rootPath: '/workspace/workdir/src',
    pattern: '*.txt',
    authContext,
  });
  assert.equal(globResult.matches.length, 1);
  assert.match(globResult.matches[0].path, /a\.txt$/);

  const grepPage1 = await workspaceFs.workspaceGrepSearch({
    conversationId: 'c1',
    rootPath: '/workspace/workdir/src',
    query: 'needle',
    pageSize: 2,
    cursor: 0,
    authContext,
  });
  assert.equal(grepPage1.returned, 2);
  assert.equal(grepPage1.hasMore, true);
  assert.equal(grepPage1.nextCursor, 2);

  const grepPage2 = await workspaceFs.workspaceGrepSearch({
    conversationId: 'c1',
    rootPath: '/workspace/workdir/src',
    query: 'needle',
    pageSize: 2,
    cursor: grepPage1.nextCursor,
    authContext,
  });
  assert.equal(grepPage2.returned >= 1, true);

  const replaceResult = await workspaceFs.workspaceSearchReplace({
    conversationId: 'c1',
    path: '/workspace/workdir/src/b.js',
    search: 'needle',
    replace: 'updated',
    replaceAll: true,
    authContext,
  });
  assert.equal(replaceResult.replacements, 1);

  const deleteResult = await workspaceFs.workspaceDelete({
    conversationId: 'c1',
    path: '/workspace/workdir/src/b.js',
    recursive: false,
    authContext,
  });
  assert.equal(deleteResult.deleted, true);

  await workspaceFs.workspaceWriteTodo({
    conversationId: 'c1',
    todos: [
      { title: 'task-1', done: true },
      { title: 'task-2', done: false },
    ],
    authContext,
  });
  const todoResult = await workspaceFs.workspaceReadTodo({ conversationId: 'c1', authContext });
  assert.equal(todoResult.total, 2);

  const summary = await workspaceFs.workspaceTaskSummary({ conversationId: 'c1', authContext });
  assert.equal(summary.done, 1);
  assert.equal(summary.pending, 1);
});
