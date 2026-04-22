const path = require('path');

const archiveMimeTypes = new Set([
  'application/zip',
  'application/x-zip-compressed',
  'application/x-tar',
  'application/gzip',
  'application/x-gzip',
  'application/x-7z-compressed',
  'application/x-rar-compressed',
]);

const archiveExtensions = ['.zip', '.tar', '.tgz', '.tar.gz', '.7z', '.rar'];

function isArchiveFilename(filename = '') {
  const lower = String(filename || '').toLowerCase();
  return archiveExtensions.some((ext) => lower.endsWith(ext));
}

function isArchiveFile(file = {}) {
  const mime = String(file.type || file.mimeType || '').toLowerCase();
  return archiveMimeTypes.has(mime) || isArchiveFilename(file.filename || file.originalName || '');
}

function getArchiveToolStatus() {
  return {
    commands: { unzip: true, tar: true, zip: true, python: true },
    operations: { extract: true, create: true, inspect: true },
  };
}

function getSupportedArchiveSummary() {
  return archiveExtensions.join(', ');
}

function getArchiveFormat(filename = '', mimeType = '') {
  const lower = String(filename || '').toLowerCase();
  if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) return 'tar.gz';
  const ext = path.extname(lower).replace('.', '');
  return ext || String(mimeType || '').toLowerCase() || 'archive';
}

module.exports = {
  archiveMimeTypes,
  isArchiveFile,
  isArchiveFilename,
  getArchiveToolStatus,
  getSupportedArchiveSummary,
  getArchiveFormat,
};
