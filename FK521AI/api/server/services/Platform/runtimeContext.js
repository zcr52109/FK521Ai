const { getVerifiedModelIdentity } = require('./identity');
const { getCachedRuntimePolicySnapshot } = require('~/server/services/RuntimePolicy');

const WORKSPACE_VIRTUAL_ROOT = '/workspace';
const WORKSPACE_VIRTUAL_PATHS = Object.freeze({
  root: WORKSPACE_VIRTUAL_ROOT,
  uploads: `${WORKSPACE_VIRTUAL_ROOT}/uploads`,
  workdir: `${WORKSPACE_VIRTUAL_ROOT}/workdir`,
  projects: `${WORKSPACE_VIRTUAL_ROOT}/projects`,
  outputs: `${WORKSPACE_VIRTUAL_ROOT}/outputs`,
  manifests: `${WORKSPACE_VIRTUAL_ROOT}/manifests`,
  uploadManifest: `${WORKSPACE_VIRTUAL_ROOT}/manifests/uploaded-files.json`,
});

const WORKSPACE_TOOL_NAMES = Object.freeze([
  'workspace_list',
  'workspace_read',
  'workspace_write',
  'workspace_stat',
  'workspace_delete',
  'workspace_glob',
  'workspace_grep_search',
  'workspace_search_replace',
  'workspace_read_todo',
  'workspace_write_todo',
  'workspace_task_summary',
  'workspace_extract_archive',
  'workspace_create_archive',
  'archive_inspect',
  'archive_validate',
  'sandbox_info',
  'workspace_purge',
  'content_scan',
  'policy_audit_log',
  'web_fetch',
  'process_list',
  'host_filesystem_access',
  'database_connect',
  'pdf_parse',
  'docx_parse',
  'markdown_ast',
  'code_ast',
  'code_parse',
  'convert_pdf_to_text',
  'convert_docx_to_md',
  'json_to_yaml',
  'yaml_to_json',
  'workspace_grep',
  'search_in_files',
  'fuzzy_search',
  'detect_dependencies',
  'parse_package_json',
  'list_pip_requirements',
  'scan_maven_pom',
  'scan_cargo_toml',
  'sbom_generate',
  'cve_lookup',
  'oss_license_scan',
  'binary_analysis',
  'dns_resolve',
  'port_check',
  'curl_head_only',
  'http_headers_inspect',
  'run_unit_tests',
  'validate_json_schema',
  'check_openapi_spec',
  'lint_yaml',
]);

const TOOL_PURPOSES = Object.freeze({
  workspace_list: 'list directories',
  workspace_read: 'read files',
  workspace_write: 'write files',
  workspace_stat: 'inspect file metadata',
  workspace_delete: 'delete files',
  workspace_glob: 'glob file paths',
  workspace_grep_search: 'grep file content',
  workspace_search_replace: 'search and replace',
  workspace_read_todo: 'read task todo list',
  workspace_write_todo: 'write task todo list',
  workspace_task_summary: 'summarize tasks',
  workspace_extract_archive: 'extract archives',
  workspace_create_archive: 'package archives',
  archive_inspect: 'preview archive members',
  archive_validate: 'check archive integrity',
  sandbox_info: 'show sandbox state',
  workspace_purge: 'clear temporary workdir data',
  content_scan: 'scan text patterns',
  policy_audit_log: 'read policy events',
  web_fetch: 'fetch approved web pages',
  process_list: 'list sandbox processes',
  host_filesystem_access: 'restricted host files',
  database_connect: 'connect to approved databases',
  pdf_parse: 'parse PDFs',
  docx_parse: 'parse DOCX files',
  markdown_ast: 'parse Markdown structure',
  code_ast: 'parse code AST',
  code_parse: 'parse source files',
  convert_pdf_to_text: 'convert PDF to text',
  convert_docx_to_md: 'convert DOCX to Markdown',
  json_to_yaml: 'convert JSON to YAML',
  yaml_to_json: 'convert YAML to JSON',
  workspace_grep: 'grep across files',
  search_in_files: 'search file content',
  fuzzy_search: 'fuzzy file search',
  detect_dependencies: 'detect dependencies',
  parse_package_json: 'inspect package.json',
  list_pip_requirements: 'inspect Python requirements',
  scan_maven_pom: 'inspect Maven POM',
  scan_cargo_toml: 'inspect Cargo.toml',
  sbom_generate: 'generate SBOM',
  cve_lookup: 'look up CVEs',
  oss_license_scan: 'scan OSS licenses',
  binary_analysis: 'inspect binaries',
  dns_resolve: 'resolve DNS',
  port_check: 'check network ports',
  curl_head_only: 'fetch HTTP headers',
  http_headers_inspect: 'inspect HTTP headers',
  run_unit_tests: 'run unit tests',
  validate_json_schema: 'validate JSON schema',
  check_openapi_spec: 'validate OpenAPI spec',
  lint_yaml: 'lint YAML files',
});

function normalizeToolNames(toolNames = []) {
  return [...new Set((toolNames || []).filter(Boolean).map((name) => String(name).trim()))].sort();
}

function buildCapabilityManifest({ toolNames = [], workspaceRoot = WORKSPACE_VIRTUAL_ROOT } = {}) {
  const normalizedToolNames = normalizeToolNames(toolNames);
  return {
    workspaceRoot,
    tools: normalizedToolNames,
    permissions: {
      readUploads:
        normalizedToolNames.includes('workspace_read') || normalizedToolNames.includes('workspace_stat'),
      listWorkspace: normalizedToolNames.includes('workspace_list'),
      writeWorkspace: normalizedToolNames.includes('workspace_write'),
      deleteWorkspace: normalizedToolNames.includes('workspace_delete'),
      archiveAccess:
        normalizedToolNames.includes('workspace_extract_archive') ||
        normalizedToolNames.includes('workspace_create_archive') ||
        normalizedToolNames.includes('archive_inspect') ||
        normalizedToolNames.includes('archive_validate'),
      sandboxIntrospection:
        normalizedToolNames.includes('sandbox_info') || normalizedToolNames.includes('policy_audit_log'),
      purgeWorkspace: normalizedToolNames.includes('workspace_purge'),
      contentScan: normalizedToolNames.includes('content_scan'),
      webFetch: normalizedToolNames.includes('web_fetch'),
      processList: normalizedToolNames.includes('process_list'),
      hostFilesystemAccess: normalizedToolNames.includes('host_filesystem_access'),
      databaseConnect: normalizedToolNames.includes('database_connect'),
      structuredParsing:
        normalizedToolNames.includes('pdf_parse') ||
        normalizedToolNames.includes('docx_parse') ||
        normalizedToolNames.includes('markdown_ast') ||
        normalizedToolNames.includes('code_ast') ||
        normalizedToolNames.includes('code_parse'),
      formatConversion:
        normalizedToolNames.includes('convert_pdf_to_text') ||
        normalizedToolNames.includes('convert_docx_to_md') ||
        normalizedToolNames.includes('json_to_yaml') ||
        normalizedToolNames.includes('yaml_to_json'),
      multiFileSearch:
        normalizedToolNames.includes('workspace_glob') ||
        normalizedToolNames.includes('workspace_grep_search') ||
        normalizedToolNames.includes('workspace_search_replace') ||
        normalizedToolNames.includes('workspace_grep') ||
        normalizedToolNames.includes('search_in_files') ||
        normalizedToolNames.includes('fuzzy_search'),
      dependencyAnalysis:
        normalizedToolNames.includes('detect_dependencies') ||
        normalizedToolNames.includes('parse_package_json') ||
        normalizedToolNames.includes('list_pip_requirements') ||
        normalizedToolNames.includes('scan_maven_pom') ||
        normalizedToolNames.includes('scan_cargo_toml'),
      supplyChainAnalysis:
        normalizedToolNames.includes('sbom_generate') ||
        normalizedToolNames.includes('cve_lookup') ||
        normalizedToolNames.includes('oss_license_scan') ||
        normalizedToolNames.includes('binary_analysis'),
      networkDiagnostics:
        normalizedToolNames.includes('dns_resolve') ||
        normalizedToolNames.includes('port_check') ||
        normalizedToolNames.includes('curl_head_only') ||
        normalizedToolNames.includes('http_headers_inspect'),
      validationAndTesting:
        normalizedToolNames.includes('run_unit_tests') ||
        normalizedToolNames.includes('validate_json_schema') ||
        normalizedToolNames.includes('check_openapi_spec') ||
        normalizedToolNames.includes('lint_yaml'),
    },
    security: {
      singleDirectionDataFlow: true,
      sideChannelHardened: true,
      realtimePolicyCheckPerCall: true,
      forbiddenCapabilities: ['shell_exec', 'system_command', 'network_bind'],
    },
  };
}

function compactToolSummary(toolNames = []) {
  const normalizedToolNames = normalizeToolNames(toolNames);
  if (normalizedToolNames.length === 0) {
    return 'none';
  }

  return normalizedToolNames
    .map((name) => `${name}: ${TOOL_PURPOSES[name] || 'available tool'}`)
    .join('; ');
}

function trimLines(lines = [], maxChars = 3400) {
  const output = [];
  let total = 0;
  for (const line of lines) {
    const value = String(line || '').trim();
    if (!value) {
      continue;
    }
    const nextSize = total + value.length + 1;
    if (nextSize > maxChars) {
      break;
    }
    output.push(value);
    total = nextSize;
  }
  return output.join('\n');
}

function buildCoreRuntimeInstruction({
  toolNames = [],
  workspaceRoot = WORKSPACE_VIRTUAL_ROOT,
  uploadManifestPath = WORKSPACE_VIRTUAL_PATHS.uploadManifest,
  additionalNotes = [],
  identityContext = {},
} = {}) {
  const identity = getVerifiedModelIdentity(identityContext);
  const policy = getCachedRuntimePolicySnapshot();
  const lines = [
    '<runtime>',
    `Role: FK521AI platform assistant (${identity.modelId || identity.assistantName}).`,
    `Policy: ${policy.policyVersion}/${policy.snapshotId}.`,
    `Workspace: root=${workspaceRoot}; uploads=${WORKSPACE_VIRTUAL_PATHS.uploads}; workdir=${WORKSPACE_VIRTUAL_PATHS.workdir}; projects=${WORKSPACE_VIRTUAL_PATHS.projects}; outputs=${WORKSPACE_VIRTUAL_PATHS.outputs}; manifest=${uploadManifestPath}.`,
    'File workflow: read relevant uploads before content claims; use workdir for temporary edits; write downloadable deliverables to outputs.',
    ...additionalNotes.map((note) => `Note: ${note}`),
    '</runtime>',
  ];

  return trimLines(lines, 3600);
}

module.exports = {
  WORKSPACE_TOOL_NAMES,
  WORKSPACE_VIRTUAL_ROOT,
  WORKSPACE_VIRTUAL_PATHS,
  TOOL_PURPOSES,
  buildCapabilityManifest,
  buildCoreRuntimeInstruction,
  compactToolSummary,
  normalizeToolNames,
};
