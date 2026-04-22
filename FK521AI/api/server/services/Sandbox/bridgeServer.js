const crypto = require('crypto');
const http = require('http');
const { logger } = require('@fk521ai/data-schemas');
const { Tools, Constants } = require('fk521ai-data-provider');

function toTextContent(value) {
  if (typeof value === 'string') {
    return value;
  }

  if (Array.isArray(value)) {
    return value
      .map((part) => {
        if (part == null) {
          return '';
        }
        if (typeof part === 'string') {
          return part;
        }
        if (typeof part.text === 'string') {
          return part.text;
        }
        if (part.type === 'text' && typeof part.text === 'string') {
          return part.text;
        }
        return JSON.stringify(part);
      })
      .filter(Boolean)
      .join('\n');
  }

  if (value != null && typeof value === 'object') {
    if (typeof value.text === 'string') {
      return value.text;
    }
    return JSON.stringify(value, null, 2);
  }

  return String(value ?? '');
}

function clonePlain(value) {
  if (value == null) {
    return value;
  }
  return JSON.parse(JSON.stringify(value));
}

function mergeUniqueByKey(items = [], getKey) {
  const map = new Map();
  for (const item of items) {
    if (!item) {
      continue;
    }
    const key = getKey(item);
    if (!map.has(key)) {
      map.set(key, item);
    }
  }
  return [...map.values()];
}

function mergeWebSearchArtifacts(existing, incoming) {
  if (!existing) {
    return clonePlain(incoming);
  }
  if (!incoming) {
    return existing;
  }

  const output = { ...existing };
  const keys = new Set([...Object.keys(existing || {}), ...Object.keys(incoming || {})]);
  for (const key of keys) {
    const left = existing?.[key];
    const right = incoming?.[key];
    if (Array.isArray(left) || Array.isArray(right)) {
      output[key] = mergeUniqueByKey([...(left || []), ...(right || [])], (item) =>
        JSON.stringify(item),
      );
      continue;
    }
    if (left && right && typeof left === 'object' && typeof right === 'object') {
      output[key] = { ...left, ...right };
      continue;
    }
    output[key] = right ?? left;
  }
  return output;
}

function mergeUIResources(existing, incoming) {
  if (!existing) {
    return clonePlain(incoming);
  }
  if (!incoming) {
    return existing;
  }

  const leftData = existing.data;
  const rightData = incoming.data;
  if (Array.isArray(leftData) || Array.isArray(rightData)) {
    return {
      ...existing,
      ...incoming,
      data: mergeUniqueByKey([...(leftData || []), ...(rightData || [])], (item) =>
        JSON.stringify(item),
      ),
    };
  }

  return {
    ...existing,
    ...incoming,
    data: rightData ?? leftData,
  };
}

function mergeFileSearch(existing, incoming) {
  if (!existing) {
    return clonePlain(incoming);
  }
  if (!incoming) {
    return existing;
  }
  return {
    ...existing,
    ...incoming,
    fileCitations: Boolean(existing.fileCitations || incoming.fileCitations),
    sources: mergeUniqueByKey([...(existing.sources || []), ...(incoming.sources || [])], (item) =>
      JSON.stringify(item),
    ),
  };
}

function createArtifactAccumulator() {
  const aggregate = {
    attachments: [],
    content: [],
  };

  return {
    append(artifact) {
      if (!artifact || typeof artifact !== 'object') {
        return;
      }

      if (Array.isArray(artifact.attachments) && artifact.attachments.length > 0) {
        aggregate.attachments = mergeUniqueByKey(
          [...aggregate.attachments, ...artifact.attachments],
          (item) => `${item.filepath || ''}|${item.filename || ''}`,
        );
      }

      if (Array.isArray(artifact.content) && artifact.content.length > 0) {
        aggregate.content = mergeUniqueByKey(
          [...aggregate.content, ...artifact.content],
          (item) => JSON.stringify(item),
        );
      }

      if (artifact[Tools.file_search]) {
        aggregate[Tools.file_search] = mergeFileSearch(
          aggregate[Tools.file_search],
          artifact[Tools.file_search],
        );
      }

      if (artifact[Tools.web_search]) {
        aggregate[Tools.web_search] = mergeWebSearchArtifacts(
          aggregate[Tools.web_search],
          artifact[Tools.web_search],
        );
      }

      if (artifact[Tools.ui_resources]) {
        aggregate[Tools.ui_resources] = mergeUIResources(
          aggregate[Tools.ui_resources],
          artifact[Tools.ui_resources],
        );
      }
    },
    snapshot() {
      const normalized = { ...aggregate };
      if (!normalized.attachments?.length) {
        delete normalized.attachments;
      }
      if (!normalized.content?.length) {
        delete normalized.content;
      }
      if (!normalized[Tools.file_search]) {
        delete normalized[Tools.file_search];
      }
      if (!normalized[Tools.web_search]) {
        delete normalized[Tools.web_search];
      }
      if (!normalized[Tools.ui_resources]) {
        delete normalized[Tools.ui_resources];
      }
      return normalized;
    },
  };
}

function safeJsonParse(value) {
  try {
    return JSON.parse(value);
  } catch (_error) {
    return null;
  }
}

async function readJsonBody(req) {
  return await new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk.toString('utf8');
      if (raw.length > 1024 * 1024) {
        reject(new Error('Request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      resolve(raw ? safeJsonParse(raw) : {});
    });
    req.on('error', reject);
  });
}

async function createSandboxBridge({
  toolMap,
  toolDefs = [],
  configurable = {},
  metadata = {},
  parentToolName = Constants.PROGRAMMATIC_TOOL_CALLING,
  parentToolCallId = 'ptc',
}) {
  if (process.env.FK521_ENABLE_PROGRAMMATIC_BRIDGE_NETWORK !== 'true') {
    throw new Error('Programmatic bridge network is disabled');
  }
  const token = crypto.randomBytes(24).toString('hex');
  const bindHost = process.env.FK521_SANDBOX_BRIDGE_BIND_HOST || '127.0.0.1';
  const publicHost = process.env.FK521_SANDBOX_BRIDGE_PUBLIC_HOST || '127.0.0.1';
  const allowedToolNames = new Set(
    (toolDefs || []).map((toolDef) => toolDef.name).filter(Boolean).filter((name) => {
      return name !== Constants.PROGRAMMATIC_TOOL_CALLING && name !== Tools.execute_code;
    }),
  );
  const accumulator = createArtifactAccumulator();
  const calls = [];

  const server = http.createServer(async (req, res) => {
    try {
      if (req.headers['x-fk521-bridge-token'] !== token) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }));
        return;
      }

      const url = new URL(req.url || '/', 'http://localhost');
      if (req.method === 'GET' && url.pathname === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      if (req.method === 'GET' && url.pathname === '/tools') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            ok: true,
            tools: toolDefs,
          }),
        );
        return;
      }

      if (req.method === 'POST' && url.pathname === '/call') {
        const body = (await readJsonBody(req)) || {};
        const name = String(body.name || '').trim();
        const args = body.args && typeof body.args === 'object' ? body.args : {};

        if (!name) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'Missing tool name' }));
          return;
        }

        if (!allowedToolNames.has(name)) {
          res.writeHead(403, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: `Tool not permitted in sandbox bridge: ${name}` }));
          return;
        }

        const tool = toolMap?.get?.(name);
        if (!tool) {
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: `Tool not loaded: ${name}` }));
          return;
        }

        const nestedToolCallId = `${parentToolCallId}_bridge_${calls.length + 1}`;
        try {
          const result = await tool.invoke(args, {
            configurable,
            metadata,
            toolCall: {
              id: nestedToolCallId,
              parentToolName,
              parentToolCallId,
              bridged: true,
            },
          });

          const normalized = {
            name,
            args,
            content: toTextContent(result?.content),
            artifact: result?.artifact ? clonePlain(result.artifact) : undefined,
          };

          if (normalized.artifact) {
            accumulator.append(normalized.artifact);
          }
          calls.push(normalized);

          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true, ...normalized }));
          return;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          logger.error(`[sandbox bridge] tool ${name} failed`, error);
          calls.push({ name, args, error: message });
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: message }));
          return;
        }
      }

      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Not found' }));
    } catch (error) {
      logger.error('[sandbox bridge] request handling failed', error);
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, bindHost, () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Failed to allocate sandbox bridge port');
  }

  const serverUrl = `http://${publicHost}:${address.port}`;

  return {
    serverUrl,
    token,
    close: async () => {
      await new Promise((resolve) => server.close(() => resolve()));
    },
    getState: () => ({
      calls: clonePlain(calls),
      aggregatedArtifact: accumulator.snapshot(),
    }),
  };
}

module.exports = {
  createSandboxBridge,
  toTextContent,
};
