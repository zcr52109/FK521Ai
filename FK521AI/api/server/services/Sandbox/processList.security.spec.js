describe('processList security controls', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  test('requires admin requester context', async () => {
    const execFileMock = jest.fn((_cmd, _args, _opts, cb) => cb(null, '1 0 S 00:01 0.0 100 node', ''));
    const assertAdminMock = jest.fn(() => {
      const error = new Error('forbidden');
      error.code = 'ADMIN_REQUIRED';
      throw error;
    });

    jest.doMock('child_process', () => ({ execFile: execFileMock }));
    jest.doMock('util', () => ({
      promisify: () => async (...args) =>
        await new Promise((resolve, reject) => {
          execFileMock(...args, (error, stdout, stderr) => {
            if (error) {
              reject(error);
              return;
            }
            resolve({ stdout, stderr });
          });
        }),
    }));
    jest.doMock('~/server/utils/difyConsoleConfig', () => ({
      readDifyConsoleConfig: () => ({ sandboxTools: { allowProcessList: true } }),
    }));
    jest.doMock('./requester', () => ({
      assertAdmin: assertAdminMock,
      createSandboxAccessError: (message, code, status) => Object.assign(new Error(message), { code, status }),
    }));

    const { processList } = require('./processList');
    await expect(processList({ requester: { role: 'USER' } })).rejects.toMatchObject({
      code: 'ADMIN_REQUIRED',
    });
  });
});
