const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');
const { ensureConversationSandbox } = require('./paths');
const {
  buildSandboxSubject,
  getTenantId,
  resolveSandboxCapabilities,
  SANDBOX_POLICY_MODEL,
  SANDBOX_POLICY_VERSION,
} = require('./authorization');
const {
  getPlatformAssistantName,
  getPlatformIdentityMetadata,
} = require('~/server/services/Platform/identity');
const { getCachedRuntimePolicySnapshot } = require('~/server/services/RuntimePolicy');
const {
  getSupportedArchiveSummary,
  getArchiveToolStatus,
} = require('~/server/services/Sandbox/archiveUtils');

const SANDBOX_PATHS = Object.freeze({
  root: '/workspace',
  uploads: '/workspace/uploads',
  workspace: '/workspace/workdir',
  projects: '/workspace/projects',
  outputs: '/workspace/outputs',
  manifests: '/workspace/manifests',
  runtimeCapabilities: '/runtime/capabilities.json',
  capabilityManifest: '/workspace/manifests/.sandbox-capabilities.json',
});

const SANDBOX_ROOTS = Object.freeze([
  {
    rootId: 'uploads',
    displayName: 'User uploads',
    sandboxPath: SANDBOX_PATHS.uploads,
    permission: 'ro',
    purpose: 'Read files uploaded in the conversation',
  },
  {
    rootId: 'workspace',
    displayName: 'Sandbox workspace',
    sandboxPath: SANDBOX_PATHS.workspace,
    permission: 'rw',
    purpose: 'Temporary working directory for code execution',
  },
  {
    rootId: 'outputs',
    displayName: 'Sandbox outputs',
    sandboxPath: SANDBOX_PATHS.outputs,
    permission: 'rw',
    purpose: 'Final downloadable user-facing deliverables',
  },
]);

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }

  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(',')}}`;
  }

  return JSON.stringify(value);
}

function getSandboxContractSecret() {
  const secret = String(process.env.FK521_SANDBOX_CONTRACT_SECRET || '').trim();
  if (!secret) {
    const error = new Error(
      'Missing required secret: FK521_SANDBOX_CONTRACT_SECRET. Refusing to issue unsigned sandbox contracts.',
    );
    error.code = 'SANDBOX_CONTRACT_SECRET_REQUIRED';
    throw error;
  }
  return secret;
}

function assertSandboxContractSecretConfigured() {
  return getSandboxContractSecret();
}

function signManifest(payload) {
  const secret = getSandboxContractSecret();
  const sig = crypto.createHmac('sha256', secret).update(stableStringify(payload)).digest('base64url');
  return {
    alg: 'HS256',
    kid: process.env.FK521_SANDBOX_CONTRACT_KID || 'sandbox-contract-v1',
    sig,
  };
}

async function inspectRoot(hostPath, permission) {
  let exists = false;
  let writable = false;
  try {
    const stat = await fs.stat(hostPath);
    exists = stat.isDirectory();
  } catch (_error) {
    exists = false;
  }

  if (exists) {
    try {
      await fs.access(hostPath, permission === 'rw' ? fs.constants.W_OK : fs.constants.R_OK);
      writable = permission === 'rw';
    } catch (_error) {
      writable = false;
    }
  }

  return { exists, writable };
}

async function getSandboxCapabilityManifest(conversationId = 'new', authContext = {}) {
  const paths = ensureConversationSandbox(conversationId, authContext);
  const subject = buildSandboxSubject(authContext);
  const tenantId = getTenantId(authContext);
  const issuedAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const capabilities = await resolveSandboxCapabilities(authContext);

  const rootMappings = await Promise.all(
    SANDBOX_ROOTS.map(async (root) => {
      const hostPath = paths[`${root.rootId}Dir`];
      const state = await inspectRoot(hostPath, root.permission);
      return {
        ...root,
        hostPath,
        path: root.sandboxPath,
        exists: state.exists,
        writable: state.writable,
        maxBytes: null,
      };
    }),
  );

  const decisionId = crypto.randomUUID();
  const archiveToolStatus = getArchiveToolStatus();
  const sandboxFileDelivery = {
    sendFilesToUser: true,
    createDownloadableFiles: true,
    createCopyableDownloadLinks: true,
    downloadRouteTemplate: `/api/files/sandbox/${encodeURIComponent(String(conversationId))}?path={relativeSandboxPath}`,
    capabilityRoute: `/api/files/sandbox/${encodeURIComponent(String(conversationId))}/capabilities`,
    outputRoot: SANDBOX_PATHS.outputs,
    downloadAllowedRoots: ['outputs', 'workspace/tasks'],
  };

  const payload = {
    version: 7,
    runtime: 'local_docker_sandbox',
    issuedAt,
    expiresAt,
    conversationId: String(conversationId),
    tenantId,
    subject,
    policy: {
      model: SANDBOX_POLICY_MODEL,
      policyVersion: SANDBOX_POLICY_VERSION,
      decisionId,
    },
    capabilities,
    filesystem: {
      roots: rootMappings.map((root) => ({
        rootId: root.rootId,
        displayName: root.displayName,
        path: root.sandboxPath,
        permission: root.permission,
        maxBytes: root.maxBytes,
        purpose: root.purpose,
      })),
      pathRules: {
        normalize: true,
        denySymlinkEscape: true,
        denyPathTraversal: true,
      },
      downloadPolicy: {
        allowedRoots: ['outputs', 'workspace/tasks'],
      },
    },
    platform: {
      ...getPlatformIdentityMetadata(authContext.identityContext),
      sandboxAppPaths: SANDBOX_PATHS,
    },
    assistant: {
      displayName: getPlatformAssistantName(),
      identityOrigin: 'server_runtime',
    },
    permissions: {
      sandboxExecution: capabilities.includes('tool:execute_code'),
      filesystem: true,
      ownFilesystem: true,
      readUploads: true,
      writeWorkspace: true,
      writeOutputs: true,
      createDownloadableFiles: true,
      returnAttachments: true,
      shareDownloadLinks: true,
      sendFilesToUser: true,
      copyDownloadLinks: true,
      processIntrospection: capabilities.includes('tool:process_list'),
      databaseConnect: capabilities.includes('tool:database_connect'),
      hostFilesystemAccess: capabilities.includes('tool:host_filesystem_access'),
      userApprovalRequired: false,
    },
    archive: {
      supportedFormats: getSupportedArchiveSummary(),
      toolStatus: archiveToolStatus,
      inspectionAvailable: true,
      validationAvailable: true,
      contract: 'Inspect this section before assuming zip/unzip/tar/7z are available. Fall back to the declared backend when a shell tool is unavailable.',
    },
    security: {
      singleDirectionDataFlow: true,
      sideChannelHardened: true,
      realtimePolicyCheckPerCall: true,
      forbiddenCapabilities: ['shell_exec', 'system_command', 'network_bind'],
    },
    roots: rootMappings,
    paths: SANDBOX_PATHS,
    behavior: {
      createDeliverablesIn: SANDBOX_PATHS.outputs,
      tempWorkIn: SANDBOX_PATHS.workspace,
      projectArchivesIn: SANDBOX_PATHS.projects,
      uploadedFilesIn: SANDBOX_PATHS.uploads,
      attachmentDelivery: 'Files written to outputs are real runtime files and can be returned to the user as downloadable attachments.',
      linkDelivery: 'Attachment metadata contains copyable download paths/links when files are generated.',
      archiveSupport: `Supported archive formats: ${getSupportedArchiveSummary()}.`,
      archiveTooling: 'Check the archive.toolStatus section before compression or extraction. Do not assume zip/unzip/tar/7z exists unless the manifest says so.',
      webFetchPolicy: 'External web access is allowed only when the administrator enables it, and private/internal destinations remain blocked.',
      selfIntrospection: 'Read this manifest inside the sandbox or call the capability route to inspect effective filesystem access.',
      identityContract: 'You are the FK521AI platform assistant running inside this sandbox-capable platform runtime; backend model identifiers are implementation details unless explicitly requested by the user.',
      fileWorkflowContract: 'When the user asks to generate, export, save, package, or download a file, create the real file in the runtime filesystem and return it as an attachment or downloadable link instead of only printing the content in chat.',
      standardizedErrors: 'Sandbox authorization and file-delivery failures return stable reason codes and remediation hints.',
    },
    artifactDelivery: sandboxFileDelivery,
  };

  return {
    ...payload,
    signature: signManifest(payload),
  };
}

async function ensureSandboxCapabilityManifest(conversationId, authContext = {}) {
  const { workspaceDir } = ensureConversationSandbox(conversationId, authContext);
  const manifestsDir = path.join(workspaceDir, 'manifests');
  await fs.mkdir(manifestsDir, { recursive: true });
  const hostPath = path.join(manifestsDir, '.sandbox-capabilities.json');
  const manifest = await getSandboxCapabilityManifest(conversationId, authContext);
  await fs.writeFile(hostPath, JSON.stringify(manifest, null, 2), 'utf8');
  return {
    hostPath,
    sandboxPath: SANDBOX_PATHS.capabilityManifest,
    runtimePath: SANDBOX_PATHS.runtimeCapabilities,
    manifest,
  };
}

function getSandboxSystemPreamble(identityContext = {}) {
  const effectiveIdentityContext = identityContext.identityContext || identityContext;
  const identity = getPlatformIdentityMetadata(effectiveIdentityContext);
  const snapshot = getCachedRuntimePolicySnapshot();
  return [
    `<sandbox>`,
    `Runtime: sandbox ready for this conversation.`,
    `Identity: ${identity.modelId || identity.assistantName} ${identity.modelVersion || identity.platformVersion}.`,
    `Policy: ${snapshot.policyVersion}/${snapshot.snapshotId}.`,
    `Paths: uploads=${SANDBOX_PATHS.uploads}; workdir=${SANDBOX_PATHS.workspace}; projects=${SANDBOX_PATHS.projects}; outputs=${SANDBOX_PATHS.outputs}; manifest=${SANDBOX_PATHS.capabilityManifest}.`,
    'Rules: read uploads before claims; use workdir for temporary work; save user-facing files to outputs.',
    'Boundaries: do not claim shell/system-command access or unrestricted host/network access unless the manifest explicitly grants it.',
    '</sandbox>',
  ].join('\n');
}

function buildSandboxRuntimeContext({ tag = 'working_directory', identityContext } = {}) {
  const identity = getPlatformIdentityMetadata(identityContext);
  const snapshot = getCachedRuntimePolicySnapshot();
  const content = [
    `Sandbox runtime is already authorized.`,
    `Identity: ${identity.modelId || identity.assistantName} ${identity.modelVersion || identity.platformVersion}.`,
    `Policy: ${snapshot.policyVersion}/${snapshot.snapshotId}.`,
    `Use ${SANDBOX_PATHS.uploads} for uploaded files, ${SANDBOX_PATHS.workspace} for temporary work, ${SANDBOX_PATHS.projects} for extracted project roots, and ${SANDBOX_PATHS.outputs} for downloadable deliverables.`,
    `Inspect ${SANDBOX_PATHS.capabilityManifest} or ${SANDBOX_PATHS.runtimeCapabilities} when you need exact granted capabilities or archive/tool availability.`,
    'When the user asks for a file, create the real file in outputs instead of only printing content in chat.',
  ].join('\n');

  if (!tag) {
    return content;
  }

  return `<${tag}>
${content}
</${tag}>`;
}

function getSandboxToolDescription({ programmatic = false } = {}) {
  if (programmatic) {
    return [
      'Run orchestration code in the authorized sandbox.',
      `Paths: uploads=${SANDBOX_PATHS.uploads}; workdir=${SANDBOX_PATHS.workspace}; projects=${SANDBOX_PATHS.projects}; outputs=${SANDBOX_PATHS.outputs}.`,
      `Inspect ${SANDBOX_PATHS.capabilityManifest} for exact capabilities.`,
      'Write final user-facing files to outputs.',
    ].join(' ');
  }

  return [
    'Execute Python or JavaScript in the authorized sandbox.',
    `Paths: uploads=${SANDBOX_PATHS.uploads}; workdir=${SANDBOX_PATHS.workspace}; projects=${SANDBOX_PATHS.projects}; outputs=${SANDBOX_PATHS.outputs}.`,
    `Inspect ${SANDBOX_PATHS.capabilityManifest} for exact capabilities.`,
    'Write final user-facing files to outputs.',
  ].join(' ');
}

module.exports = {
  SANDBOX_PATHS,
  SANDBOX_ROOTS,
  getSandboxCapabilityManifest,
  ensureSandboxCapabilityManifest,
  getSandboxSystemPreamble,
  buildSandboxRuntimeContext,
  getSandboxToolDescription,
  stableStringify,
  signManifest,
  assertSandboxContractSecretConfigured,
};
