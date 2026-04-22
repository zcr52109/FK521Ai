const { randomUUID } = require('crypto');
const { checkAccess } = require('@fk521ai/api');
const { Permissions, PermissionTypes } = require('fk521ai-data-provider');
const { getRoleByName } = require('~/models');
const { readDifyConsoleConfig } = require('~/server/utils/difyConsoleConfig');
const { classifySandboxRelativePath, normalizeRelativeSandboxPath } = require('./paths');

const SANDBOX_POLICY_VERSION = process.env.FK521_SANDBOX_POLICY_VERSION || 'sandbox-policy-v1';
const SANDBOX_POLICY_MODEL = 'hybrid';

const SANDBOX_ACTIONS = Object.freeze({
  EXECUTE_CODE: 'sandbox:execute_code',
  READ_CAPABILITIES: 'sandbox:read_capabilities',
  DOWNLOAD_FILE: 'sandbox:download_file',
});

const SANDBOX_REASON_CODES = Object.freeze({
  AUTHENTICATION_REQUIRED: 'AUTHENTICATION_REQUIRED',
  ROLE_MISSING_RUN_CODE: 'ROLE_MISSING_RUN_CODE',
  EXECUTE_CODE_CAPABILITY_REQUIRED: 'EXECUTE_CODE_CAPABILITY_REQUIRED',
  ROOT_NOT_ALLOWED: 'ROOT_NOT_ALLOWED',
  ROOT_NOT_DOWNLOADABLE: 'ROOT_NOT_DOWNLOADABLE',
  INVALID_PATH: 'INVALID_PATH',
});

function createDecision({ action, allow, reasonCode = 'OK', remediation = null, resource = null }) {
  return {
    allow,
    action,
    reasonCode,
    remediation,
    decisionId: randomUUID(),
    policyVersion: SANDBOX_POLICY_VERSION,
    policyModel: SANDBOX_POLICY_MODEL,
    resource,
  };
}

async function hasRunCodeAccess(user) {
  if (!user) {
    return false;
  }

  return await checkAccess({
    user,
    permissionType: PermissionTypes.RUN_CODE,
    permissions: [Permissions.USE],
    getRoleByName,
  });
}

async function resolveSandboxCapabilities({ user } = {}) {
  const config = readDifyConsoleConfig();
  const sandboxTools = config.sandboxTools || {};
  const capabilities = [
    'fs:read_uploads',
    'fs:write_workspace',
    'fs:write_outputs',
    'fs:download_outputs',
    'audit:enabled',
    'tool:workspace_extract_archive',
    'tool:workspace_create_archive',
    'tool:content_scan',
    'tool:archive_inspect',
    'tool:archive_validate',
    'tool:policy_audit_log',
    'tool:process_list',
    'tool:run_tools_with_code',
  ];

  if (await hasRunCodeAccess(user)) {
    capabilities.unshift('tool:execute_code');
  }

  if (sandboxTools.allowWebFetch === true) {
    capabilities.push('tool:web_fetch');
  }
  if (sandboxTools.allowDatabaseConnect === true) {
    capabilities.push('tool:database_connect');
  }
  if (sandboxTools.allowHostFilesystemAccess === true && String(user?.role || '').trim().toUpperCase() === 'ADMIN') {
    capabilities.push('tool:host_filesystem_access');
  }

  return capabilities;
}

function buildSandboxSubject({ user, roles, scopes } = {}) {
  const roleList = Array.isArray(roles)
    ? roles.filter(Boolean)
    : [user?.role, ...(Array.isArray(user?.roles) ? user.roles : [])].filter(Boolean);

  const scopeList = Array.isArray(scopes)
    ? scopes.filter(Boolean)
    : Array.isArray(user?.scopes)
      ? user.scopes.filter(Boolean)
      : [];

  return {
    principalId: String(user?.id || user?._id || 'sandbox-runtime'),
    roles: [...new Set(roleList)],
    scopes: [...new Set(scopeList)],
  };
}

function getTenantId({ user, tenantId } = {}) {
  return String(tenantId || user?.tenantId || 'default-tenant');
}

async function authorizeSandboxAction({ user, action, relativePath, allowExecuteCode = false } = {}) {
  if (!user?.id && action !== SANDBOX_ACTIONS.EXECUTE_CODE) {
    return createDecision({
      action,
      allow: false,
      reasonCode: SANDBOX_REASON_CODES.AUTHENTICATION_REQUIRED,
      remediation: 'authenticate_and_retry',
    });
  }

  if (action === SANDBOX_ACTIONS.EXECUTE_CODE) {
    if (!user?.id) {
      return createDecision({
        action,
        allow: false,
        reasonCode: SANDBOX_REASON_CODES.AUTHENTICATION_REQUIRED,
        remediation: 'authenticate_and_retry',
      });
    }

    if (allowExecuteCode !== true) {
      return createDecision({
        action,
        allow: false,
        reasonCode: SANDBOX_REASON_CODES.EXECUTE_CODE_CAPABILITY_REQUIRED,
        remediation: 'enable_execute_code_capability',
      });
    }

    const canRunCode = await hasRunCodeAccess(user);
    if (!canRunCode) {
      return createDecision({
        action,
        allow: false,
        reasonCode: SANDBOX_REASON_CODES.ROLE_MISSING_RUN_CODE,
        remediation: 'grant_run_code_permission',
      });
    }

    return createDecision({
      action,
      allow: true,
      resource: { type: 'sandbox' },
    });
  }

  if (action === SANDBOX_ACTIONS.READ_CAPABILITIES) {
    return createDecision({
      action,
      allow: true,
      resource: { type: 'sandbox_capabilities' },
    });
  }

  if (action === SANDBOX_ACTIONS.DOWNLOAD_FILE) {
    try {
      const normalizedPath = normalizeRelativeSandboxPath(relativePath);
      const classification = classifySandboxRelativePath(normalizedPath);

      if (!classification.rootId) {
        return createDecision({
          action,
          allow: false,
          reasonCode: SANDBOX_REASON_CODES.ROOT_NOT_ALLOWED,
          remediation: 'use_outputs_or_workspace_tasks_path',
          resource: { relativePath: normalizedPath },
        });
      }

      if (!classification.downloadAllowed) {
        return createDecision({
          action,
          allow: false,
          reasonCode: SANDBOX_REASON_CODES.ROOT_NOT_DOWNLOADABLE,
          remediation: 'move_file_to_outputs_or_workspace_tasks',
          resource: { relativePath: normalizedPath, rootId: classification.rootId },
        });
      }

      return createDecision({
        action,
        allow: true,
        resource: {
          relativePath: normalizedPath,
          rootId: classification.rootId,
        },
      });
    } catch (_error) {
      return createDecision({
        action,
        allow: false,
        reasonCode: SANDBOX_REASON_CODES.INVALID_PATH,
        remediation: 'normalize_relative_sandbox_path',
        resource: { relativePath },
      });
    }
  }

  return createDecision({
    action,
    allow: false,
    reasonCode: 'UNSUPPORTED_ACTION',
    remediation: 'use_supported_sandbox_action',
  });
}

module.exports = {
  SANDBOX_ACTIONS,
  SANDBOX_POLICY_MODEL,
  SANDBOX_POLICY_VERSION,
  SANDBOX_REASON_CODES,
  authorizeSandboxAction,
  buildSandboxSubject,
  getTenantId,
  hasRunCodeAccess,
  resolveSandboxCapabilities,
};
