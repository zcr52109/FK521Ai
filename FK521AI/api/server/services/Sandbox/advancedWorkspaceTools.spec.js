const {
  parseRequirementsText,
  parsePackageJsonObject,
  parsePomXmlText,
  parseCargoTomlText,
  parsePyProjectTomlText,
  buildMarkdownAstFallback,
  scoreFuzzyMatch,
  validateAgainstSchema,
  runUnitTests,
  dnsResolve,
} = require('./advancedWorkspaceTools');

describe('advancedWorkspaceTools helper parsers', () => {
  test('parseRequirementsText 解析 requirements 与 include', () => {
    const parsed = parseRequirementsText(`
# base deps
requests==2.31.0
numpy>=1.26
-r dev-requirements.txt

flask
`);

    expect(parsed.dependencies).toEqual([
      { name: 'requests', version: '2.31.0', specifier: '==' },
      { name: 'numpy', version: '1.26', specifier: '>=' },
      { name: 'flask', version: null, specifier: null },
    ]);
    expect(parsed.includes).toEqual(['dev-requirements.txt']);
  });

  test('parsePackageJsonObject 提取多类 npm 依赖与许可信息', () => {
    const parsed = parsePackageJsonObject({
      name: 'demo-app',
      version: '1.2.3',
      license: 'MIT',
      dependencies: { react: '^18.3.0' },
      devDependencies: { vite: '^5.4.0' },
      peerDependencies: { typescript: '^5.6.0' },
    });

    expect(parsed.packageName).toBe('demo-app');
    expect(parsed.version).toBe('1.2.3');
    expect(parsed.license).toBe('MIT');
    expect(parsed.dependencies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'react', version: '^18.3.0', scope: 'dependencies' }),
        expect.objectContaining({ name: 'vite', version: '^5.4.0', scope: 'devDependencies' }),
        expect.objectContaining({ name: 'typescript', version: '^5.6.0', scope: 'peerDependencies' }),
      ]),
    );
  });

  test('parsePomXmlText 提取 maven 坐标与依赖', () => {
    const parsed = parsePomXmlText(`
<project>
  <modelVersion>4.0.0</modelVersion>
  <groupId>com.example</groupId>
  <artifactId>demo-service</artifactId>
  <version>1.0.0</version>
  <dependencies>
    <dependency>
      <groupId>org.springframework</groupId>
      <artifactId>spring-core</artifactId>
      <version>6.1.0</version>
    </dependency>
  </dependencies>
</project>
`);

    expect(parsed.groupId).toBe('com.example');
    expect(parsed.artifactId).toBe('demo-service');
    expect(parsed.version).toBe('1.0.0');
    expect(parsed.dependencies).toEqual([
      {
        groupId: 'org.springframework',
        artifactId: 'spring-core',
        version: '6.1.0',
        scope: null,
      },
    ]);
  });

  test('parseCargoTomlText 与 parsePyProjectTomlText 提取 Rust/Python 依赖', () => {
    const cargo = parseCargoTomlText(`
[package]
name = "demo-crate"
version = "0.4.0"
license = "Apache-2.0"

[dependencies]
serde = "1.0"
tokio = { version = "1.38", features = ["rt-multi-thread"] }
`);

    expect(cargo.packageName).toBe('demo-crate');
    expect(cargo.version).toBe('0.4.0');
    expect(cargo.license).toBe('Apache-2.0');
    expect(cargo.dependencies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'serde', version: '1.0' }),
        expect.objectContaining({ name: 'tokio', version: '1.38' }),
      ]),
    );

    const pyproject = parsePyProjectTomlText(`
[project]
name = "demo-pkg"
version = "0.9.0"
dependencies = [
  "fastapi>=0.110",
  "uvicorn==0.30.0"
]
`);

    expect(pyproject.packageName).toBe('demo-pkg');
    expect(pyproject.version).toBe('0.9.0');
    expect(pyproject.dependencies).toEqual([
      { name: 'fastapi', version: '0.110', specifier: '>=' },
      { name: 'uvicorn', version: '0.30.0', specifier: '==' },
    ]);
  });

  test('buildMarkdownAstFallback 生成基础 md AST', () => {
    const ast = buildMarkdownAstFallback('# 标题\n\n第一段\n\n- a\n- b');
    expect(ast.type).toBe('root');
    expect(ast.children[0]).toEqual(expect.objectContaining({ type: 'heading', depth: 1 }));
    expect(ast.children.some((node) => node.type === 'list')).toBe(true);
  });

  test('scoreFuzzyMatch 对近似命中应高于无关文本', () => {
    const exactish = scoreFuzzyMatch('workspace grep', '/workspace/projects/workspace-grep.js');
    const unrelated = scoreFuzzyMatch('workspace grep', 'binary entropy report');

    expect(exactish).toBeGreaterThan(unrelated);
    expect(exactish).toBeGreaterThan(0.5);
  });

  test('validateAgainstSchema 支持对象必填项校验', () => {
    const schema = {
      type: 'object',
      required: ['name', 'count'],
      properties: {
        name: { type: 'string' },
        count: { type: 'number' },
      },
    };

    expect(validateAgainstSchema(schema, { name: 'ok', count: 2 })).toEqual([]);
    expect(validateAgainstSchema(schema, { name: 'missing-count' })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'MISSING_REQUIRED', path: '$.count' }),
      ]),
    );
  });

  test('runUnitTests 默认 fail-closed 禁用宿主执行', async () => {
    await expect(runUnitTests({ conversationId: 'convo-1' })).rejects.toMatchObject({
      code: 'RUN_TESTS_DISABLED',
      status: 403,
    });
  });

  test('dnsResolve 默认禁用宿主网络工具', async () => {
    await expect(dnsResolve({ hostname: 'example.com' })).rejects.toMatchObject({
      code: 'HOST_NETWORK_TOOLS_DISABLED',
      status: 403,
    });
  });
});
