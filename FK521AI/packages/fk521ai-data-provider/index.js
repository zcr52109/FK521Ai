const path = require('path');

const defaultSupportedMimeTypes = [
  'application/json',
  'text/plain',
  'text/csv',
  'text/markdown',
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'image/png',
  'image/jpeg',
  'image/webp',
  'application/zip',
  'application/x-tar',
  'application/gzip',
  'application/x-bzip2',
  'application/x-xz',
  'audio/wav',
  'audio/mpeg',
  'audio/mp4',
];

const archiveExtensionRegex = /\.(zip|tar|tgz|tar\.gz|tbz2|tar\.bz2|txz|tar\.xz)$/i;

const extensionMimeMap = new Map([
  ['.json', 'application/json'],
  ['.txt', 'text/plain'],
  ['.csv', 'text/csv'],
  ['.md', 'text/markdown'],
  ['.pdf', 'application/pdf'],
  ['.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.zip', 'application/zip'],
  ['.tar', 'application/x-tar'],
  ['.gz', 'application/gzip'],
  ['.bz2', 'application/x-bzip2'],
  ['.xz', 'application/x-xz'],
  ['.wav', 'audio/wav'],
  ['.mp3', 'audio/mpeg'],
  ['.m4a', 'audio/mp4'],
]);

const fileConfig = {
  supportedMimeTypes: defaultSupportedMimeTypes,
  serverFileSizeLimit: Number(process.env.FK521_UPLOAD_MAX_BYTES || 50 * 1024 * 1024),
  checkType(mimeType, supportedMimeTypes = defaultSupportedMimeTypes) {
    return Array.isArray(supportedMimeTypes) && supportedMimeTypes.includes(String(mimeType || '').toLowerCase());
  },
};

function mergeFileConfig(customConfig = {}) {
  return {
    ...fileConfig,
    ...customConfig,
    supportedMimeTypes: customConfig.supportedMimeTypes || fileConfig.supportedMimeTypes,
    serverFileSizeLimit: customConfig.serverFileSizeLimit || fileConfig.serverFileSizeLimit,
  };
}

function inferMimeType(filename = '', fallback = '') {
  const ext = path.extname(String(filename || '')).toLowerCase();
  return extensionMimeMap.get(ext) || fallback || 'application/octet-stream';
}

function getEndpointFileConfig({ fileConfig: runtimeFileConfig } = {}) {
  const merged = mergeFileConfig(runtimeFileConfig);
  return {
    supportedMimeTypes: merged.supportedMimeTypes,
  };
}

module.exports = {
  mergeFileConfig,
  inferMimeType,
  getEndpointFileConfig,
  archiveExtensionRegex,
  fileConfig,
};
