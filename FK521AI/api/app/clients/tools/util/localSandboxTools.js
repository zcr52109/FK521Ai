const fs = require('fs/promises');
const path = require('path');
const { tool } = require('@langchain/core/tools');
const { logger } = require('@fk521ai/data-schemas');
const { Tools, Constants, ContentTypes } = require('fk521ai-data-provider');
const { getConvoFiles } = require('~/models');
const { executeDockerSandbox } = require('~/server/services/Sandbox/dockerExecutor');
const {
  getWorkspaceDir,
  getTaskDir,
  sanitizeSegment,
} = require('~/server/services/Sandbox/paths');
const { syncConversationFilesToSandbox } = require('~/server/services/Sandbox/uploads');
const { createSandboxBridge } = require('~/server/services/Sandbox/bridgeServer');
const { ensureSandboxCapabilityManifest, getSandboxToolDescription } = require('~/server/services/Sandbox/runtimeContract');
const { createAttachmentDownloadLink } = require('~/server/services/DownloadLinks');
const { readDifyConsoleConfig } = require('~/server/utils/difyConsoleConfig');

function inferLanguageFromCode(code, preferred) {
  const normalized = String(preferred || '').trim().toLowerCase();
  if (['python', 'python3', 'py'].includes(normalized)) {
    return 'python';
  }
  if (['javascript', 'js', 'node', 'nodejs', 'typescript', 'ts'].includes(normalized)) {
    return 'javascript';
  }

  const source = String(code || '');
  const jsSignals = [
    /\bconsole\.log\s*\(/,
    /\bconst\s+\w+\s*=/,
    /\blet\s+\w+\s*=/,
    /\bimport\s+.+from\s+['"]/, 
    /=>/,
    /require\s*\(/,
    /process\.env/,
    /globalThis\./,
  ];

  if (jsSignals.some((pattern) => pattern.test(source))) {
    return 'javascript';
  }

  return 'python';
}

function extractCodePayload(input = {}) {
  if (typeof input === 'string') {
    return { code: input, language: undefined };
  }

  const code =
    input.code ??
    input.input ??
    input.script ??
    input.program ??
    input.source ??
    input.cell ??
    input.snippet ??
    input.content ??
    '';

  const language = input.lang ?? input.language ?? input.runtime ?? input.interpreter;

  return {
    code: typeof code === 'string' ? code : JSON.stringify(code, null, 2),
    language,
  };
}

function sanitizeToolIdentifier(name, fallback = 'tool') {
  const identifier = String(name || '')
    .trim()
    .replace(/[^a-zA-Z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^([^a-zA-Z_])/, '_$1');
  return identifier || fallback;
}

function filterProgrammaticToolDefs(toolDefs = []) {
  const nonSpecial = (toolDefs || []).filter(
    (toolDef) =>
      toolDef?.name &&
      toolDef.name !== Constants.PROGRAMMATIC_TOOL_CALLING &&
      toolDef.name !== Tools.execute_code &&
      toolDef.name !== Constants.TOOL_SEARCH,
  );

  const explicitProgrammatic = nonSpecial.filter((toolDef) =>
    Array.isArray(toolDef.allowed_callers)
      ? toolDef.allowed_callers.includes('code_execution')
      : false,
  );

  return explicitProgrammatic;
}

function mergeAttachments(first = [], second = []) {
  const map = new Map();
  for (const attachment of [...(first || []), ...(second || [])]) {
    if (!attachment) {
      continue;
    }
    const key = `${attachment.filepath || ''}|${attachment.filename || ''}`;
    if (!map.has(key)) {
      map.set(key, attachment);
    }
  }
  return [...map.values()];
}


async function decorateDownloadableAttachments(req, attachments = []) {
  if (!req || !Array.isArray(attachments) || attachments.length === 0) {
    return attachments || [];
  }

  return await Promise.all(attachments.map(async (attachment) => {
    try {
      const signedLink = await createAttachmentDownloadLink({ req, attachment });
      if (!signedLink?.download_url) {
        return attachment;
      }
      return {
        ...attachment,
        downloadURL: signedLink.download_url,
        expiresAt: signedLink.expires_at,
        policyVersion: signedLink.policy_version,
        policySnapshotId: signedLink.policy_snapshot_id,
      };
    } catch (_error) {
      return attachment;
    }
  }));
}
function formatAttachmentForConversation(file = {}) {
  const label = file.filename || file.name || 'attachment';
  return `- ${label} [通过附件下载按钮获取]`;
}

function buildCombinedArtifact({ sandboxResult, bridgeState }) {
  const bridgeArtifact = bridgeState?.aggregatedArtifact || {};
  const combined = {
    ...(bridgeArtifact || {}),
    attachments: mergeAttachments(sandboxResult.attachments || [], bridgeArtifact.attachments || []),
  };

  if (!combined.attachments.length) {
    delete combined.attachments;
  }
  if (!combined.content?.length) {
    delete combined.content;
  }

  return combined;
}

function buildSandboxResultContent({
  sandboxResult,
  syncedFiles = [],
  skippedFiles = [],
  isProgrammatic = false,
  ptcContext = null,
  bridgeState = null,
}) {
  const lines = [];

  if (isProgrammatic) {
    lines.push('Programmatic tool execution completed in the local Docker sandbox.');
  } else {
    lines.push('Code execution completed in the local Docker sandbox.');
  }

  lines.push(`sandbox_image: ${sandboxResult.image}`);
  lines.push(`cwd: ${sandboxResult.cwd}`);

  if (syncedFiles.length > 0) {
    lines.push(
      `uploaded_files:\n${syncedFiles.map((file) => `- ${file.filename} -> ${file.path}`).join('\n')}`,
    );
  }

  if (skippedFiles.length > 0) {
    lines.push(
      `skipped_uploads:\n${skippedFiles.map((file) => `- ${file.filename}: ${file.reason}`).join('\n')}`,
    );
  }

  if (ptcContext?.capabilityManifestPath) {
    lines.push(`sandbox_capabilities: ${ptcContext.capabilityManifestPath}`);
  }
  if (ptcContext?.capabilityApiPath) {
    lines.push(`sandbox_capability_api: ${ptcContext.capabilityApiPath}`);
  }

  if (ptcContext?.toolsFilePath) {
    lines.push(`available_tools_manifest: ${ptcContext.toolsFilePath}`);
  }
  if (ptcContext?.pythonBootstrapPath || ptcContext?.jsBootstrapPath) {
    lines.push(`ptc_bootstrap_python: ${ptcContext?.pythonBootstrapPath || 'n/a'}`);
    lines.push(`ptc_bootstrap_js: ${ptcContext?.jsBootstrapPath || 'n/a'}`);
  }
  if (ptcContext?.bridgeUrl) {
    lines.push(`tool_bridge: ${ptcContext.bridgeUrl}`);
  }

  if (sandboxResult.stdout) {
    lines.push(`stdout:\n${sandboxResult.stdout}`);
  }
  if (sandboxResult.stderr) {
    lines.push(`stderr:\n${sandboxResult.stderr}`);
  }

  if (bridgeState?.calls?.length > 0) {
    lines.push(
      `bridged_tool_calls:\n${bridgeState.calls
        .map((call) => {
          if (call.error) {
            return `- ${call.name}: ERROR ${call.error}`;
          }
          const summary = String(call.content || '').trim().replace(/\s+/g, ' ').slice(0, 240);
          return `- ${call.name}: ${summary || '[no textual content returned]'}`;
        })
        .join('\n')}`,
    );
  }

  if (sandboxResult.attachments?.length > 0) {
    lines.push(
      `generated_files:\n${sandboxResult.attachments
        .map((file) => formatAttachmentForConversation(file))
        .join('\n')}`,
    );
  }

  if (bridgeState?.aggregatedArtifact?.attachments?.length > 0) {
    lines.push(
      `bridged_attachments:\n${bridgeState.aggregatedArtifact.attachments
        .map((file) => formatAttachmentForConversation(file))
        .join('\n')}`,
    );
  }

  if (sandboxResult.timedOut) {
    lines.push('status: timeout');
  }
  if (sandboxResult.overflowed) {
    lines.push('status: output_truncated');
  }

  return lines.join('\n\n');
}

async function prepareConversationUploads(conversationId, user = null) {
  const conversationFileIds = conversationId ? await getConvoFiles(conversationId) : [];
  return await syncConversationFilesToSandbox({
    conversationId,
    conversationFileIds,
    user,
    authContext: { user },
  });
}

async function writeProgrammaticBootstrap({ conversationId, taskId, toolDefs = [], user = null }) {
  const workspaceDir = getWorkspaceDir(conversationId, { user });
  const ptcDir = path.join(workspaceDir, 'ptc');
  const taskDir = getTaskDir(conversationId, taskId, { user });
  await fs.mkdir(ptcDir, { recursive: true });

  const normalizedToolDefs = filterProgrammaticToolDefs(toolDefs).map((toolDef) => ({
    name: toolDef.name,
    description: toolDef.description,
    parameters: toolDef.parameters,
    allowed_callers: toolDef.allowed_callers,
    python_name: sanitizeToolIdentifier(toolDef.name),
    javascript_name: sanitizeToolIdentifier(toolDef.name),
  }));

  const manifest = {
    generatedAt: new Date().toISOString(),
    note:
      'Filesystem-first programmatic tool calling manifest. Inspect this file inside the sandbox to discover callable tools, then use the injected bridge helpers to execute them via the host runtime.',
    tools: normalizedToolDefs,
  };

  const manifestHostPath = path.join(ptcDir, 'available-tools.json');
  await fs.writeFile(manifestHostPath, JSON.stringify(manifest, null, 2), 'utf8');

  const pythonBootstrapSource = `"""
Local sandbox bootstrap for programmatic tool calling.

Injected globals:
- TOOL_DEFS: metadata loaded from /workspace/workdir/ptc/available-tools.json
- call_tool(name, args): invoke a host-side tool bridge and return structured JSON
- list_tools(): return tool definitions
- TOOLS.<tool_name>(**kwargs): ergonomic wrappers for callable tools
"""
import json
import os
import re
import urllib.error
import urllib.request
from pathlib import Path
from types import SimpleNamespace

TOOLS_MANIFEST = Path('/workspace/workdir/ptc/available-tools.json')
BRIDGE_URL = os.environ.get('FK521_TOOL_BRIDGE_URL', '').rstrip('/')
BRIDGE_TOKEN = os.environ.get('FK521_TOOL_BRIDGE_TOKEN', '')
TOOL_DEFS = json.loads(TOOLS_MANIFEST.read_text('utf-8')) if TOOLS_MANIFEST.exists() else {'tools': []}


def _bridge_request(method, endpoint, payload=None):
    if not BRIDGE_URL:
        raise RuntimeError('Tool bridge is not configured for this sandbox task')
    body = None if payload is None else json.dumps(payload).encode('utf-8')
    request = urllib.request.Request(
        f"{BRIDGE_URL}{endpoint}",
        data=body,
        method=method,
        headers={
            'Content-Type': 'application/json',
            'X-FK521-Bridge-Token': BRIDGE_TOKEN,
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            return json.loads(response.read().decode('utf-8'))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode('utf-8', errors='ignore')
        raise RuntimeError(f"Tool bridge HTTP {exc.code}: {detail}") from exc


def list_tools():
    return TOOL_DEFS.get('tools', [])


def call_tool(name, args=None):
    response = _bridge_request('POST', '/call', {'name': name, 'args': args or {}})
    if not response.get('ok'):
        raise RuntimeError(response.get('error') or f'Tool call failed: {name}')
    return response


def call_tool_text(name, args=None):
    return call_tool(name, args).get('content', '')


def _sanitize_identifier(name: str) -> str:
    identifier = re.sub(r'[^a-zA-Z0-9_]', '_', name or '').strip('_')
    if not identifier:
        identifier = 'tool'
    if not re.match(r'^[A-Za-z_]', identifier):
        identifier = '_' + identifier
    return identifier


def _make_tool_fn(tool_name: str):
    def _tool(**kwargs):
        return call_tool(tool_name, kwargs)
    _tool.__name__ = _sanitize_identifier(tool_name)
    return _tool


TOOLS = SimpleNamespace()
for _tool_def in TOOL_DEFS.get('tools', []):
    setattr(TOOLS, _sanitize_identifier(_tool_def.get('name', 'tool')), _make_tool_fn(_tool_def.get('name', 'tool')))

print(f"[ptc bootstrap] available tools: {len(TOOLS.__dict__)}")
`;

  const jsBootstrapSource = `import fs from 'node:fs';

const TOOLS_MANIFEST = '/workspace/workdir/ptc/available-tools.json';
const BRIDGE_URL = (process.env.FK521_TOOL_BRIDGE_URL || '').replace(/\/$/, '');
const BRIDGE_TOKEN = process.env.FK521_TOOL_BRIDGE_TOKEN || '';
export const TOOL_DEFS = fs.existsSync(TOOLS_MANIFEST)
  ? JSON.parse(fs.readFileSync(TOOLS_MANIFEST, 'utf8'))
  : { tools: [] };

function sanitizeToolIdentifier(name) {
  const value = String(name || '')
    .trim()
    .replace(/[^a-zA-Z0-9_]/g, '_')
    .replace(/_+/g, '_');
  if (!value) {
    return 'tool';
  }
  return /^[A-Za-z_]/.test(value) ? value : '_' + value;
}

async function bridgeRequest(method, endpoint, payload) {
  if (!BRIDGE_URL) {
    throw new Error('Tool bridge is not configured for this sandbox task');
  }
  const response = await fetch(BRIDGE_URL + endpoint, {
    method,
    headers: {
      'content-type': 'application/json',
      'x-fk521-bridge-token': BRIDGE_TOKEN,
    },
    body: payload == null ? undefined : JSON.stringify(payload),
  });
  const data = await response.json();
  if (!response.ok || !data.ok) {
    throw new Error(data.error || 'Tool bridge request failed: ' + response.status);
  }
  return data;
}

export async function listTools() {
  return TOOL_DEFS.tools || [];
}

export async function callTool(name, args = {}) {
  return await bridgeRequest('POST', '/call', { name, args });
}

export async function callToolText(name, args = {}) {
  const result = await callTool(name, args);
  return result.content || '';
}

export const TOOLS = {};
for (const toolDef of TOOL_DEFS.tools || []) {
  TOOLS[sanitizeToolIdentifier(toolDef.name)] = async (args = {}) => await callTool(toolDef.name, args);
}

globalThis.TOOL_DEFS = TOOL_DEFS;
globalThis.call_tool = callTool;
globalThis.call_tool_text = callToolText;
globalThis.TOOLS = TOOLS;
console.log('[ptc bootstrap] available tools:', Object.keys(TOOLS).length);
`;

  const pythonBootstrapHostPath = path.join(taskDir, 'ptc_bootstrap.py');
  const jsBootstrapHostPath = path.join(taskDir, 'ptc_bootstrap.mjs');
  await fs.writeFile(pythonBootstrapHostPath, pythonBootstrapSource, 'utf8');
  await fs.writeFile(jsBootstrapHostPath, jsBootstrapSource, 'utf8');

  const safeTaskId = sanitizeSegment(taskId, 'task');
  return {
    toolDefs: normalizedToolDefs,
    toolsFilePath: '/workspace/workdir/ptc/available-tools.json',
    pythonBootstrapPath: `/workspace/workdir/tasks/${safeTaskId}/ptc_bootstrap.py`,
    jsBootstrapPath: `/workspace/workdir/tasks/${safeTaskId}/ptc_bootstrap.mjs`,
  };
}

async function runSandboxExecution({
  input,
  runnableConfig,
  toolName,
  req,
  includePTCBootstrap = false,
}) {
  const { code, language } = extractCodePayload(input);
  if (!code || !String(code).trim()) {
    throw new Error('缺少可执行代码，未找到 code/input/script 字段');
  }

  const metadata = runnableConfig?.metadata ?? {};
  const configurable = runnableConfig?.configurable ?? {};
  const toolCall = runnableConfig?.toolCall ?? {};
  const conversationId =
    metadata.thread_id ?? configurable.thread_id ?? configurable.requestBody?.conversationId ?? 'new';
  const messageId = metadata.run_id ?? configurable.run_id ?? configurable.requestBody?.messageId ?? 'msg';
  const taskSuffix = toolCall.id ?? `${messageId}_${Date.now()}`;
  const taskId = `${toolName}_${sanitizeSegment(taskSuffix, 'task')}`;

  const capabilityManifest = await ensureSandboxCapabilityManifest(conversationId, { user: req?.user });
  const { syncedFiles, skippedFiles } = await prepareConversationUploads(conversationId, req?.user);

  const resolvedLanguage = inferLanguageFromCode(code, language);
  let executionCode = String(code);
  let ptcContext = null;
  let bridge = null;
  let bridgeState = null;

  try {
    const consoleConfig = readDifyConsoleConfig();

    if (includePTCBootstrap) {
      const bridgeEnabled = consoleConfig?.sandboxTools?.allowProgrammaticToolBridge === true;
      if (!bridgeEnabled) {
        throw new Error('Programmatic tool bridge is disabled by configuration');
      }

      ptcContext = await writeProgrammaticBootstrap({
        conversationId,
        taskId,
        toolDefs: toolCall.toolDefs,
        user: req?.user,
      });
      if (!Array.isArray(ptcContext.toolDefs) || ptcContext.toolDefs.length === 0) {
        throw new Error('Programmatic tool bridge has no explicitly allowed tools');
      }
      ptcContext.capabilityManifestPath = capabilityManifest.sandboxPath;

      const bridgeToolMap = toolCall.toolMap ?? configurable.ptcToolMap;
      if (bridgeToolMap?.size && ptcContext.toolDefs.length > 0) {
        bridge = await createSandboxBridge({
          toolMap: bridgeToolMap,
          toolDefs: ptcContext.toolDefs,
          configurable,
          metadata,
          parentToolName: toolName,
          parentToolCallId: toolCall.id ?? taskId,
        });
        ptcContext.bridgeUrl = bridge.serverUrl;
      } else {
        ptcContext.bridgeUrl = null;
      }

      executionCode =
        resolvedLanguage === 'javascript'
          ? `import './ptc_bootstrap.mjs';\n\n${executionCode}`
          : `from ptc_bootstrap import TOOL_DEFS, TOOLS, call_tool, call_tool_text, list_tools\n\n${executionCode}`;
    }

    const dockerOptions = {
      networkMode: consoleConfig.codeExecutor?.allowNetwork === true ? 'bridge' : 'none',
    };
    if (bridge) {
      dockerOptions.networkMode = process.env.FK521_SANDBOX_PTC_NETWORK_MODE || 'bridge';
      dockerOptions.extraDockerArgs = [];
      if (process.env.FK521_SANDBOX_BRIDGE_ADD_HOST !== 'false') {
        dockerOptions.extraDockerArgs.push('--add-host', 'host.docker.internal:host-gateway');
      }
      dockerOptions.environment = {
        FK521_TOOL_BRIDGE_URL: bridge.serverUrl,
        FK521_TOOL_BRIDGE_TOKEN: bridge.token,
      };
    }

    const sandboxResult = await executeDockerSandbox({
      conversationId,
      taskId,
      language: resolvedLanguage,
      code: executionCode,
      authContext: { user: req?.user },
      ...dockerOptions,
    });

    bridgeState = bridge?.getState?.() ?? null;
    const artifact = buildCombinedArtifact({ sandboxResult, bridgeState });
    const capabilityApiPath = `/api/files/sandbox/${encodeURIComponent(String(conversationId))}/capabilities`;
    const content = buildSandboxResultContent({
      sandboxResult,
      syncedFiles,
      skippedFiles,
      isProgrammatic: includePTCBootstrap,
      ptcContext: {
        ...(ptcContext || {}),
        capabilityManifestPath: capabilityManifest.sandboxPath,
        capabilityApiPath,
      },
      bridgeState,
    });

    const attachments = await decorateDownloadableAttachments(req, artifact.attachments || []);
    artifact.attachments = attachments;

    return [
      [
        {
          type: ContentTypes.TEXT,
          text: content,
        },
      ],
      {
        ...artifact,
        stdout: sandboxResult.stdout,
        stderr: sandboxResult.stderr,
        sandbox: {
          capabilityManifest: capabilityManifest.sandboxPath,
          capabilityApiPath,
          effectiveCapabilities: capabilityManifest.manifest,
          image: sandboxResult.image,
          cwd: sandboxResult.cwd,
          durationMs: sandboxResult.durationMs,
          exitCode: sandboxResult.exitCode,
          timedOut: sandboxResult.timedOut,
          overflowed: sandboxResult.overflowed,
          taskId: sandboxResult.taskId,
          taskDir: sandboxResult.taskDir,
          outputsDir: sandboxResult.outputsDir,
        },
        bridgeCalls: bridgeState?.calls || [],
        files: attachments.map((file, index) => ({
          id: `${sandboxResult.taskId}_${index}`,
          name: file.filename,
          url: file.filepath,
        })),
      },
    ];
  } finally {
    if (bridge) {
      await bridge.close().catch((error) => {
        logger.warn('[local sandbox] failed to close bridge server', error);
      });
    }
  }
}

const executeCodeSchema = {
  type: 'object',
  properties: {
    code: {
      type: 'string',
      description: '要执行的代码。',
    },
    input: {
      type: 'string',
      description: '兼容字段：待执行代码。',
    },
    lang: {
      type: 'string',
      description: '代码语言，支持 python / javascript。',
      enum: ['python', 'javascript'],
    },
    language: {
      type: 'string',
      description: '兼容字段：代码语言，支持 python / javascript。',
      enum: ['python', 'javascript'],
    },
  },
};

const programmaticToolSchema = {
  type: 'object',
  properties: {
    code: {
      type: 'string',
      description: 'Programmatic orchestration code to run inside the local sandbox.',
    },
    input: {
      type: 'string',
      description: 'Compatibility field for the orchestration code.',
    },
    script: {
      type: 'string',
      description: 'Compatibility field for the orchestration code.',
    },
    language: {
      type: 'string',
      description: 'Optional runtime override. Supported values: python, javascript.',
      enum: ['python', 'javascript'],
    },
    lang: {
      type: 'string',
      description: 'Compatibility field for runtime override.',
      enum: ['python', 'javascript'],
    },
  },
};

function createLocalSandboxCodeExecutionTool({ req }) {
  return tool(
    async (input, runnableConfig) =>
      await runSandboxExecution({
        input,
        runnableConfig,
        toolName: Tools.execute_code,
        req,
        includePTCBootstrap: false,
      }),
    {
      name: Tools.execute_code,
      description: getSandboxToolDescription(),
      schema: executeCodeSchema,
      responseFormat: 'content_and_artifact',
    },
  );
}

function createLocalSandboxProgrammaticToolCallingTool({ req }) {
  const consoleConfig = readDifyConsoleConfig();
  if (consoleConfig?.sandboxTools?.allowProgrammaticToolBridge !== true) {
    throw new Error('Programmatic tool bridge is disabled by configuration');
  }

  return tool(
    async (input, runnableConfig) => {
      logger.debug('[local ptc] executing in local Docker sandbox');
      return await runSandboxExecution({
        input,
        runnableConfig,
        toolName: Constants.PROGRAMMATIC_TOOL_CALLING,
        req,
        includePTCBootstrap: true,
      });
    },
    {
      name: Constants.PROGRAMMATIC_TOOL_CALLING,
      description: getSandboxToolDescription({ programmatic: true }),
      schema: programmaticToolSchema,
      responseFormat: 'content_and_artifact',
    },
  );
}

module.exports = {
  inferLanguageFromCode,
  extractCodePayload,
  filterProgrammaticToolDefs,
  createLocalSandboxCodeExecutionTool,
  createLocalSandboxProgrammaticToolCallingTool,
};
