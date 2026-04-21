const path = require('path');
const { tool } = require('@langchain/core/tools');
const {
  workspaceList,
  workspaceRead,
  workspaceWrite,
  workspaceDelete,
  workspaceGlobFind,
  workspaceGrepSearch,
  workspaceSearchReplace,
  workspaceReadTodo,
  workspaceWriteTodo,
  workspaceTaskSummary,
  workspaceStat,
  workspaceExtractArchive,
  workspaceCreateArchive,
  archiveInspect,
  archiveValidate,
  sandboxInfo,
  workspacePurge,
  policyAuditLog,
  listSandboxProcesses,
  accessHostFilesystem,
  connectDatabase,
} = require('~/server/services/Sandbox/workspaceFs');
const { contentScan } = require('~/server/services/Sandbox/contentScan');
const { webFetch } = require('~/server/services/Sandbox/webFetch');
const {
  pdfParse,
  docxParse,
  markdownAst,
  codeAst,
  convertPdfToText,
  convertDocxToMd,
  jsonToYaml,
  yamlToJson,
  workspaceGrep,
  searchInFiles,
  fuzzySearch,
  detectDependencies,
  parsePackageJson,
  listPipRequirements,
  scanMavenPom,
  scanCargoToml,
  sbomGenerate,
  cveLookup,
  ossLicenseScan,
  binaryAnalysis,
  dnsResolve,
  portCheck,
  curlHeadOnly,
  httpHeadersInspect,
  validateJsonSchemaTool,
  checkOpenApiSpec,
  lintYaml,
  runUnitTests,
} = require('~/server/services/Sandbox/advancedWorkspaceTools');
const { WORKSPACE_VIRTUAL_PATHS } = require('~/server/services/Platform/runtimeContext');
const { createSandboxDownloadLink } = require('~/server/services/DownloadLinks');
const { getRuntimePolicySnapshot } = require('~/server/services/RuntimePolicy');
const { buildRequesterContext } = require('~/server/services/Sandbox/requester');

const ALL_WORKSPACE_TOOL_NAMES = Object.freeze([
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

const WORKSPACE_TOOL_DESCRIPTIONS = Object.freeze({
  workspace_list:
    'List files and directories inside the conversation-isolated virtual workspace. Start with /workspace/uploads to verify uploaded files exist before reading them.',
  workspace_read:
    'Read a file from the conversation-isolated virtual workspace. Supports range and encoding so large uploaded files can be read safely on demand.',
  workspace_write:
    'Create or overwrite a real file inside the conversation-isolated virtual workspace. Write temporary files under /workspace/workdir and user-downloadable deliverables under /workspace/outputs. Files written under /workspace/outputs should be returned with a download_url.',
  workspace_stat:
    'Get metadata for a file or directory inside the conversation-isolated virtual workspace, including size, timestamps, permission, and content hash for files.',
  workspace_delete:
    'Delete a workspace file or directory. Directory deletion requires recursive=true.',
  workspace_glob:
    'Run glob pattern matching in workspace directories and return matched file paths.',
  workspace_grep_search:
    'Search file content across workspace directories with plain text or regex query, returning paginated results (cursor/pageSize).',
  workspace_search_replace:
    'Perform in-file search and replace with optional regex and case sensitivity controls.',
  workspace_read_todo:
    'Read structured todo items maintained for the current workspace conversation.',
  workspace_write_todo:
    'Write structured todo items for the current workspace conversation.',
  workspace_task_summary:
    'Summarize task completion progress based on workspace todo records.',
  workspace_extract_archive:
    'Extract a zip/tar/tar.gz/tgz/tar.bz2/tar.xz archive only after archive_inspect and archive_validate pass. Reject dangerous paths, deep nesting, encrypted entries, risky extensions, and integrity failures.',
  workspace_create_archive:
    'Create a zip or tar-family archive from a workspace file or directory and write the resulting archive to /workspace/outputs or /workspace/workdir. Archive creation is available by default inside the isolated workspace.',
  archive_inspect:
    'Inspect a workspace archive without extracting it. Return member paths, sizes, compression metadata, encryption flags, dangerous path indicators, nesting depth, dangerous extensions, and archive-bomb heuristics.',
  archive_validate:
    'Validate archive integrity before extraction. Check structure consistency, duplicate or empty names, dangerous paths, archive SHA256, and CRC/integrity status when the format supports it.',
  sandbox_info:
    'Return administrator-only desensitized sandbox runtime status. Do not expose exact disk, memory, or timeout values to non-admin callers.',
  workspace_purge:
    'Administrator-only purge for temporary files under /workspace/workdir. Use dryRun first to preview deletions while preserving uploads, outputs, extracted projects, and manifests.',
  content_scan:
    'Perform a lightweight security scan on workspace text/code files or inline text. Detect secrets, PII, risky code functions, suspicious URLs, and obfuscation indicators.',
  policy_audit_log:
    'Return session-level or administrator-approved global tool audit records, including tool names, summarized arguments, summarized results, timestamps, and policy outcomes.',
  web_fetch:
    'Fetch a web page or HTTP API response using the runtime network policy. Requests must match the administrator whitelist and obey hard timeout/size limits; redirects and private/internal addresses are blocked.',
  process_list:
    'List processes visible inside the current sandbox/runtime scope for diagnostics. Returns limited metadata only and never exposes full command lines or other sessions.',
  host_filesystem_access:
    'Administrator-only privileged access to whitelisted host filesystem paths. Use only for approved persistence, shared cache, or audit-log aggregation paths.',
  database_connect:
    'Connect to an administrator-approved PostgreSQL, MySQL, or SQLite data source for controlled ETL/reporting/test workflows. Prefer readOnly mode and least privilege.',
  pdf_parse:
    'Parse a PDF file into structured page text so uploaded PDFs become machine-readable instead of opaque blobs.',
  docx_parse:
    'Parse a DOCX file into extracted text sections and document-level metadata.',
  markdown_ast:
    'Parse Markdown into a structured syntax tree or fallback outline for downstream semantic analysis.',
  code_ast:
    'Parse source code or structured text into an abstract syntax tree when the language parser is available.',
  code_parse:
    'Alias of code_ast for structured source parsing workflows.',
  convert_pdf_to_text:
    'Extract plain text from a PDF file and optionally write the result into the workspace.',
  convert_docx_to_md:
    'Convert a DOCX document to Markdown and optionally save the converted file into the workspace.',
  json_to_yaml:
    'Convert JSON text or files into YAML with safe serialization.',
  yaml_to_json:
    'Convert YAML text or files into pretty-printed JSON with safe parsing.',
  workspace_grep:
    'Search across many workspace files by keyword or regular expression and return line-level matches.',
  search_in_files:
    'Alias of workspace_grep for cross-file search workflows.',
  fuzzy_search:
    'Perform fuzzy filename and content search across multiple workspace files when exact matching is not enough.',
  detect_dependencies:
    'Detect dependency manifests such as package.json, requirements.txt, pyproject.toml, pom.xml, and Cargo.toml and extract normalized dependencies.',
  parse_package_json:
    'Parse package.json and extract dependencies, versions, package metadata, and declared license.',
  list_pip_requirements:
    'Parse requirements.txt style files and return normalized Python dependency records.',
  scan_maven_pom:
    'Parse pom.xml and extract Maven coordinates, dependency versions, scopes, and resolved properties.',
  scan_cargo_toml:
    'Parse Cargo.toml and extract Rust package metadata and dependency sections.',
  sbom_generate:
    'Generate a CycloneDX-style SBOM from detected workspace dependency manifests and optionally save it as a file.',
  cve_lookup:
    'Query vulnerability data for package components and versions through OSV batch lookups.',
  oss_license_scan:
    'Scan workspace manifests and license files to summarize open-source license declarations and detected license texts.',
  binary_analysis:
    'Inspect binary files for hashes, entropy, magic bytes, printable strings, and inferred binary format.',
  dns_resolve:
    'Resolve public DNS records for a hostname while blocking localhost and private-network targets.',
  port_check:
    'Check TCP reachability for a public host and port with timeout control.',
  curl_head_only:
    'Issue an HTTP HEAD request to inspect headers without downloading the response body.',
  http_headers_inspect:
    'Alias of curl_head_only for HTTP header inspection workflows.',
  run_unit_tests:
    'Run unit tests inside the isolated workspace directory and return exit code plus captured stdout/stderr.',
  validate_json_schema:
    'Validate JSON data against a JSON Schema using the built-in schema validator.',
  check_openapi_spec:
    'Parse and statically validate an OpenAPI or Swagger document for required top-level structures and response definitions.',
  lint_yaml:
    'Lint YAML for parse errors, tabs, trailing spaces, and basic formatting issues.',
});

const listSchema = {
  type: 'object',
  properties: {
    prefix: {
      type: 'string',
      description: 'Workspace path prefix to list. Defaults to /workspace.',
    },
  },
  additionalProperties: false,
};

const readSchema = {
  type: 'object',
  properties: {
    path: {
      type: 'string',
      description: 'Absolute or relative virtual workspace path to read, such as /workspace/uploads/report.pdf.',
    },
    range: {
      type: 'object',
      properties: {
        start: { type: 'integer', minimum: 0 },
        end: { type: 'integer', minimum: 0 },
      },
      additionalProperties: false,
    },
    encoding: {
      type: 'string',
      enum: ['utf8', 'base64'],
      description: 'Return textual utf8 content or base64 bytes.',
    },
  },
  required: ['path'],
  additionalProperties: false,
};

const writeSchema = {
  type: 'object',
  properties: {
    path: {
      type: 'string',
      description: 'Absolute or relative virtual workspace path to write, such as /workspace/workdir/fix.patch or /workspace/outputs/build.zip.',
    },
    content: {
      type: 'string',
      description: 'Text content to write. Use base64 when encoding=base64.',
    },
    overwrite: {
      type: 'boolean',
      description: 'Whether to overwrite an existing file. Defaults to true.',
    },
    encoding: {
      type: 'string',
      enum: ['utf8', 'base64'],
      description: 'Interpret content as utf8 text or base64 bytes.',
    },
  },
  required: ['path', 'content'],
  additionalProperties: false,
};

const statSchema = {
  type: 'object',
  properties: {
    path: {
      type: 'string',
      description: 'Absolute or relative virtual workspace path to inspect.',
    },
  },
  required: ['path'],
  additionalProperties: false,
};

const deleteSchema = {
  type: 'object',
  properties: {
    path: { type: 'string', description: 'Workspace path to delete.' },
    recursive: { type: 'boolean', description: 'Required for directory deletion.' },
  },
  required: ['path'],
  additionalProperties: false,
};

const globSchema = {
  type: 'object',
  properties: {
    rootPath: { type: 'string', description: 'Workspace root path for glob search.' },
    pattern: { type: 'string', description: 'Glob pattern, for example **/*.js.' },
    includeHidden: { type: 'boolean' },
    maxResults: { type: 'integer', minimum: 1, maximum: 2000 },
  },
  required: ['pattern'],
  additionalProperties: false,
};

const grepSearchSchema = {
  type: 'object',
  properties: {
    rootPath: { type: 'string' },
    query: { type: 'string' },
    caseSensitive: { type: 'boolean' },
    regex: { type: 'boolean' },
    cursor: { type: 'string', description: 'Opaque pagination cursor from previous page.' },
    pageSize: { type: 'integer', minimum: 1, maximum: 1000, description: 'Number of matches returned in this page.' },
    maxResults: { type: 'integer', minimum: 1, maximum: 20000, description: 'Upper bound of scan matches for safety.' },
  },
  required: ['query'],
  additionalProperties: false,
};

const searchReplaceSchema = {
  type: 'object',
  properties: {
    path: { type: 'string' },
    search: { type: 'string' },
    replace: { type: 'string' },
    regex: { type: 'boolean' },
    caseSensitive: { type: 'boolean' },
    replaceAll: { type: 'boolean' },
  },
  required: ['path', 'search'],
  additionalProperties: false,
};

const todoReadSchema = {
  type: 'object',
  properties: {},
  additionalProperties: false,
};

const todoWriteSchema = {
  type: 'object',
  properties: {
    todos: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          done: { type: 'boolean' },
          priority: { type: 'string' },
        },
        required: ['title'],
        additionalProperties: false,
      },
    },
  },
  required: ['todos'],
  additionalProperties: false,
};

const extractArchiveSchema = {
  type: 'object',
  properties: {
    archivePath: {
      type: 'string',
      description: 'Path to the archive file, such as /workspace/uploads/project.zip or /workspace/workdir/source.tar.gz.',
    },
    destinationPath: {
      type: 'string',
      description: 'Target directory path where the archive should be extracted.',
    },
    format: {
      type: 'string',
      description: 'Optional explicit archive format: zip, tar, tar.gz, tgz, tar.bz2, tar.xz.',
    },
  },
  required: ['archivePath', 'destinationPath'],
  additionalProperties: false,
};

const createArchiveSchema = {
  type: 'object',
  properties: {
    sourcePath: {
      type: 'string',
      description: 'Workspace file or directory to archive.',
    },
    includePaths: {
      type: 'array',
      items: {
        type: 'string',
      },
      minItems: 1,
      description:
        'Optional explicit file/directory list to include in the archive. When present, sourcePath is treated as a base root for resolving relative items.',
    },
    outputPath: {
      type: 'string',
      description: 'Workspace output file path, usually under /workspace/outputs.',
    },
    stripTopLevel: {
      type: 'boolean',
      description:
        'When sourcePath is a directory, archive only its children (not the directory wrapper). Defaults to false.',
    },
    format: {
      type: 'string',
      description: 'Optional archive format override: zip, tar, tar.gz, tgz, tar.bz2, tar.xz.',
    },
  },
  required: ['sourcePath', 'outputPath'],
  additionalProperties: false,
};

const archiveInspectSchema = {
  type: 'object',
  properties: {
    path: {
      type: 'string',
      description: 'Workspace archive path to inspect, such as /workspace/uploads/source.zip.',
    },
    maxEntries: {
      type: 'integer',
      minimum: 1,
      maximum: 2000,
      description: 'Maximum number of member entries to return. Defaults to 500.',
    },
  },
  required: ['path'],
  additionalProperties: false,
};

const archiveValidateSchema = {
  type: 'object',
  properties: {
    path: {
      type: 'string',
      description: 'Workspace archive path to validate.',
    },
    expectedSha256: {
      type: 'string',
      description: 'Optional expected archive SHA256 to compare against the computed digest.',
    },
    includeMemberHashes: {
      type: 'boolean',
      description: 'Whether to compute per-member SHA256 hashes. Defaults to false.',
    },
  },
  required: ['path'],
  additionalProperties: false,
};

const sandboxInfoSchema = {
  type: 'object',
  properties: {},
  additionalProperties: false,
};

const workspacePurgeSchema = {
  type: 'object',
  properties: {
    dryRun: {
      type: 'boolean',
      description: 'When true, return what would be deleted without deleting it.',
    },
  },
  additionalProperties: false,
};

const contentScanSchema = {
  type: 'object',
  properties: {
    path: {
      type: 'string',
      description: 'Optional workspace file path to scan.',
    },
    text: {
      type: 'string',
      description: 'Optional inline text or code to scan instead of reading a workspace file.',
    },
    maxBytes: {
      type: 'integer',
      minimum: 1024,
      maximum: 5 * 1024 * 1024,
      description: 'Maximum bytes of text to scan. Defaults to 1 MiB.',
    },
    maxFindings: {
      type: 'integer',
      minimum: 1,
      maximum: 1000,
      description: 'Maximum number of findings to return. Defaults to 200.',
    },
  },
  additionalProperties: false,
};

const policyAuditLogSchema = {
  type: 'object',
  properties: {
    limit: {
      type: 'integer',
      minimum: 1,
      maximum: 500,
      description: 'Maximum number of recent audit log events to return. Defaults to 100.',
    },
    toolName: {
      type: 'string',
      description: 'Optional exact tool name filter.',
    },
    scope: {
      type: 'string',
      enum: ['session', 'global'],
      description: 'Use session for current conversation events; global is administrator-only.',
    },
    eventType: {
      type: 'string',
      description: 'Optional event type filter such as tool_call, tool_result, policy_block, or tool_error.',
    },
    policyResult: {
      type: 'string',
      description: 'Optional policy outcome filter such as CALL_TOOL, ALLOW, ASK_USER, BLOCK, or ERROR.',
    },
    reasonCode: {
      type: 'string',
      description: 'Optional exact reason-code filter.',
    },
  },
  additionalProperties: false,
};

const webFetchSchema = {
  type: 'object',
  properties: {
    url: {
      type: 'string',
      description: 'The http/https URL to fetch.',
    },
    method: {
      type: 'string',
      description: 'HTTP method. Defaults to GET.',
      enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'],
    },
  },
  required: ['url'],
  additionalProperties: false,
};


const processListSchema = {
  type: 'object',
  properties: {
    scope: {
      type: 'string',
      enum: ['sandbox', 'all_visible'],
      description: 'sandbox returns only the current runtime process tree; all_visible returns all visible processes if allowed by policy.',
    },
    maxProcesses: {
      type: 'integer',
      minimum: 1,
      maximum: 500,
      description: 'Maximum number of process records to return.',
    },
  },
  additionalProperties: false,
};

const hostFilesystemAccessSchema = {
  type: 'object',
  properties: {
    operation: {
      type: 'string',
      enum: ['stat', 'list', 'read', 'write', 'mkdir'],
      description: 'Host filesystem operation. This tool is administrator-only and restricted to whitelisted paths.',
    },
    path: {
      type: 'string',
      description: 'Absolute host filesystem path under an allowed whitelist root.',
    },
    range: {
      type: 'object',
      properties: {
        start: { type: 'integer', minimum: 0 },
        end: { type: 'integer', minimum: 0 },
      },
      additionalProperties: false,
    },
    encoding: {
      type: 'string',
      enum: ['utf8', 'base64'],
      description: 'Used for read/write operations.',
    },
    content: {
      type: 'string',
      description: 'Required for write operations. Use base64 when encoding is base64.',
    },
    overwrite: {
      type: 'boolean',
      description: 'Whether write may overwrite an existing file.',
    },
  },
  required: ['operation', 'path'],
  additionalProperties: false,
};

const databaseConnectSchema = {
  type: 'object',
  properties: {
    driver: {
      type: 'string',
      enum: ['sqlite', 'postgresql', 'mysql'],
      description: 'Database driver to use.',
    },
    connection: {
      type: 'object',
      description: 'Driver-specific connection settings. SQLite uses filename/path; PostgreSQL/MySQL use host/port/database/user/password.',
    },
    query: {
      type: 'string',
      description: 'SQL statement to execute. In readOnly mode only read statements are allowed.',
    },
    params: {
      description: 'Positional array or named-object query parameters.',
    },
    readOnly: {
      type: 'boolean',
      description: 'Defaults to true. Set false only for explicitly approved write workflows.',
    },
    maxRows: {
      type: 'integer',
      minimum: 1,
      maximum: 500,
      description: 'Maximum number of rows to return.',
    },
  },
  required: ['driver', 'connection', 'query'],
  additionalProperties: false,
};


const pathOnlySchema = {
  type: 'object',
  properties: {
    path: {
      type: 'string',
      description: 'Workspace file path to inspect or parse.',
    },
  },
  required: ['path'],
  additionalProperties: false,
};

const markdownAstSchema = {
  type: 'object',
  properties: {
    path: { type: 'string', description: 'Optional Markdown file path inside the workspace.' },
    text: { type: 'string', description: 'Optional inline Markdown text to parse.' },
  },
  additionalProperties: false,
};

const codeAstSchema = {
  type: 'object',
  properties: {
    path: { type: 'string', description: 'Optional source-code file path inside the workspace.' },
    code: { type: 'string', description: 'Optional inline source code.' },
    language: { type: 'string', description: 'Optional language hint such as python, javascript, typescript, json, yaml, or xml.' },
    maxNodes: { type: 'integer', minimum: 50, maximum: 5000, description: 'Maximum AST nodes to emit.' },
  },
  additionalProperties: false,
};

const conversionSchema = {
  type: 'object',
  properties: {
    path: { type: 'string', description: 'Source workspace file path to convert.' },
    outputPath: { type: 'string', description: 'Optional output file path, typically under /workspace/outputs or /workspace/workdir.' },
  },
  required: ['path'],
  additionalProperties: false,
};

const jsonYamlConversionSchema = {
  type: 'object',
  properties: {
    path: { type: 'string', description: 'Optional workspace file path.' },
    text: { type: 'string', description: 'Optional inline source text.' },
    outputPath: { type: 'string', description: 'Optional workspace output path.' },
  },
  additionalProperties: false,
};

const workspaceSearchSchema = {
  type: 'object',
  properties: {
    rootPath: { type: 'string', description: 'Workspace directory root to scan. Defaults to /workspace.' },
    query: { type: 'string', description: 'Exact query string to search for.' },
    regex: { type: 'string', description: 'Optional regular expression.' },
    caseSensitive: { type: 'boolean', description: 'Whether string/regex search is case-sensitive.' },
    includeExtensions: {
      type: 'array',
      items: { type: 'string' },
      description: 'Optional extension whitelist such as [".js", ".ts", ".md"].',
    },
    maxMatches: { type: 'integer', minimum: 1, maximum: 2000, description: 'Maximum matches to return.' },
    maxFiles: { type: 'integer', minimum: 1, maximum: 10000, description: 'Maximum files to scan.' },
  },
  additionalProperties: false,
};

const fuzzySearchSchema = {
  type: 'object',
  properties: {
    rootPath: { type: 'string', description: 'Workspace directory root to scan. Defaults to /workspace.' },
    query: { type: 'string', description: 'Fuzzy query to match against filenames and sampled contents.' },
    includeExtensions: { type: 'array', items: { type: 'string' } },
    maxResults: { type: 'integer', minimum: 1, maximum: 500 },
    maxFiles: { type: 'integer', minimum: 1, maximum: 10000 },
  },
  required: ['query'],
  additionalProperties: false,
};

const detectDependenciesSchema = {
  type: 'object',
  properties: {
    rootPath: { type: 'string', description: 'Workspace directory to inspect for dependency manifests.' },
    maxFiles: { type: 'integer', minimum: 1, maximum: 10000 },
  },
  additionalProperties: false,
};

const sbomGenerateSchema = {
  type: 'object',
  properties: {
    rootPath: { type: 'string', description: 'Workspace directory to scan for dependency manifests.' },
    outputPath: { type: 'string', description: 'Optional workspace file path to save the generated SBOM JSON.' },
  },
  additionalProperties: false,
};

const cveLookupSchema = {
  type: 'object',
  properties: {
    components: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          ecosystem: { type: 'string' },
          name: { type: 'string' },
          version: { type: 'string' },
        },
        required: ['name', 'version'],
        additionalProperties: true,
      },
    },
    ecosystem: { type: 'string', description: 'Fallback ecosystem when querying a single package.' },
    name: { type: 'string', description: 'Single package name.' },
    version: { type: 'string', description: 'Single package version.' },
  },
  additionalProperties: false,
};

const rootPathSchema = {
  type: 'object',
  properties: {
    rootPath: { type: 'string', description: 'Workspace directory root. Defaults to /workspace.' },
    maxFiles: { type: 'integer', minimum: 1, maximum: 10000 },
  },
  additionalProperties: false,
};

const dnsResolveSchema = {
  type: 'object',
  properties: {
    hostname: { type: 'string', description: 'Public hostname to resolve.' },
    recordType: { type: 'string', enum: ['A', 'AAAA', 'MX', 'TXT', 'NS', 'CNAME'] },
  },
  required: ['hostname'],
  additionalProperties: false,
};

const portCheckSchema = {
  type: 'object',
  properties: {
    host: { type: 'string', description: 'Public host or hostname to test.' },
    port: { type: 'integer', minimum: 1, maximum: 65535 },
    timeoutMs: { type: 'integer', minimum: 100, maximum: 30000 },
  },
  required: ['host', 'port'],
  additionalProperties: false,
};

const headRequestSchema = {
  type: 'object',
  properties: {
    url: { type: 'string', description: 'Public http/https URL to inspect with HEAD.' },
    timeoutMs: { type: 'integer', minimum: 100, maximum: 30000 },
  },
  required: ['url'],
  additionalProperties: false,
};

const validateJsonSchemaSchema = {
  type: 'object',
  properties: {
    schemaPath: { type: 'string', description: 'Optional workspace file path containing a JSON Schema document.' },
    schemaText: { type: 'string', description: 'Optional inline JSON Schema text.' },
    dataPath: { type: 'string', description: 'Optional workspace file path containing JSON instance data.' },
    dataText: { type: 'string', description: 'Optional inline JSON instance text.' },
  },
  additionalProperties: false,
};

const openApiCheckSchema = {
  type: 'object',
  properties: {
    path: { type: 'string', description: 'Optional workspace file path containing an OpenAPI document.' },
    text: { type: 'string', description: 'Optional inline OpenAPI JSON/YAML text.' },
  },
  additionalProperties: false,
};

const yamlLintSchema = {
  type: 'object',
  properties: {
    path: { type: 'string', description: 'Optional workspace YAML file path.' },
    text: { type: 'string', description: 'Optional inline YAML text.' },
  },
  additionalProperties: false,
};

const runUnitTestsSchema = {
  type: 'object',
  properties: {
    cwd: { type: 'string', description: 'Workspace directory to execute tests in. Defaults to /workspace.' },
    command: { type: 'string', description: 'Optional explicit test command such as npm, python3, cargo, mvn, or go.' },
    args: { type: 'array', items: { type: 'string' }, description: 'Optional command arguments.' },
    timeoutMs: { type: 'integer', minimum: 1000, maximum: 900000, description: 'Maximum test runtime in milliseconds.' },
  },
  additionalProperties: false,
};

function resolveConversationId(runnableConfig, req) {
  return (
    runnableConfig?.metadata?.thread_id ||
    runnableConfig?.configurable?.thread_id ||
    runnableConfig?.configurable?.requestBody?.conversationId ||
    req?.body?.conversationId ||
    'new'
  );
}

function attachPolicyMetadata(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return result;
  }
  const snapshot = getRuntimePolicySnapshot();
  return {
    ...result,
    policy_version: snapshot.policyVersion,
    policy_snapshot_id: snapshot.snapshotId,
  };
}

function serializeResult(result) {
  return JSON.stringify(result, null, 2);
}

function createWorkspaceContext() {
  return null;
}

async function decorateWorkspaceResult({ req, conversationId, result }) {
  if (!result || typeof result !== 'object') {
    return result;
  }

  const outputPath = String(result.path || '').trim();
  if (!req || !outputPath.startsWith(`${WORKSPACE_VIRTUAL_PATHS.outputs}/`)) {
    return attachPolicyMetadata(result);
  }

  const relativePath = `outputs/${outputPath.slice(`${WORKSPACE_VIRTUAL_PATHS.outputs}/`.length)}`;
  const filename = path.basename(outputPath);

  try {
    const link = await createSandboxDownloadLink({
      req,
      conversationId,
      relativePath,
      filename,
    });

    return attachPolicyMetadata({
      ...result,
      filename,
      download_url: link.download_url,
      copyable_link: link.download_url,
      expires_at: link.expires_at,
      policy_version: link.policy_version,
      policy_snapshot_id: link.policy_snapshot_id,
      attachment: {
        filename,
        filepath: link.download_url,
        copyableLink: link.download_url,
        downloadURL: link.download_url,
        source: 'workspace_write',
        type: 'application/octet-stream',
      },
    });
  } catch (_error) {
    return attachPolicyMetadata({
      ...result,
      filename,
    });
  }
}

function createWorkspaceTool({ name, schema, handler, req }) {
  return tool(
    async (input, runnableConfig) => {
      const conversationId = resolveConversationId(runnableConfig, req);
      const requester = buildRequesterContext(req);
      const rawResult = await handler({
        conversationId,
        requester,
        ...(input || {}),
      });
      const result = await decorateWorkspaceResult({ req, conversationId, result: rawResult });
      return serializeResult(result);
    },
    {
      name,
      description: WORKSPACE_TOOL_DESCRIPTIONS[name],
      schema,
      metadata: {},
    },
  );
}

function createWorkspaceTools({ req }) {
  const toolNames = [];
  return {
    workspace_list: createWorkspaceTool({
      name: 'workspace_list',
      schema: listSchema,
      handler: async ({ conversationId, prefix }) =>
        await workspaceList({ conversationId, prefix: prefix || WORKSPACE_VIRTUAL_PATHS.root, authContext: { user: req?.user } }),
      req,
    }),
    workspace_read: createWorkspaceTool({
      name: 'workspace_read',
      schema: readSchema,
      handler: async ({ conversationId, path, range, encoding }) =>
        await workspaceRead({ conversationId, path, range, encoding, authContext: { user: req?.user } }),
      req,
    }),
    workspace_write: createWorkspaceTool({
      name: 'workspace_write',
      schema: writeSchema,
      handler: async ({ conversationId, path, content, overwrite, encoding }) =>
        await workspaceWrite({ conversationId, path, content, overwrite, encoding, authContext: { user: req?.user } }),
      req,
    }),
    workspace_stat: createWorkspaceTool({
      name: 'workspace_stat',
      schema: statSchema,
      handler: async ({ conversationId, path }) => await workspaceStat({ conversationId, path, authContext: { user: req?.user } }),
      req,
    }),
    workspace_delete: createWorkspaceTool({
      name: 'workspace_delete',
      schema: deleteSchema,
      handler: async ({ conversationId, path, recursive }) =>
        await workspaceDelete({ conversationId, path, recursive, authContext: { user: req?.user } }),
      req,
    }),
    workspace_glob: createWorkspaceTool({
      name: 'workspace_glob',
      schema: globSchema,
      handler: async ({ conversationId, rootPath, pattern, includeHidden, maxResults }) =>
        await workspaceGlobFind({
          conversationId,
          rootPath,
          pattern,
          includeHidden,
          maxResults,
          authContext: { user: req?.user },
        }),
      req,
    }),
    workspace_grep_search: createWorkspaceTool({
      name: 'workspace_grep_search',
      schema: grepSearchSchema,
      handler: async ({ conversationId, rootPath, query, caseSensitive, regex, cursor, pageSize, maxResults }) =>
        await workspaceGrepSearch({
          conversationId,
          rootPath,
          query,
          caseSensitive,
          regex,
          cursor,
          pageSize,
          maxResults,
          authContext: { user: req?.user },
        }),
      req,
    }),
    workspace_search_replace: createWorkspaceTool({
      name: 'workspace_search_replace',
      schema: searchReplaceSchema,
      handler: async ({ conversationId, path, search, replace, regex, caseSensitive, replaceAll }) =>
        await workspaceSearchReplace({
          conversationId,
          path,
          search,
          replace,
          regex,
          caseSensitive,
          replaceAll,
          authContext: { user: req?.user },
        }),
      req,
    }),
    workspace_read_todo: createWorkspaceTool({
      name: 'workspace_read_todo',
      schema: todoReadSchema,
      handler: async ({ conversationId }) => await workspaceReadTodo({ conversationId, authContext: { user: req?.user } }),
      req,
    }),
    workspace_write_todo: createWorkspaceTool({
      name: 'workspace_write_todo',
      schema: todoWriteSchema,
      handler: async ({ conversationId, todos }) =>
        await workspaceWriteTodo({ conversationId, todos, authContext: { user: req?.user } }),
      req,
    }),
    workspace_task_summary: createWorkspaceTool({
      name: 'workspace_task_summary',
      schema: todoReadSchema,
      handler: async ({ conversationId }) => await workspaceTaskSummary({ conversationId, authContext: { user: req?.user } }),
      req,
    }),
    workspace_extract_archive: createWorkspaceTool({
      name: 'workspace_extract_archive',
      schema: extractArchiveSchema,
      handler: async ({ conversationId, archivePath, destinationPath, format }) =>
        await workspaceExtractArchive({ conversationId, archivePath, destinationPath, format, authContext: { user: req?.user } }),
      req,
    }),
    workspace_create_archive: createWorkspaceTool({
      name: 'workspace_create_archive',
      schema: createArchiveSchema,
      handler: async ({ conversationId, sourcePath, includePaths, outputPath, stripTopLevel, format }) =>
        await workspaceCreateArchive({
          conversationId,
          sourcePath,
          includePaths,
          outputPath,
          stripTopLevel,
          format,
          authContext: { user: req?.user },
        }),
      req,
    }),
    archive_inspect: createWorkspaceTool({
      name: 'archive_inspect',
      schema: archiveInspectSchema,
      handler: async ({ conversationId, path, maxEntries }) =>
        await archiveInspect({ conversationId, path, maxEntries, authContext: { user: req?.user } }),
      req,
      toolNames,
    }),
    archive_validate: createWorkspaceTool({
      name: 'archive_validate',
      schema: archiveValidateSchema,
      handler: async ({ conversationId, path, expectedSha256, includeMemberHashes }) =>
        await archiveValidate({ conversationId, path, expectedSha256, includeMemberHashes, authContext: { user: req?.user } }),
      req,
      toolNames,
    }),
    sandbox_info: createWorkspaceTool({
      name: 'sandbox_info',
      schema: sandboxInfoSchema,
      handler: async ({ conversationId, requester }) => await sandboxInfo({ conversationId, requester }),
      req,
      toolNames,
    }),
    workspace_purge: createWorkspaceTool({
      name: 'workspace_purge',
      schema: workspacePurgeSchema,
      handler: async ({ conversationId, dryRun, requester }) => await workspacePurge({ conversationId, dryRun, requester, authContext: { user: req?.user } }),
      req,
      toolNames,
    }),
    content_scan: createWorkspaceTool({
      name: 'content_scan',
      schema: contentScanSchema,
      handler: async ({ conversationId, path, text, maxBytes, maxFindings }) =>
        await contentScan({ conversationId, path, text, maxBytes, maxFindings }),
      req,
      toolNames,
    }),
    policy_audit_log: createWorkspaceTool({
      name: 'policy_audit_log',
      schema: policyAuditLogSchema,
      handler: async ({ conversationId, limit, toolName, requester, scope, eventType, policyResult, reasonCode }) =>
        await policyAuditLog({ conversationId, limit, toolName, requester, scope, eventType, policyResult, reasonCode }),
      req,
      toolNames,
    }),
    web_fetch: createWorkspaceTool({
      name: 'web_fetch',
      schema: webFetchSchema,
      handler: async ({ url, method }) => await webFetch({ url, method }),
      req,
      toolNames,
    }),

    process_list: createWorkspaceTool({
      name: 'process_list',
      schema: processListSchema,
      handler: async ({ requester, scope, maxProcesses }) =>
        await listSandboxProcesses({ requester, scope, maxProcesses }),
      req,
      toolNames,
    }),
    host_filesystem_access: createWorkspaceTool({
      name: 'host_filesystem_access',
      schema: hostFilesystemAccessSchema,
      handler: async ({ requester, operation, path, range, encoding, content, overwrite }) =>
        await accessHostFilesystem({ requester, operation, path, range, encoding, content, overwrite }),
      req,
      toolNames,
    }),
    database_connect: createWorkspaceTool({
      name: 'database_connect',
      schema: databaseConnectSchema,
      handler: async ({ requester, driver, connection, query, params, readOnly, maxRows }) =>
        await connectDatabase({ requester, driver, connection, query, params, readOnly, maxRows }),
      req,
      toolNames,
    }),
    pdf_parse: createWorkspaceTool({
      name: 'pdf_parse',
      schema: pathOnlySchema,
      handler: async ({ conversationId, path }) => await pdfParse({ conversationId, path }),
      req,
      toolNames,
    }),
    docx_parse: createWorkspaceTool({
      name: 'docx_parse',
      schema: pathOnlySchema,
      handler: async ({ conversationId, path }) => await docxParse({ conversationId, path }),
      req,
      toolNames,
    }),
    markdown_ast: createWorkspaceTool({
      name: 'markdown_ast',
      schema: markdownAstSchema,
      handler: async ({ conversationId, path, text }) => await markdownAst({ conversationId, path, text }),
      req,
      toolNames,
    }),
    code_ast: createWorkspaceTool({
      name: 'code_ast',
      schema: codeAstSchema,
      handler: async ({ conversationId, path, code, language, maxNodes }) =>
        await codeAst({ conversationId, path, code, language, maxNodes }),
      req,
      toolNames,
    }),
    code_parse: createWorkspaceTool({
      name: 'code_parse',
      schema: codeAstSchema,
      handler: async ({ conversationId, path, code, language, maxNodes }) =>
        await codeAst({ conversationId, path, code, language, maxNodes }),
      req,
      toolNames,
    }),
    convert_pdf_to_text: createWorkspaceTool({
      name: 'convert_pdf_to_text',
      schema: conversionSchema,
      handler: async ({ conversationId, path, outputPath }) =>
        await convertPdfToText({ conversationId, path, outputPath }),
      req,
      toolNames,
    }),
    convert_docx_to_md: createWorkspaceTool({
      name: 'convert_docx_to_md',
      schema: conversionSchema,
      handler: async ({ conversationId, path, outputPath }) =>
        await convertDocxToMd({ conversationId, path, outputPath }),
      req,
      toolNames,
    }),
    json_to_yaml: createWorkspaceTool({
      name: 'json_to_yaml',
      schema: jsonYamlConversionSchema,
      handler: async ({ conversationId, path, text, outputPath }) =>
        await jsonToYaml({ conversationId, path, text, outputPath }),
      req,
      toolNames,
    }),
    yaml_to_json: createWorkspaceTool({
      name: 'yaml_to_json',
      schema: jsonYamlConversionSchema,
      handler: async ({ conversationId, path, text, outputPath }) =>
        await yamlToJson({ conversationId, path, text, outputPath }),
      req,
      toolNames,
    }),
    workspace_grep: createWorkspaceTool({
      name: 'workspace_grep',
      schema: workspaceSearchSchema,
      handler: async ({ conversationId, rootPath, query, regex, caseSensitive, includeExtensions, maxMatches, maxFiles }) =>
        await workspaceGrep({ conversationId, rootPath, query, regex, caseSensitive, includeExtensions, maxMatches, maxFiles }),
      req,
      toolNames,
    }),
    search_in_files: createWorkspaceTool({
      name: 'search_in_files',
      schema: workspaceSearchSchema,
      handler: async ({ conversationId, rootPath, query, regex, caseSensitive, includeExtensions, maxMatches, maxFiles }) =>
        await searchInFiles({ conversationId, rootPath, query, regex, caseSensitive, includeExtensions, maxMatches, maxFiles }),
      req,
      toolNames,
    }),
    fuzzy_search: createWorkspaceTool({
      name: 'fuzzy_search',
      schema: fuzzySearchSchema,
      handler: async ({ conversationId, rootPath, query, includeExtensions, maxResults, maxFiles }) =>
        await fuzzySearch({ conversationId, rootPath, query, includeExtensions, maxResults, maxFiles }),
      req,
      toolNames,
    }),
    detect_dependencies: createWorkspaceTool({
      name: 'detect_dependencies',
      schema: detectDependenciesSchema,
      handler: async ({ conversationId, rootPath, maxFiles }) =>
        await detectDependencies({ conversationId, rootPath, maxFiles }),
      req,
      toolNames,
    }),
    parse_package_json: createWorkspaceTool({
      name: 'parse_package_json',
      schema: pathOnlySchema,
      handler: async ({ conversationId, path }) => await parsePackageJson({ conversationId, path }),
      req,
      toolNames,
    }),
    list_pip_requirements: createWorkspaceTool({
      name: 'list_pip_requirements',
      schema: pathOnlySchema,
      handler: async ({ conversationId, path }) => await listPipRequirements({ conversationId, path }),
      req,
      toolNames,
    }),
    scan_maven_pom: createWorkspaceTool({
      name: 'scan_maven_pom',
      schema: pathOnlySchema,
      handler: async ({ conversationId, path }) => await scanMavenPom({ conversationId, path }),
      req,
      toolNames,
    }),
    scan_cargo_toml: createWorkspaceTool({
      name: 'scan_cargo_toml',
      schema: pathOnlySchema,
      handler: async ({ conversationId, path }) => await scanCargoToml({ conversationId, path }),
      req,
      toolNames,
    }),
    sbom_generate: createWorkspaceTool({
      name: 'sbom_generate',
      schema: sbomGenerateSchema,
      handler: async ({ conversationId, rootPath, outputPath }) =>
        await sbomGenerate({ conversationId, rootPath, outputPath }),
      req,
      toolNames,
    }),
    cve_lookup: createWorkspaceTool({
      name: 'cve_lookup',
      schema: cveLookupSchema,
      handler: async ({ components, ecosystem, name, version }) =>
        await cveLookup({ components, ecosystem, name, version }),
      req,
      toolNames,
    }),
    oss_license_scan: createWorkspaceTool({
      name: 'oss_license_scan',
      schema: rootPathSchema,
      handler: async ({ conversationId, rootPath, maxFiles }) =>
        await ossLicenseScan({ conversationId, rootPath, maxFiles }),
      req,
      toolNames,
    }),
    binary_analysis: createWorkspaceTool({
      name: 'binary_analysis',
      schema: pathOnlySchema,
      handler: async ({ conversationId, path }) => await binaryAnalysis({ conversationId, path }),
      req,
      toolNames,
    }),
    dns_resolve: createWorkspaceTool({
      name: 'dns_resolve',
      schema: dnsResolveSchema,
      handler: async ({ hostname, recordType }) => await dnsResolve({ hostname, recordType }),
      req,
      toolNames,
    }),
    port_check: createWorkspaceTool({
      name: 'port_check',
      schema: portCheckSchema,
      handler: async ({ host, port, timeoutMs }) => await portCheck({ host, port, timeoutMs }),
      req,
      toolNames,
    }),
    curl_head_only: createWorkspaceTool({
      name: 'curl_head_only',
      schema: headRequestSchema,
      handler: async ({ url, timeoutMs }) => await curlHeadOnly({ url, timeoutMs }),
      req,
      toolNames,
    }),
    http_headers_inspect: createWorkspaceTool({
      name: 'http_headers_inspect',
      schema: headRequestSchema,
      handler: async ({ url, timeoutMs }) => await httpHeadersInspect({ url, timeoutMs }),
      req,
      toolNames,
    }),
    run_unit_tests: createWorkspaceTool({
      name: 'run_unit_tests',
      schema: runUnitTestsSchema,
      handler: async ({ conversationId, cwd, command, args, timeoutMs }) =>
        await runUnitTests({ conversationId, cwd, command, args, timeoutMs }),
      req,
      toolNames,
    }),
    validate_json_schema: createWorkspaceTool({
      name: 'validate_json_schema',
      schema: validateJsonSchemaSchema,
      handler: async ({ conversationId, schemaPath, schemaText, dataPath, dataText }) =>
        await validateJsonSchemaTool({ conversationId, schemaPath, schemaText, dataPath, dataText }),
      req,
      toolNames,
    }),
    check_openapi_spec: createWorkspaceTool({
      name: 'check_openapi_spec',
      schema: openApiCheckSchema,
      handler: async ({ conversationId, path, text }) => await checkOpenApiSpec({ conversationId, path, text }),
      req,
      toolNames,
    }),
    lint_yaml: createWorkspaceTool({
      name: 'lint_yaml',
      schema: yamlLintSchema,
      handler: async ({ conversationId, path, text }) => await lintYaml({ conversationId, path, text }),
      req,
      toolNames,
    }),
  };
}

module.exports = {
  ALL_WORKSPACE_TOOL_NAMES,
  createWorkspaceContext,
  createWorkspaceTools,
};
