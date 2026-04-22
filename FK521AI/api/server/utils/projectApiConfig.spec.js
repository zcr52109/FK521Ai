
jest.mock('~/server/utils/managedModelStyles', () => ({
  getStyleText: jest.fn(() => ''),
}), { virtual: true });

jest.mock('~/server/services/Platform/identity', () => ({
  getPlatformAssistantName: jest.fn(() => 'FK521AI'),
}), { virtual: true });

const fs = require('fs');
const os = require('os');
const path = require('path');

describe('projectApiConfig managed model rules', () => {
  let tempDir;
  let configPath;
  let projectApiConfig;

  beforeEach(() => {
    jest.resetModules();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fk521-project-api-'));
    configPath = path.join(tempDir, 'project-apis.json');
    process.env.FK521_PROJECT_APIS_PATH = configPath;
    projectApiConfig = require('./projectApiConfig');
  });

  afterEach(() => {
    delete process.env.FK521_PROJECT_APIS_PATH;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('preserves model version when normalizing project APIs', () => {
    const [item] = projectApiConfig.normalizeProjectApis([
      {
        name: 'FK521 Model Hub',
        provider: 'custom',
        baseURL: 'https://example.com/v1',
        apiKey: 'test-key',
        enabled: true,
        modelConfigs: [
          {
            name: 'deepseek-chat',
            label: 'DeepSeek Chat',
            version: '2026.04',
            default: true,
            enabled: true,
          },
        ],
      },
    ]);

    expect(item.modelConfigs).toHaveLength(1);
    expect(item.modelConfigs[0].version).toBe('2026.04');
    expect(item.defaultModel).toBe('deepseek-chat');
  });

  it('exposes model version in managed model specs preset metadata', () => {
    projectApiConfig.writeProjectApis(
      projectApiConfig.normalizeProjectApis([
        {
          name: 'FK521 Model Hub',
          provider: 'custom',
          baseURL: 'https://example.com/v1',
          apiKey: 'test-key',
          enabled: true,
          modelConfigs: [
            {
              name: 'deepseek-chat',
              label: 'DeepSeek Chat',
              version: '2026.04',
              default: true,
              enabled: true,
            },
          ],
        },
      ]),
    );

    const specs = projectApiConfig.loadManagedModelSpecs();
    expect(specs).toHaveLength(1);
    expect(specs[0].preset.modelVersion).toBe('2026.04');
    expect(specs[0].version).toBe('2026.04');
  });


  it('normalizes aliases and provider presets for managed models', () => {
    const [item] = projectApiConfig.normalizeProjectApis([
      {
        name: 'Qwen Hub',
        provider: 'ali',
        enabled: true,
        modelConfigs: [
          {
            name: 'qwen-plus',
            label: '通义千问 Plus',
            version: '2026.04',
            aliases: ['通义千问', 'Qwen', 'qwen-plus', 'Qwen'],
            default: true,
            enabled: true,
          },
        ],
      },
    ]);

    expect(item.provider).toBe('aliyun');
    expect(item.baseURL).toBe('https://dashscope.aliyuncs.com/compatible-mode/v1');
    expect(item.modelConfigs[0].aliases).toEqual(['通义千问', 'Qwen']);
  });

  it('allows multiple enabled models globally', () => {
    const items = projectApiConfig.normalizeProjectApis([
      {
        name: 'Model A',
        provider: 'custom',
        baseURL: 'https://example.com/v1',
        apiKey: 'key-a',
        enabled: true,
        modelConfigs: [
          {
            name: 'model-a',
            label: 'Model A',
            default: true,
            enabled: true,
          },
        ],
      },
      {
        name: 'Model B',
        provider: 'custom',
        baseURL: 'https://example.com/v1',
        apiKey: 'key-b',
        enabled: true,
        modelConfigs: [
          {
            name: 'model-b',
            label: 'Model B',
            default: true,
            enabled: true,
          },
        ],
      },
    ]);

    const enabledItems = items.filter((item) => item.enabled === true);
    const enabledModels = items.flatMap((item) => (item.modelConfigs || []).filter((model) => model.enabled === true));

    expect(enabledItems).toHaveLength(2);
    expect(enabledModels).toHaveLength(2);
    expect(enabledItems.map((item) => item.name)).toEqual(['Model A', 'Model B']);
    expect(enabledModels.map((model) => model.name)).toEqual(['model-a', 'model-b']);
  });

  it('resolves managed model aliases by endpoint name', () => {
    projectApiConfig.writeProjectApis(
      projectApiConfig.normalizeProjectApis([
        {
          name: 'Moonshot Hub',
          provider: 'moonshot',
          baseURL: 'https://api.moonshot.cn/v1',
          apiKey: 'test-key',
          enabled: true,
          modelConfigs: [
            {
              name: 'moonshot-v1-8k',
              label: 'Moonshot 8K',
              aliases: ['kimi-8k', 'moonshot-8k'],
              default: true,
              enabled: true,
            },
          ],
        },
      ]),
    );

    const endpoint = projectApiConfig.findProjectApiByName('Moonshot Hub');
    const matched = projectApiConfig.findManagedModelConfig(endpoint, 'kimi-8k');

    expect(endpoint?.name).toBe('Moonshot Hub');
    expect(matched?.name).toBe('moonshot-v1-8k');
  });

  it('masks API keys for admin responses', () => {
    const [item] = projectApiConfig.normalizeProjectApis([
      {
        name: 'Secure Hub',
        provider: 'custom',
        baseURL: 'https://example.com/v1',
        apiKey: 'sk-secret-1234567890',
        enabled: true,
        modelConfigs: [{ name: 'secure-model', default: true, enabled: true }],
      },
    ]);

    const [sanitized] = projectApiConfig.sanitizeProjectApisForAdmin([item]);

    expect(sanitized.hasApiKey).toBe(true);
    expect(sanitized.apiKey).not.toBe(item.apiKey);
    expect(projectApiConfig.isMaskedApiKeyValue(sanitized.apiKey)).toBe(true);
  });
});
