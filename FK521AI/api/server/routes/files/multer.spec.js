jest.mock('multer', () => {
  const factory = jest.fn(() => ({ single: jest.fn() }));
  factory.memoryStorage = jest.fn(() => ({}));
  return factory;
}, { virtual: true });

jest.mock('fk521ai-data-provider', () => ({
  mergeFileConfig: jest.fn((config) => ({ limits: { fileSize: 1234 }, ...config })),
  inferMimeType: jest.fn(() => 'application/octet-stream'),
  getEndpointFileConfig: jest.fn(() => ({})),
  archiveExtensionRegex: /\.(zip|tar|gz)$/i,
  fileConfig: { limits: { fileSize: 1234 } },
}), { virtual: true });

describe('multer init smoke', () => {
  test('createMulterInstance works with missing appConfig.fileConfig', () => {
    const { createMulterInstance } = require('./multer');
    const instance = createMulterInstance({});
    expect(instance).toBeTruthy();
  });

  test('createMulterInstance works with explicit appConfig.fileConfig', () => {
    const { createMulterInstance } = require('./multer');
    const instance = createMulterInstance({
      fileConfig: { limits: { fileSize: 4096 } },
    });
    expect(instance).toBeTruthy();
  });
});
