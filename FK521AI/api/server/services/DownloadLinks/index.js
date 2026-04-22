const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { logger } = require('@fk521ai/data-schemas');
const { FileSources } = require('fk521ai-data-provider');
const { getFiles, getConvo } = require('~/models');
const { cleanFileName } = require('~/server/utils/files');
const { buildContentDisposition, getDisplayFilename } = require('@fk521ai/api');
const { getStrategyFunctions } = require('~/server/services/Files/strategies');
const { resolveConversationFile } = require('~/server/services/Sandbox/paths');
const { classifySandboxRelativePath } = require('~/server/services/Sandbox/paths');
const { getCachedRuntimePolicySnapshot } = require('~/server/services/RuntimePolicy');

const DEFAULT_TTL_SECONDS = Math.max(60, Number(process.env.FK521_DOWNLOAD_LINK_TTL_SECONDS || 900));
const DEFAULT_DOWNLOAD_ROUTE = '/api/downloads/dl';

function getSecret() {
  const secret = String(
    process.env.FK521_DOWNLOAD_LINK_SECRET || process.env.FK521_SANDBOX_CONTRACT_SECRET || '',
  ).trim();
  if (!secret) {
    const error = new Error(
      'Missing required secret: FK521_DOWNLOAD_LINK_SECRET (or FK521_SANDBOX_CONTRACT_SECRET fallback).',
    );
    error.code = 'DOWNLOAD_SECRET_REQUIRED';
    throw error;
  }
  return secret;
}

function assertDownloadSecretConfigured() {
  return getSecret();
}

function base64url(input) {
  return Buffer.from(input).toString('base64url');
}

function fromBase64url(input) {
  return Buffer.from(String(input || ''), 'base64url').toString('utf8');
}

function signPayload(payload) {
  const serialized = JSON.stringify(payload);
  const body = base64url(serialized);
  const sig = crypto.createHmac('sha256', getSecret()).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function verifySignedToken(token) {
  const [body, sig] = String(token || '').split('.');
  if (!body || !sig) {
    const error = new Error('Malformed token');
    error.code = 'DOWNLOAD_TOKEN_MALFORMED';
    throw error;
  }
  const expectedSig = crypto.createHmac('sha256', getSecret()).update(body).digest('base64url');
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSig))) {
    const error = new Error('Invalid token signature');
    error.code = 'DOWNLOAD_TOKEN_INVALID';
    throw error;
  }
  const payload = JSON.parse(fromBase64url(body));
  if (!payload.exp || Date.now() > Number(payload.exp)) {
    const error = new Error('Download token expired');
    error.code = 'DOWNLOAD_TOKEN_EXPIRED';
    throw error;
  }
  return payload;
}

function getBaseUrl(req) {
  const configured = String(process.env.DOMAIN_SERVER || process.env.DOMAIN_CLIENT || '').trim().replace(/\/$/, '');
  if (configured) {
    return configured;
  }
  if (String(process.env.FK521_ALLOW_REQUEST_HOST_BASE_URL || '').trim().toLowerCase() !== 'true') {
    return '';
  }
  const host = String(req?.headers?.host || '').trim();
  const protocol = req?.protocol || 'http';
  return host ? `${protocol}://${host}` : '';
}

function buildAbsoluteDownloadUrl(req, token) {
  const relative = `${DEFAULT_DOWNLOAD_ROUTE}?t=${encodeURIComponent(token)}`;
  const baseUrl = getBaseUrl(req);
  return baseUrl ? `${baseUrl}${relative}` : relative;
}

function buildRelativeDownloadPath(token) {
  return `${DEFAULT_DOWNLOAD_ROUTE}?t=${encodeURIComponent(token)}`;
}

function createSignedClaims(payload = {}, ttlSeconds = DEFAULT_TTL_SECONDS) {
  const expiresAt = Date.now() + Math.max(30, Number(ttlSeconds || DEFAULT_TTL_SECONDS)) * 1000;
  return {
    v: 1,
    exp: expiresAt,
    method: 'GET',
    nonce: crypto.randomUUID(),
    ...payload,
  };
}

async function createFileDownloadLink({
  req,
  file,
  ttlSeconds = DEFAULT_TTL_SECONDS,
  absolute = false,
}) {
  if (!file) {
    const error = new Error('File not found');
    error.code = 'FILE_NOT_FOUND';
    throw error;
  }

  if (
    String(file.source) === FileSources.local ||
    String(file.source) === FileSources.firebase ||
    String(file.source) === FileSources.s3 ||
    String(file.source) === FileSources.azure_blob
  ) {
    const absolutePath = resolveLocalAbsolutePath(req, file.filepath);
    if (!absolutePath) {
      const error = new Error('File path unavailable for download');
      error.code = 'FILE_NOT_FOUND';
      throw error;
    }
    try {
      const stat = await fsp.stat(absolutePath);
      if (!stat.isFile()) {
        const error = new Error('File path is not a file');
        error.code = 'FILE_NOT_FOUND';
        throw error;
      }
      await fsp.access(absolutePath, fs.constants.R_OK);
    } catch (error) {
      if (error?.code === 'ENOENT') {
        const notFound = new Error('File not found');
        notFound.code = 'FILE_NOT_FOUND';
        throw notFound;
      }
      if (error?.code === 'EACCES' || error?.code === 'EPERM') {
        const forbidden = new Error('File exists but is not readable');
        forbidden.code = 'FILE_ACCESS_DENIED';
        throw forbidden;
      }
      throw error;
    }
  }

  const snapshot = getCachedRuntimePolicySnapshot();
  const claims = createSignedClaims(
    {
      kind: 'file',
      file_id: file.file_id,
      owner: String(req.user?.id || ''),
      tenantId: String(req.user?.tenantId || ''),
      conversationId: String(file.conversationId || ''),
      filename: getDisplayFilename(cleanFileName(file.filename || 'download'), 'download'),
      policy_snapshot_id: snapshot.snapshotId,
    },
    ttlSeconds,
  );
  const token = signPayload(claims);
  const downloadPath = buildRelativeDownloadPath(token);
  const downloadURL = absolute ? buildAbsoluteDownloadUrl(req, token) : downloadPath;
  return {
    download_path: downloadPath,
    download_url: downloadURL,
    expires_at: new Date(claims.exp).toISOString(),
    token,
    policy_version: snapshot.policyVersion,
    policy_snapshot_id: snapshot.snapshotId,
  };
}

async function createSandboxDownloadLink({
  req,
  conversationId,
  relativePath,
  filename,
  ttlSeconds = DEFAULT_TTL_SECONDS,
  absolute = false,
}) {
  const classification = classifySandboxRelativePath(relativePath);
  if (!classification.downloadAllowed) {
    const error = new Error('Sandbox path is not downloadable');
    error.code = 'SANDBOX_DOWNLOAD_FORBIDDEN';
    throw error;
  }

  let resolved;
  try {
    resolved = await resolveConversationFile(conversationId, classification.normalizedPath, {
      authContext: { user: req.user },
    });
    const stat = await fsp.stat(resolved.absolutePath);
    if (!stat.isFile()) {
      const error = new Error('Sandbox download target is not a file');
      error.code = 'FILE_NOT_FOUND';
      throw error;
    }
    await fsp.access(resolved.absolutePath, fs.constants.R_OK);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      const notFound = new Error('Sandbox file not found');
      notFound.code = 'FILE_NOT_FOUND';
      throw notFound;
    }
    if (error?.code === 'EACCES' || error?.code === 'EPERM') {
      const forbidden = new Error('Sandbox file exists but is not readable');
      forbidden.code = 'FILE_ACCESS_DENIED';
      throw forbidden;
    }
    throw error;
  }

  const snapshot = getCachedRuntimePolicySnapshot();
  const claims = createSignedClaims(
    {
      kind: 'sandbox',
      conversationId: String(conversationId),
      relativePath: resolved.normalizedPath,
      owner: String(req.user?.id || ''),
      tenantId: String(req.user?.tenantId || ''),
      filename: getDisplayFilename(cleanFileName(filename || path.basename(resolved.normalizedPath) || 'download'), 'download'),
      policy_snapshot_id: snapshot.snapshotId,
    },
    ttlSeconds,
  );
  const token = signPayload(claims);
  const downloadPath = buildRelativeDownloadPath(token);
  const downloadURL = absolute ? buildAbsoluteDownloadUrl(req, token) : downloadPath;
  return {
    download_path: downloadPath,
    download_url: downloadURL,
    expires_at: new Date(claims.exp).toISOString(),
    token,
    policy_version: snapshot.policyVersion,
    policy_snapshot_id: snapshot.snapshotId,
  };
}

async function createAttachmentDownloadLink({
  req,
  attachment,
  ttlSeconds = DEFAULT_TTL_SECONDS,
  absolute = false,
}) {
  if (!attachment) {
    return null;
  }

  if (attachment.file_id) {
    return await createFileDownloadLink({ req, file: attachment, ttlSeconds, absolute });
  }

  const downloadPath = String(attachment.downloadPath || attachment.filepath || '').trim();
  const sandboxMatch = downloadPath.match(/^\/api\/files\/sandbox\/([^?]+)\?path=(.+)$/);
  if (sandboxMatch) {
    return await createSandboxDownloadLink({
      req,
      conversationId: decodeURIComponent(sandboxMatch[1]),
      relativePath: decodeURIComponent(sandboxMatch[2]),
      filename: attachment.filename,
      ttlSeconds,
      absolute,
    });
  }

  return null;
}

async function assertFileAccess({ userId, tenantId, fileId }) {
  const [file] = await getFiles({ file_id: fileId });
  if (!file) {
    const error = new Error('File not found');
    error.code = 'FILE_NOT_FOUND';
    throw error;
  }
  if (String(file.user || '') !== String(userId || '')) {
    const error = new Error('Forbidden');
    error.code = 'FILE_ACCESS_DENIED';
    throw error;
  }
  if (tenantId && String(file.tenantId || '') !== String(tenantId || '')) {
    const error = new Error('Forbidden');
    error.code = 'FILE_ACCESS_DENIED';
    throw error;
  }
  return file;
}

async function assertConversationAccess({ userId, tenantId, conversationId }) {
  const conversation = await getConvo(userId, conversationId);
  if (!conversation) {
    const error = new Error('Conversation not found');
    error.code = 'CONVERSATION_NOT_FOUND';
    throw error;
  }
  if (tenantId && String(conversation.tenantId || '') !== String(tenantId || '')) {
    const error = new Error('Forbidden');
    error.code = 'CONVERSATION_ACCESS_DENIED';
    throw error;
  }
  return conversation;
}

function createEtag(stats, absolutePath) {
  return `W/\"${stats.size}-${Number(stats.mtimeMs)}-${crypto.createHash('sha1').update(String(absolutePath)).digest('hex').slice(0, 12)}\"`;
}

function setDownloadHeaders(res, { filename, type, size, etag }) {
  res.setHeader('Content-Type', type || 'application/octet-stream');
  res.setHeader('Content-Disposition', buildContentDisposition(getDisplayFilename(cleanFileName(filename || 'download'), 'download'), 'download'));
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('ETag', etag);
  if (size != null) {
    res.setHeader('Content-Length', String(size));
  }
}

function parseRangeHeader(rangeHeader, size) {
  if (!rangeHeader || !/^bytes=/.test(rangeHeader)) {
    return null;
  }
  const [startRaw, endRaw] = String(rangeHeader).replace(/^bytes=/, '').split('-');
  let start = startRaw === '' ? null : Number(startRaw);
  let end = endRaw === '' ? null : Number(endRaw);
  if (start == null && end == null) {
    return null;
  }
  if (start == null) {
    const suffixLength = end;
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) {
      return null;
    }
    start = Math.max(0, size - suffixLength);
    end = size - 1;
  }
  if (!Number.isFinite(start) || start < 0) {
    return null;
  }
  if (end == null || !Number.isFinite(end) || end >= size) {
    end = size - 1;
  }
  if (start > end || start >= size) {
    return null;
  }
  return { start, end };
}

async function streamLocalFile(res, absolutePath, { filename, type }, req) {
  const stats = await fsp.stat(absolutePath);
  const etag = createEtag(stats, absolutePath);
  const ifRange = String(req.headers['if-range'] || '').trim();
  const requestedRange = parseRangeHeader(req.headers.range, stats.size);
  const useRange = requestedRange && (!ifRange || ifRange === etag);

  if (useRange) {
    const { start, end } = requestedRange;
    const chunkSize = end - start + 1;
    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${stats.size}`);
    setDownloadHeaders(res, { filename, type, size: chunkSize, etag });
    fs.createReadStream(absolutePath, { start, end }).pipe(res);
    return;
  }

  res.status(200);
  setDownloadHeaders(res, { filename, type, size: stats.size, etag });
  fs.createReadStream(absolutePath).pipe(res);
}

function resolveLocalAbsolutePath(req, filepath) {
  const appConfig = req.config;
  if (!filepath) {
    return null;
  }

  if (filepath.includes('/uploads/')) {
    const basePath = filepath.split('/uploads/')[1];
    return path.join(appConfig.paths.uploads, basePath);
  }
  if (filepath.includes('/images/')) {
    const basePath = filepath.split('/images/')[1];
    return path.join(appConfig.paths.imageOutput, basePath);
  }
  return filepath;
}

async function resolveDownloadResource(req, claims) {
  if (claims.kind === 'sandbox') {
    await assertConversationAccess({
      userId: claims.owner,
      tenantId: claims.tenantId,
      conversationId: claims.conversationId,
    });
    const classification = classifySandboxRelativePath(claims.relativePath);
    if (!classification.downloadAllowed) {
      const error = new Error('Sandbox path is not downloadable');
      error.code = 'SANDBOX_DOWNLOAD_FORBIDDEN';
      throw error;
    }
    const resolved = await resolveConversationFile(claims.conversationId, claims.relativePath, {
      authContext: { userId: claims.owner, tenantId: claims.tenantId },
    });
    return {
      absolutePath: resolved.absolutePath,
      filename: claims.filename || path.basename(resolved.normalizedPath),
      type: 'application/octet-stream',
    };
  }

  if (claims.kind === 'file') {
    const file = await assertFileAccess({
      userId: claims.owner,
      tenantId: claims.tenantId,
      fileId: claims.file_id,
    });
    if (claims.conversationId) {
      await assertConversationAccess({
        userId: claims.owner,
        tenantId: claims.tenantId,
        conversationId: claims.conversationId,
      });
      if (String(file.conversationId || '') !== String(claims.conversationId || '')) {
        const error = new Error('Forbidden');
        error.code = 'FILE_ACCESS_DENIED';
        throw error;
      }
    }
    if (String(file.source) === FileSources.local || String(file.source) === FileSources.firebase || String(file.source) === FileSources.s3 || String(file.source) === FileSources.azure_blob) {
      const absolutePath = resolveLocalAbsolutePath(req, file.filepath);
      return {
        absolutePath,
        filename: claims.filename || file.filename,
        type: file.type || 'application/octet-stream',
      };
    }

    return {
      file,
      filename: claims.filename || file.filename,
      type: file.type || 'application/octet-stream',
    };
  }

  const error = new Error('Unsupported resource kind');
  error.code = 'DOWNLOAD_KIND_UNSUPPORTED';
  throw error;
}

async function streamSignedDownload(req, res, claims) {
  const resource = await resolveDownloadResource(req, claims);
  if (resource.absolutePath) {
    return await streamLocalFile(res, resource.absolutePath, resource, req);
  }

  const { file } = resource;
  const { getDownloadStream } = getStrategyFunctions(file.source);
  if (typeof getDownloadStream !== 'function') {
    const error = new Error('Download streaming not supported for file source');
    error.code = 'DOWNLOAD_STREAM_UNSUPPORTED';
    throw error;
  }

  const stream = await getDownloadStream(req, file.filepath);
  res.status(200);
  setDownloadHeaders(res, {
    filename: resource.filename,
    type: resource.type,
    size: file.bytes,
    etag: `W/\"${file.file_id || resource.filename}\"`,
  });
  stream.pipe(res);
}

module.exports = {
  DEFAULT_TTL_SECONDS,
  assertConversationAccess,
  assertFileAccess,
  buildAbsoluteDownloadUrl,
  buildRelativeDownloadPath,
  createAttachmentDownloadLink,
  createFileDownloadLink,
  createSandboxDownloadLink,
  assertDownloadSecretConfigured,
  resolveDownloadResource,
  signPayload,
  verifySignedToken,
  streamSignedDownload,
};
