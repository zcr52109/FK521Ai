const { logger } = require('@fk521ai/data-schemas');
const {
  getRuntimePolicySnapshot,
  recordPolicyAuditEvent,
  truncateSummary,
} = require('~/server/services/RuntimePolicy');

const TOOL_RISK_LEVELS = Object.freeze({
  execute_code: 'medium',
  run_tools_with_code: 'medium',
  workspace_write: 'medium',
  workspace_read: 'medium',
  workspace_list: 'low',
  workspace_stat: 'low',
  workspace_delete: 'high',
  workspace_glob: 'low',
  workspace_grep_search: 'low',
  workspace_search_replace: 'medium',
  workspace_read_todo: 'low',
  workspace_write_todo: 'medium',
  workspace_task_summary: 'low',
  workspace_extract_archive: 'medium',
  workspace_create_archive: 'medium',
  archive_inspect: 'low',
  archive_validate: 'medium',
  sandbox_info: 'low',
  workspace_purge: 'high',
  content_scan: 'medium',
  policy_audit_log: 'medium',
  web_fetch: 'medium',
  process_list: 'medium',
  host_filesystem_access: 'high',
  database_connect: 'high',
  pdf_parse: 'low',
  docx_parse: 'low',
  markdown_ast: 'low',
  code_ast: 'low',
  code_parse: 'low',
  convert_pdf_to_text: 'medium',
  convert_docx_to_md: 'medium',
  json_to_yaml: 'low',
  yaml_to_json: 'low',
  workspace_grep: 'low',
  search_in_files: 'low',
  fuzzy_search: 'low',
  detect_dependencies: 'low',
  parse_package_json: 'low',
  list_pip_requirements: 'low',
  scan_maven_pom: 'low',
  scan_cargo_toml: 'low',
  sbom_generate: 'medium',
  cve_lookup: 'medium',
  oss_license_scan: 'medium',
  binary_analysis: 'medium',
  dns_resolve: 'medium',
  port_check: 'medium',
  curl_head_only: 'medium',
  http_headers_inspect: 'medium',
  run_unit_tests: 'medium',
  validate_json_schema: 'low',
  check_openapi_spec: 'low',
  lint_yaml: 'low',
  web_search: 'low',
  file_search: 'low',
});

const HIGH_RISK_TOOL_NAMES = new Set([
  'workspace_delete',
  'workspace_purge',
  'host_filesystem_access',
  'database_connect',
]);
const FORBIDDEN_TOOL_NAMES = new Set([
  'shell_exec',
  'system_command',
  'network_bind',
]);
const FILE_REQUIRED_KEYS = new Set(['file_id', 'file_ids', 'path', 'paths', 'relativePath']);
const HIGH_RISK_INTENT_REGEX = /(?:代码|修复|修改|编辑|补丁|运行|执行|脚本|程序|文件|导出|导出成|下载|保存|写入|生成(?:一个)?(?:文件|压缩包|zip|归档)|打包|压缩|归档|清理|删除|purge|zip|archive|export|download|save|write|patch|edit|modify|fix|run|execute|script|code|clean|delete)/i;
const STRUCTURED_INTENT_SCHEMA_VERSION = 'fk521.intent.v1';

function normalizeToolName(name = '') {
  return String(name || '').trim();
}

function inferRiskLevel(toolName = '') {
  return TOOL_RISK_LEVELS[normalizeToolName(toolName)] || 'medium';
}

function buildRegistryEntry(tool = {}) {
  const toolName = normalizeToolName(tool.name || tool?.function?.name);
  return {
    toolName,
    description: String(tool.description || tool?.function?.description || '').trim(),
    riskLevel: inferRiskLevel(toolName),
    schema: tool.schema || tool?.function?.parameters || null,
    outputSchema: null,
  };
}

function isObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function validatePrimitive(schema = {}, value, path, errors) {
  const type = schema.type;
  if (!type) {
    return;
  }

  if (type === 'string' && typeof value !== 'string') {
    errors.push({ path, code: 'INVALID_TYPE', expected: 'string', actual: typeof value });
  } else if (type === 'boolean' && typeof value !== 'boolean') {
    errors.push({ path, code: 'INVALID_TYPE', expected: 'boolean', actual: typeof value });
  } else if (type === 'integer') {
    if (!Number.isInteger(value)) {
      errors.push({ path, code: 'INVALID_TYPE', expected: 'integer', actual: typeof value });
    }
  } else if (type === 'number') {
    if (typeof value !== 'number' || Number.isNaN(value)) {
      errors.push({ path, code: 'INVALID_TYPE', expected: 'number', actual: typeof value });
    }
  } else if (type === 'array') {
    if (!Array.isArray(value)) {
      errors.push({ path, code: 'INVALID_TYPE', expected: 'array', actual: typeof value });
      return;
    }
    if (schema.items) {
      value.forEach((item, index) => validateJsonSchema(schema.items, item, `${path}[${index}]`, errors));
    }
  } else if (type === 'object') {
    if (!isObject(value)) {
      errors.push({
        path,
        code: 'INVALID_TYPE',
        expected: 'object',
        actual: Array.isArray(value) ? 'array' : typeof value,
      });
      return;
    }
  }

  if (schema.enum && !schema.enum.includes(value)) {
    errors.push({ path, code: 'INVALID_ENUM', expected: schema.enum, actual: value });
  }

  if (typeof value === 'number') {
    if (schema.minimum != null && value < schema.minimum) {
      errors.push({ path, code: 'MINIMUM_VIOLATION', minimum: schema.minimum, actual: value });
    }
    if (schema.maximum != null && value > schema.maximum) {
      errors.push({ path, code: 'MAXIMUM_VIOLATION', maximum: schema.maximum, actual: value });
    }
  }
}

function validateJsonSchema(schema = {}, value, path = '$', errors = []) {
  if (!schema || typeof schema !== 'object') {
    return errors;
  }

  validatePrimitive(schema, value, path, errors);

  if (schema.type === 'object' && isObject(value)) {
    const properties = isObject(schema.properties) ? schema.properties : {};
    const required = Array.isArray(schema.required) ? schema.required : [];
    for (const key of required) {
      if (value[key] === undefined) {
        errors.push({ path: `${path}.${key}`, code: 'MISSING_REQUIRED' });
      }
    }

    for (const [key, childSchema] of Object.entries(properties)) {
      if (value[key] !== undefined) {
        validateJsonSchema(childSchema, value[key], `${path}.${key}`, errors);
      }
    }

    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in properties)) {
          errors.push({ path: `${path}.${key}`, code: 'UNEXPECTED_PROPERTY' });
        }
      }
    }
  }

  return errors;
}

function validateToolInput(tool, input) {
  const entry = buildRegistryEntry(tool);
  const schema = entry.schema;
  if (!schema || typeof schema !== 'object') {
    return { ok: true, errors: [] };
  }

  if (!isObject(input) && schema.type === 'object') {
    return {
      ok: false,
      errors: [{ path: '$', code: 'INVALID_TYPE', expected: 'object', actual: typeof input }],
    };
  }

  const errors = validateJsonSchema(schema, input, '$', []);
  return { ok: errors.length === 0, errors };
}

function extractLatestUserText(req) {
  if (typeof req?.body?.text === 'string' && req.body.text.trim()) {
    return req.body.text.trim();
  }

  const messages = Array.isArray(req?.body?.messages) ? req.body.messages : [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message?.isCreatedByUser === true || message?.role === 'user') {
      if (typeof message.text === 'string' && message.text.trim()) {
        return message.text.trim();
      }
      if (Array.isArray(message.content)) {
        const text = message.content
          .filter((part) => part?.type === 'text' && typeof part.text === 'string')
          .map((part) => part.text)
          .join('\n')
          .trim();
        if (text) {
          return text;
        }
      }
      if (typeof message.content === 'string' && message.content.trim()) {
        return message.content.trim();
      }
    }
  }

  return '';
}

function hasExplicitHighRiskIntent(text = '') {
  return HIGH_RISK_INTENT_REGEX.test(String(text || ''));
}

function extractStructuredIntent(args = {}) {
  if (!isObject(args)) {
    return null;
  }
  const payload = isObject(args.intent) ? args.intent : isObject(args.__intent) ? args.__intent : null;
  if (!payload) {
    return null;
  }
  return {
    schema: String(payload.schema || '').trim(),
    action: String(payload.action || '').trim(),
    capability: String(payload.capability || '').trim(),
    requiresConfirmation: payload.requiresConfirmation === true,
  };
}

function validateStructuredIntent(intent, toolName) {
  if (!intent) {
    return { ok: false, reasonCode: 'INTENT_PROTOCOL_MISSING' };
  }
  if (intent.schema !== STRUCTURED_INTENT_SCHEMA_VERSION) {
    return { ok: false, reasonCode: 'INTENT_PROTOCOL_SCHEMA_UNSUPPORTED' };
  }
  if (!intent.action) {
    return { ok: false, reasonCode: 'INTENT_ACTION_MISSING' };
  }
  if (intent.capability && intent.capability !== toolName) {
    return { ok: false, reasonCode: 'INTENT_CAPABILITY_MISMATCH' };
  }
  return { ok: true, reasonCode: 'OK' };
}

function hasFileLikeArgument(args = {}) {
  if (!isObject(args)) {
    return false;
  }
  for (const key of Object.keys(args)) {
    if (FILE_REQUIRED_KEYS.has(key) && args[key]) {
      return true;
    }
  }
  return false;
}

function resolveConversationId(req, runnableConfig) {
  return (
    runnableConfig?.metadata?.thread_id ||
    runnableConfig?.configurable?.thread_id ||
    runnableConfig?.configurable?.requestBody?.conversationId ||
    req?.body?.conversationId ||
    'new'
  );
}

function summarizeForAudit(value) {
  return truncateSummary(value, 1000);
}

function buildDecision({
  action,
  toolName,
  normalizedArgs,
  confidence,
  reasonCode = 'OK',
  remediation = null,
  gateResults = [],
}) {
  const snapshot = getRuntimePolicySnapshot();
  return {
    action,
    toolName,
    confidence,
    reasonCode,
    remediation,
    arguments: normalizedArgs,
    policy_version: snapshot.policyVersion,
    policy_snapshot_id: snapshot.snapshotId,
    gateResults,
  };
}

function decideToolInvocation({ tool, input, req }) {
  const toolName = normalizeToolName(tool?.name || tool?.function?.name);
  const normalizedArgs = isObject(input) ? input : {};
  const gateResults = [];

  if (!toolName) {
    gateResults.push({ gate: 'tool_registry', passed: false, reasonCode: 'TOOL_NAME_MISSING' });
    return buildDecision({
      action: 'REJECT',
      toolName,
      normalizedArgs,
      confidence: 0,
      reasonCode: 'TOOL_NAME_MISSING',
      remediation: 'use_registered_tool_name',
      gateResults,
    });
  }

  if (FORBIDDEN_TOOL_NAMES.has(toolName)) {
    gateResults.push({ gate: 'security_redline', passed: false, reasonCode: 'FORBIDDEN_TOOL_NAME' });
    return buildDecision({
      action: 'REJECT',
      toolName,
      normalizedArgs,
      confidence: 1,
      reasonCode: 'FORBIDDEN_TOOL_NAME',
      remediation: 'do_not_attempt_sandbox_boundary_breakout',
      gateResults,
    });
  }

  const validation = validateToolInput(tool, normalizedArgs);
  gateResults.push({
    gate: 'schema_validation',
    passed: validation.ok,
    reasonCode: validation.ok ? 'OK' : 'SCHEMA_VALIDATION_FAILED',
    errors: validation.errors,
  });

  if (!validation.ok) {
    const hasMissingRequired = validation.errors.some((error) => error.code === 'MISSING_REQUIRED');
    return buildDecision({
      action: 'REJECT',
      toolName,
      normalizedArgs,
      confidence: 0.12,
      reasonCode: 'SCHEMA_VALIDATION_FAILED',
      remediation: hasMissingRequired ? 'self_repair_missing_required_parameters' : 'normalize_parameters_to_schema',
      gateResults,
    });
  }

  const riskLevel = inferRiskLevel(toolName);
  const latestUserText = extractLatestUserText(req);
  const protocolIntent = extractStructuredIntent(normalizedArgs);
  const structuredIntentValidation = validateStructuredIntent(protocolIntent, toolName);
  const explicitHighRiskIntent =
    structuredIntentValidation.ok ||
    hasExplicitHighRiskIntent(latestUserText) ||
    hasFileLikeArgument(normalizedArgs);

  gateResults.push({
    gate: 'intent_protocol',
    passed: structuredIntentValidation.ok,
    reasonCode: structuredIntentValidation.reasonCode,
    protocol: protocolIntent
      ? {
          schema: protocolIntent.schema,
          action: protocolIntent.action,
          capability: protocolIntent.capability || toolName,
        }
      : null,
  });

  if (HIGH_RISK_TOOL_NAMES.has(toolName)) {
    gateResults.push({
      gate: 'intent_confirmation',
      passed: explicitHighRiskIntent,
      reasonCode: explicitHighRiskIntent ? 'OK' : 'HIGH_RISK_INTENT_UNCONFIRMED',
    });

    if (!explicitHighRiskIntent) {
      return buildDecision({
        action: 'REJECT',
        toolName,
        normalizedArgs,
        confidence: 0.38,
        reasonCode: 'HIGH_RISK_INTENT_UNCONFIRMED',
        remediation: 'provide_structured_intent_protocol_or_explicit_user_confirmation',
        gateResults,
      });
    }
  }

  gateResults.push({ gate: 'preconditions', passed: true, reasonCode: 'OK', riskLevel });
  return buildDecision({
    action: 'CALL_TOOL',
    toolName,
    normalizedArgs,
    confidence: riskLevel === 'high' ? 0.91 : 0.99,
    gateResults,
  });
}

function formatDecisionOutput(decision) {
  return JSON.stringify(
    {
      router_decision: decision,
      status: decision.action === 'CALL_TOOL' ? 'approved' : 'blocked',
    },
    null,
    2,
  );
}

function wrapToolWithRouter(tool, { req } = {}) {
  if (!tool || typeof tool._call !== 'function' || tool.__fk521RouterWrapped === true) {
    return tool;
  }

  const originalCall = tool._call.bind(tool);
  const registryEntry = buildRegistryEntry(tool);
  tool.__fk521RouterWrapped = true;
  tool.__fk521ToolRegistryEntry = registryEntry;

  tool._call = async function wrappedToolCall(input, runnableConfig) {
    const conversationId = resolveConversationId(req, runnableConfig);
    const decision = decideToolInvocation({ tool, input, req, runnableConfig });

    recordPolicyAuditEvent({
      eventType: decision.action === 'CALL_TOOL' ? 'tool_call' : 'policy_block',
      conversationId,
      toolName: registryEntry.toolName,
      inputSummary: summarizeForAudit(input || {}),
      resultSummary: decision.action === 'CALL_TOOL' ? undefined : summarizeForAudit(decision),
      policyResult: decision.action,
      reasonCode: decision.reasonCode,
      gateResults: decision.gateResults,
    });

    if (decision.action !== 'CALL_TOOL') {
      return formatDecisionOutput(decision);
    }

    try {
      const result = await originalCall(input, runnableConfig);
      recordPolicyAuditEvent({
        eventType: 'tool_result',
        conversationId,
        toolName: registryEntry.toolName,
        inputSummary: summarizeForAudit(input || {}),
        resultSummary: summarizeForAudit(result),
        policyResult: 'ALLOW',
        reasonCode: 'OK',
      });
      return result;
    } catch (error) {
      logger.error(`[ToolRouter] ${registryEntry.toolName} execution failed`, error);
      recordPolicyAuditEvent({
        eventType: 'tool_error',
        conversationId,
        toolName: registryEntry.toolName,
        inputSummary: summarizeForAudit(input || {}),
        resultSummary: summarizeForAudit({
          message: error?.message,
          code: error?.code,
          status: error?.status,
        }),
        policyResult: 'ERROR',
        reasonCode: error?.code || 'TOOL_EXECUTION_FAILED',
      });
      throw error;
    }
  };

  return tool;
}

module.exports = {
  TOOL_RISK_LEVELS,
  FORBIDDEN_TOOL_NAMES,
  buildRegistryEntry,
  decideToolInvocation,
  formatDecisionOutput,
  inferRiskLevel,
  validateJsonSchema,
  validateToolInput,
  wrapToolWithRouter,
};
