describe('fail-closed runtime stubs', () => {
  test('docker executor throws explicit unavailable error', async () => {
    const { executeDockerSandbox } = require('~/server/services/Sandbox/dockerExecutor');
    await expect(executeDockerSandbox({})).rejects.toMatchObject({
      code: 'SANDBOX_EXECUTOR_UNAVAILABLE',
    });
  });

  test('file processing stubs throw explicit unavailable errors', async () => {
    const { processFileURL, uploadImageBuffer } = require('~/server/services/Files/process');
    await expect(processFileURL()).rejects.toMatchObject({ code: 'FILES_PROCESS_UNAVAILABLE' });
    await expect(uploadImageBuffer()).rejects.toMatchObject({ code: 'FILES_UPLOAD_UNAVAILABLE' });
  });

  test('code output processing stub throws explicit unavailable error', async () => {
    const { processCodeOutput } = require('~/server/services/Files/Code/process');
    await expect(processCodeOutput()).rejects.toMatchObject({ code: 'CODE_PROCESS_UNAVAILABLE' });
  });
});
