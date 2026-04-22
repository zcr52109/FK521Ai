jest.mock('~/server/utils/difyConsoleConfig', () => ({
  readDifyConsoleConfig: jest.fn(),
}));

const { Constants } = require('fk521ai-data-provider');
const { readDifyConsoleConfig } = require('~/server/utils/difyConsoleConfig');
const {
  filterProgrammaticToolDefs,
  createLocalSandboxProgrammaticToolCallingTool,
} = require('./localSandboxTools');

describe('localSandboxTools programmatic bridge security', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('filterProgrammaticToolDefs only exposes explicitly allowed callers', () => {
    const defs = [
      { name: 'safe_tool', allowed_callers: ['code_execution'] },
      { name: 'not_allowed' },
      { name: 'also_not_allowed', allowed_callers: ['assistant'] },
    ];

    const filtered = filterProgrammaticToolDefs(defs);
    expect(filtered).toEqual([{ name: 'safe_tool', allowed_callers: ['code_execution'] }]);
  });

  test('createLocalSandboxProgrammaticToolCallingTool throws when bridge is disabled', () => {
    readDifyConsoleConfig.mockReturnValue({
      sandboxTools: {
        allowProgrammaticToolBridge: false,
      },
    });

    expect(() => createLocalSandboxProgrammaticToolCallingTool({ req: {} })).toThrow(
      'Programmatic tool bridge is disabled by configuration',
    );
  });

  test('createLocalSandboxProgrammaticToolCallingTool succeeds when bridge is enabled', () => {
    readDifyConsoleConfig.mockReturnValue({
      sandboxTools: {
        allowProgrammaticToolBridge: true,
      },
    });

    const tool = createLocalSandboxProgrammaticToolCallingTool({ req: {} });
    expect(tool.name).toBe(Constants.PROGRAMMATIC_TOOL_CALLING);
  });
});
