const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const yauzl = require('yauzl');
const { execFile, spawnSync } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);
const PYTHON_SCRIPT_DIR = path.join(__dirname, 'scripts');

const DEFAULT_MAX_ENTRIES = Number(process.env.FK521_PROJECT_ARCHIVE_MAX_ENTRIES || 12000);
const DEFAULT_MAX_TOTAL_BYTES = Number(
  process.env.FK521_PROJECT_ARCHIVE_MAX_TOTAL_BYTES || 1024 * 1024 * 1024,
);
const DEFAULT_LIST_MAX_ENTRIES = Number(process.env.FK521_PROJECT_ARCHIVE_LIST_MAX_ENTRIES || 200);
const DEFAULT_INSPECT_MAX_ENTRIES = Number(process.env.FK521_PROJECT_ARCHIVE_INSPECT_MAX_ENTRIES || 500);

const ARCHIVE_FORMATS = Object.freeze({
  zip: {
    id: 'zip',
    extensions: ['.zip'],
    outputExtension: '.zip',
    mimeTypes: ['application/zip'],
    label: 'ZIP archive',
  },
  tar: {
    id: 'tar',
    extensions: ['.tar'],
    outputExtension: '.tar',
    mimeTypes: ['application/x-tar'],
    label: 'tar archive',
  },
  targz: {
    id: 'tar.gz',
    extensions: ['.tar.gz', '.tgz'],
    outputExtension: '.tar.gz',
    mimeTypes: ['application/gzip', 'application/x-gzip'],
    label: 'tar.gz archive',
  },
  tarbz2: {
    id: 'tar.bz2',
    extensions: ['.tar.bz2', '.tbz2'],
    outputExtension: '.tar.bz2',
    mimeTypes: ['application/x-bzip2'],
    label: 'tar.bz2 archive',
  },
  tarxz: {
    id: 'tar.xz',
    extensions: ['.tar.xz', '.txz'],
    outputExtension: '.tar.xz',
    mimeTypes: ['application/x-xz'],
    label: 'tar.xz archive',
  },
});

const SUPPORTED_ARCHIVE_FORMAT_IDS = Object.freeze(
  Object.values(ARCHIVE_FORMATS).map((format) => format.id),
);
const SUPPORTED_ARCHIVE_EXTENSIONS = Object.freeze(
  Object.values(ARCHIVE_FORMATS)
    .flatMap((format) => format.extensions)
    .sort((a, b) => b.length - a.length),
);

function ensureWithinRoot(rootDir, targetPath) {
  const resolvedRoot = path.resolve(rootDir);
  const resolvedTarget = path.resolve(targetPath);
  if (resolvedTarget === resolvedRoot || resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`)) {
    return resolvedTarget;
  }
  throw new Error(`Archive entry escapes destination root: ${targetPath}`);
}

function sanitizeArchiveEntry(entryName) {
  const normalized = String(entryName || '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .split('/');

  const safeParts = [];
  for (const part of normalized) {
    if (!part || part === '.' || part === '..') {
      continue;
    }
    safeParts.push(part);
  }

  if (safeParts.length === 0) {
    return null;
  }

  return safeParts.join('/');
}

function findFormatByExtension(filename = '') {
  const lower = String(filename || '').toLowerCase();
  for (const extension of SUPPORTED_ARCHIVE_EXTENSIONS) {
    if (lower.endsWith(extension)) {
      return Object.values(ARCHIVE_FORMATS).find((format) => format.extensions.includes(extension)) || null;
    }
  }
  return null;
}

function findFormatByMimeType(type = '') {
  const lower = String(type || '').toLowerCase();
  return (
    Object.values(ARCHIVE_FORMATS).find((format) =>
      (format.mimeTypes || []).some((mimeType) => mimeType === lower),
    ) || null
  );
}

function detectArchiveFormat(input = {}) {
  if (typeof input === 'string') {
    return findFormatByExtension(input) || null;
  }

  return findFormatByExtension(input.filename) || findFormatByMimeType(input.type) || null;
}

function isSupportedArchive(input = {}) {
  return Boolean(detectArchiveFormat(input));
}

function getSupportedArchiveSummary() {
  return Object.values(ARCHIVE_FORMATS)
    .map((format) => format.extensions.join('/'))
    .join(', ');
}

function isCommandAvailable(command, args = ['--help']) {
  try {
    const result = spawnSync(command, args, {
      stdio: 'ignore',
      encoding: 'utf8',
    });
    return result.error?.code !== 'ENOENT';
  } catch (_error) {
    return false;
  }
}

function getArchiveToolStatus() {
  const commands = {
    zip: isCommandAvailable('zip'),
    unzip: isCommandAvailable('unzip'),
    tar: isCommandAvailable('tar'),
    '7z': isCommandAvailable('7z'),
    python3: isCommandAvailable('python3', ['--version']),
  };

  return {
    commands,
    operations: {
      inspectArchive: {
        available: Boolean(commands.python3),
        backend: commands.python3 ? 'python3' : null,
      },
      validateArchive: {
        available: Boolean(commands.python3),
        backend: commands.python3 ? 'python3' : null,
      },
      listZip: { available: true, backend: 'yauzl' },
      extractZip: { available: true, backend: 'yauzl' },
      listTar: {
        available: Boolean(commands.tar || commands.python3),
        backend: commands.tar ? 'tar' : commands.python3 ? 'python3' : null,
      },
      extractTar: {
        available: Boolean(commands.python3 || commands.tar),
        backend: commands.python3 ? 'python3' : commands.tar ? 'tar' : null,
      },
      createZip: {
        available: Boolean(commands.zip || commands.python3),
        backend: commands.zip ? 'zip' : commands.python3 ? 'python3' : null,
      },
      createTar: {
        available: Boolean(commands.tar || commands.python3),
        backend: commands.tar ? 'tar' : commands.python3 ? 'python3' : null,
      },
    },
  };
}

async function getDirectorySize(dirPath) {
  let totalSize = 0;
  const entries = await fsp.readdir(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    const entryPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      totalSize += await getDirectorySize(entryPath);
    } else {
      const stats = await fsp.stat(entryPath);
      totalSize += Number(stats.size);
    }
  }

  return totalSize;
}

async function getSourceSize(hostPath, stats) {
  if (stats.isDirectory()) {
    return getDirectorySize(hostPath);
  }
  return Number(stats.size);
}

function normalizeArchiveFormatId(value) {
  const input = String(value || '').trim().toLowerCase();
  if (!input) {
    return '';
  }
  if (input === 'tgz') {
    return 'tar.gz';
  }
  if (input === 'tbz2') {
    return 'tar.bz2';
  }
  if (input === 'txz') {
    return 'tar.xz';
  }
  return input;
}

function resolveArchiveFormat({ archivePath, format }) {
  const normalizedFormat = normalizeArchiveFormatId(format);
  return (
    Object.values(ARCHIVE_FORMATS).find((candidate) => candidate.id === normalizedFormat) ||
    detectArchiveFormat(archivePath)
  );
}

async function execPythonJson(script, args, maxBuffer = 30 * 1024 * 1024) {
  const { stdout } = await execFileAsync('python3', ['-c', script, ...args], {
    maxBuffer,
  });
  return JSON.parse(String(stdout || '{}'));
}

async function runPythonScriptFile(scriptName, args = [], maxBuffer = 50 * 1024 * 1024) {
  const scriptPath = path.join(PYTHON_SCRIPT_DIR, scriptName);
  await fsp.access(scriptPath);
  return await execFileAsync('python3', [scriptPath, ...args], { maxBuffer });
}

const PYTHON_ARCHIVE_INSPECT_SCRIPT = String.raw`
import json, mimetypes, os, re, sys, tarfile, zipfile

archive_path, requested_format, max_entries = sys.argv[1:4]
max_entries = int(max_entries)
requested_format = (requested_format or '').strip().lower()

FORMATS = [('.tar.gz', 'tar.gz'), ('.tgz', 'tar.gz'), ('.tar.bz2', 'tar.bz2'), ('.tbz2', 'tar.bz2'), ('.tar.xz', 'tar.xz'), ('.txz', 'tar.xz'), ('.tar', 'tar'), ('.zip', 'zip')]

def detect_format(path_value, explicit):
    if explicit:
        if explicit == 'tgz':
            explicit = 'tar.gz'
        if explicit == 'tbz2':
            explicit = 'tar.bz2'
        if explicit == 'txz':
            explicit = 'tar.xz'
        return explicit
    lower = path_value.lower()
    for ext, fmt in FORMATS:
        if lower.endswith(ext):
            return fmt
    raise RuntimeError('Unsupported archive format')

_drive_re = re.compile(r'^[A-Za-z]:[\\/]')

def inspect_name(name):
    original = str(name or '')
    normalized = original.replace('\\', '/')
    parts = normalized.split('/')
    has_parent = any(part == '..' for part in parts)
    is_abs = normalized.startswith('/') or bool(_drive_re.match(original))
    sanitized = '/'.join([part for part in normalized.lstrip('/').split('/') if part not in ('', '.', '..')])
    dangerous = bool(has_parent or is_abs)
    return {
        'originalPath': original,
        'normalizedPath': normalized,
        'sanitizedPath': sanitized or None,
        'hasDangerousPath': dangerous,
        'isAbsolutePath': bool(is_abs),
        'hasTraversal': bool(has_parent),
        'isEmptyName': normalized.strip() == '',
    }

fmt = detect_format(archive_path, requested_format)
result = {
    'format': fmt,
    'entryCount': 0,
    'truncated': False,
    'encryptedEntries': 0,
    'dangerousEntries': 0,
    'members': [],
    'totalUncompressedBytes': 0,
    'totalCompressedBytes': 0,
}

if fmt == 'zip':
    with zipfile.ZipFile(archive_path, 'r') as archive:
        infos = archive.infolist()
        result['entryCount'] = len(infos)
        for info in infos:
            meta = inspect_name(info.filename)
            result['dangerousEntries'] += 1 if meta['hasDangerousPath'] else 0
            encrypted = bool(getattr(info, 'flag_bits', 0) & 0x1)
            result['encryptedEntries'] += 1 if encrypted else 0
            result['totalUncompressedBytes'] += int(getattr(info, 'file_size', 0) or 0)
            result['totalCompressedBytes'] += int(getattr(info, 'compress_size', 0) or 0)
            if len(result['members']) >= max_entries:
                result['truncated'] = True
                continue
            compressed_size = int(getattr(info, 'compress_size', 0) or 0)
            uncompressed_size = int(getattr(info, 'file_size', 0) or 0)
            result['members'].append({
                **meta,
                'path': meta['sanitizedPath'] or meta['normalizedPath'] or meta['originalPath'],
                'isDirectory': info.is_dir(),
                'size': uncompressed_size,
                'compressedSize': compressed_size,
                'compressionRatio': round((uncompressed_size / compressed_size), 4) if compressed_size else None,
                'mimeType': mimetypes.guess_type(info.filename)[0] or 'application/octet-stream',
                'encrypted': encrypted,
                'crc32': format(int(getattr(info, 'CRC', 0) or 0) & 0xFFFFFFFF, '08x'),
            })
else:
    with tarfile.open(archive_path, 'r:*') as archive:
        members = archive.getmembers()
        result['entryCount'] = len(members)
        for member in members:
            meta = inspect_name(member.name)
            result['dangerousEntries'] += 1 if meta['hasDangerousPath'] else 0
            size = int(getattr(member, 'size', 0) or 0)
            result['totalUncompressedBytes'] += size
            if len(result['members']) >= max_entries:
                result['truncated'] = True
                continue
            result['members'].append({
                **meta,
                'path': meta['sanitizedPath'] or meta['normalizedPath'] or meta['originalPath'],
                'isDirectory': member.isdir(),
                'size': size,
                'compressedSize': None,
                'compressionRatio': None,
                'mimeType': mimetypes.guess_type(member.name)[0] or 'application/octet-stream',
                'encrypted': False,
                'crc32': None,
            })

print(json.dumps(result))
`;

const PYTHON_ARCHIVE_VALIDATE_SCRIPT = String.raw`
import hashlib, json, os, re, sys, tarfile, zipfile, zlib

archive_path, requested_format, expected_sha256, include_member_hashes = sys.argv[1:5]
include_member_hashes = include_member_hashes.lower() in ('1', 'true', 'yes', 'on')
expected_sha256 = (expected_sha256 or '').strip().lower() or None
requested_format = (requested_format or '').strip().lower()

FORMATS = [('.tar.gz', 'tar.gz'), ('.tgz', 'tar.gz'), ('.tar.bz2', 'tar.bz2'), ('.tbz2', 'tar.bz2'), ('.tar.xz', 'tar.xz'), ('.txz', 'tar.xz'), ('.tar', 'tar'), ('.zip', 'zip')]
_drive_re = re.compile(r'^[A-Za-z]:[\\/]')

def detect_format(path_value, explicit):
    if explicit:
        if explicit == 'tgz':
            explicit = 'tar.gz'
        if explicit == 'tbz2':
            explicit = 'tar.bz2'
        if explicit == 'txz':
            explicit = 'tar.xz'
        return explicit
    lower = path_value.lower()
    for ext, fmt in FORMATS:
        if lower.endswith(ext):
            return fmt
    raise RuntimeError('Unsupported archive format')


def sha256_file(path_value):
    h = hashlib.sha256()
    with open(path_value, 'rb') as f:
        while True:
            chunk = f.read(1024 * 1024)
            if not chunk:
                break
            h.update(chunk)
    return h.hexdigest()


def inspect_name(name):
    original = str(name or '')
    normalized = original.replace('\\', '/')
    parts = normalized.split('/')
    has_parent = any(part == '..' for part in parts)
    is_abs = normalized.startswith('/') or bool(_drive_re.match(original))
    sanitized = '/'.join([part for part in normalized.lstrip('/').split('/') if part not in ('', '.', '..')])
    dangerous = bool(has_parent or is_abs)
    canonical = (sanitized or normalized or original).rstrip('/')
    return {
        'original': original,
        'normalized': normalized,
        'sanitized': sanitized or None,
        'dangerous': dangerous,
        'empty': normalized.strip() == '',
        'canonical': canonical,
    }

fmt = detect_format(archive_path, requested_format)
archive_sha256 = sha256_file(archive_path)
structure = {
    'duplicatePaths': [],
    'emptyNames': [],
    'dangerousPaths': [],
    'pathTypeConflicts': [],
}
member_hashes = []
seen = {}
entry_types = {}
encrypted_entries = []
crc_failed = []
crc_skipped = []
validated_entries = 0
member_count = 0

if fmt == 'zip':
    with zipfile.ZipFile(archive_path, 'r') as archive:
        for info in archive.infolist():
            member_count += 1
            meta = inspect_name(info.filename)
            if meta['empty']:
                structure['emptyNames'].append(info.filename)
            if meta['dangerous']:
                structure['dangerousPaths'].append(info.filename)
            key = meta['canonical']
            if key:
                seen[key] = seen.get(key, 0) + 1
                current_type = 'directory' if info.is_dir() else 'file'
                if key in entry_types and entry_types[key] != current_type:
                    structure['pathTypeConflicts'].append(key)
                entry_types[key] = current_type
            if bool(getattr(info, 'flag_bits', 0) & 0x1):
                encrypted_entries.append(info.filename)
                crc_skipped.append(info.filename)
                continue
            if info.is_dir():
                continue
            source = archive.open(info, 'r')
            digest = hashlib.sha256()
            crc = 0
            with source:
                while True:
                    chunk = source.read(1024 * 1024)
                    if not chunk:
                        break
                    digest.update(chunk)
                    crc = zlib.crc32(chunk, crc)
            observed_crc = crc & 0xFFFFFFFF
            expected_crc = int(getattr(info, 'CRC', 0) or 0) & 0xFFFFFFFF
            validated_entries += 1
            if observed_crc != expected_crc:
                crc_failed.append({
                    'path': info.filename,
                    'expected': format(expected_crc, '08x'),
                    'observed': format(observed_crc, '08x'),
                })
            elif include_member_hashes:
                member_hashes.append({
                    'path': info.filename,
                    'sha256': digest.hexdigest(),
                    'crc32': format(observed_crc, '08x'),
                })
else:
    with tarfile.open(archive_path, 'r:*') as archive:
        for member in archive.getmembers():
            member_count += 1
            meta = inspect_name(member.name)
            if meta['empty']:
                structure['emptyNames'].append(member.name)
            if meta['dangerous']:
                structure['dangerousPaths'].append(member.name)
            key = meta['canonical']
            if key:
                seen[key] = seen.get(key, 0) + 1
                current_type = 'directory' if member.isdir() else 'file'
                if key in entry_types and entry_types[key] != current_type:
                    structure['pathTypeConflicts'].append(key)
                entry_types[key] = current_type
            if not (member.isfile() or member.isreg()):
                continue
            source = archive.extractfile(member)
            if source is None:
                raise RuntimeError(f'Unable to read archive entry: {member.name}')
            digest = hashlib.sha256()
            crc = 0
            with source:
                while True:
                    chunk = source.read(1024 * 1024)
                    if not chunk:
                        break
                    digest.update(chunk)
                    crc = zlib.crc32(chunk, crc)
            validated_entries += 1
            if include_member_hashes:
                member_hashes.append({
                    'path': member.name,
                    'sha256': digest.hexdigest(),
                    'crc32': format(crc & 0xFFFFFFFF, '08x'),
                })

structure['duplicatePaths'] = sorted([key for key, count in seen.items() if key and count > 1])
structure['pathTypeConflicts'] = sorted(set(structure['pathTypeConflicts']))
structure['dangerousPaths'] = sorted(set(structure['dangerousPaths']))
structure['emptyNames'] = sorted(set(structure['emptyNames']))
sha256_matches = None if expected_sha256 is None else archive_sha256 == expected_sha256
crc_supported = fmt == 'zip'
crc_status = 'passed' if crc_supported and not crc_failed and not crc_skipped else 'partial' if crc_supported and not crc_failed and crc_skipped else 'failed' if crc_supported else 'not_supported'
structure_ok = not any([structure['duplicatePaths'], structure['emptyNames'], structure['dangerousPaths'], structure['pathTypeConflicts']])
integrity_ok = structure_ok and not crc_failed and (sha256_matches is not False) and not encrypted_entries

result = {
    'format': fmt,
    'memberCount': member_count,
    'archiveSha256': archive_sha256,
    'expectedSha256': expected_sha256,
    'sha256Matches': sha256_matches,
    'encryptedEntries': encrypted_entries,
    'crc32': {
        'supported': crc_supported,
        'status': crc_status,
        'validatedEntries': validated_entries if crc_supported else 0,
        'failedEntries': crc_failed,
        'skippedEncryptedEntries': crc_skipped,
    },
    'structure': {
        **structure,
        'ok': structure_ok,
    },
    'integrity': {
        'ok': integrity_ok,
        'status': 'passed' if integrity_ok else ('partial' if encrypted_entries and not crc_failed and structure_ok and (sha256_matches is not False) else 'failed'),
    },
    'memberHashes': member_hashes if include_member_hashes else None,
}

print(json.dumps(result))
`;

async function inspectArchive({ archivePath, format, maxEntries = DEFAULT_INSPECT_MAX_ENTRIES }) {
  const archiveFormat = resolveArchiveFormat({ archivePath, format });
  if (!archiveFormat) {
    throw new Error(`Unsupported archive format. Supported formats: ${getSupportedArchiveSummary()}`);
  }

  const result = await execPythonJson(PYTHON_ARCHIVE_INSPECT_SCRIPT, [
    archivePath,
    archiveFormat.id,
    String(maxEntries),
  ]);
  return {
    ...result,
    format: archiveFormat,
  };
}

async function validateArchive({ archivePath, format, expectedSha256 = '', includeMemberHashes = false }) {
  const archiveFormat = resolveArchiveFormat({ archivePath, format });
  if (!archiveFormat) {
    throw new Error(`Unsupported archive format. Supported formats: ${getSupportedArchiveSummary()}`);
  }

  const result = await execPythonJson(PYTHON_ARCHIVE_VALIDATE_SCRIPT, [
    archivePath,
    archiveFormat.id,
    String(expectedSha256 || ''),
    includeMemberHashes ? 'true' : 'false',
  ], 60 * 1024 * 1024);
  return {
    ...result,
    format: archiveFormat,
  };
}

async function extractZipArchive({ archivePath, destinationDir, maxEntries, maxTotalBytes }) {
  await new Promise((resolve, reject) => {
    yauzl.open(archivePath, { lazyEntries: true }, (openErr, zipfile) => {
      if (openErr) {
        reject(openErr);
        return;
      }
      if (!zipfile) {
        reject(new Error('Unable to open zip archive'));
        return;
      }

      let entryCount = 0;
      let totalBytes = 0;
      let settled = false;

      const finish = (err) => {
        if (settled) {
          return;
        }
        settled = true;
        try {
          zipfile.close();
        } catch (_error) {
          // noop
        }
        if (err) {
          reject(err);
          return;
        }
        resolve();
      };

      zipfile.on('error', (err) => finish(err));
      zipfile.on('end', () => finish());

      zipfile.readEntry();
      zipfile.on('entry', (entry) => {
        entryCount += 1;
        if (entryCount > maxEntries) {
          finish(new Error(`Archive exceeds ${maxEntries} entries`));
          return;
        }

        const sanitized = sanitizeArchiveEntry(entry.fileName);
        if (!sanitized) {
          zipfile.readEntry();
          return;
        }

        const destinationPath = ensureWithinRoot(destinationDir, path.join(destinationDir, sanitized));
        const isDirectory = /\/$/.test(entry.fileName);

        if (isDirectory) {
          fsp
            .mkdir(destinationPath, { recursive: true })
            .then(() => zipfile.readEntry())
            .catch((err) => finish(err));
          return;
        }

        totalBytes += Number(entry.uncompressedSize || 0);
        if (totalBytes > maxTotalBytes) {
          finish(
            new Error(
              `Archive exceeds ${Math.round(maxTotalBytes / (1024 * 1024))}MB extracted size limit`,
            ),
          );
          return;
        }

        zipfile.openReadStream(entry, (streamErr, readStream) => {
          if (streamErr) {
            finish(streamErr);
            return;
          }
          if (!readStream) {
            finish(new Error(`Unable to read archive entry: ${entry.fileName}`));
            return;
          }

          fsp
            .mkdir(path.dirname(destinationPath), { recursive: true })
            .then(() => {
              const writeStream = fs.createWriteStream(destinationPath, { mode: 0o644 });
              let extractedBytes = 0;

              readStream.on('data', (chunk) => {
                extractedBytes += chunk.length;
                if (extractedBytes > maxTotalBytes) {
                  readStream.destroy(new Error('Archive entry exceeds safe extraction limits'));
                }
              });

              readStream.on('error', (err) => {
                writeStream.destroy(err);
              });
              writeStream.on('error', (err) => finish(err));
              writeStream.on('close', () => zipfile.readEntry());
              readStream.pipe(writeStream);
            })
            .catch((err) => finish(err));
        });
      });
    });
  });
}

async function extractTarArchive({ archivePath, destinationDir, maxEntries, maxTotalBytes }) {
  const script = String.raw`
import os, sys, tarfile
archive_path, destination_dir, max_entries, max_total_bytes = sys.argv[1:5]
max_entries = int(max_entries)
max_total_bytes = int(max_total_bytes)
root = os.path.realpath(destination_dir)
os.makedirs(root, exist_ok=True)
entry_count = 0
extracted_total = 0
with tarfile.open(archive_path, 'r:*') as archive:
    for member in archive:
        entry_count += 1
        if entry_count > max_entries:
            raise RuntimeError(f'Archive exceeds {max_entries} entries')
        normalized = member.name.replace('\\', '/').lstrip('/')
        parts = [part for part in normalized.split('/') if part not in ('', '.', '..')]
        if not parts:
            continue
        safe_rel = '/'.join(parts)
        target = os.path.realpath(os.path.join(root, safe_rel))
        if target != root and not target.startswith(root + os.sep):
            raise RuntimeError(f'Archive entry escapes destination root: {member.name}')
        if member.issym() or member.islnk():
            raise RuntimeError(f'Archive contains unsupported link entry: {member.name}')
        if member.isdir():
            os.makedirs(target, exist_ok=True)
            continue
        if not (member.isfile() or member.isreg()):
            continue
        extracted_total += int(getattr(member, 'size', 0) or 0)
        if extracted_total > max_total_bytes:
            raise RuntimeError(f'Archive exceeds {round(max_total_bytes / (1024 * 1024))}MB extracted size limit')
        os.makedirs(os.path.dirname(target), exist_ok=True)
        source = archive.extractfile(member)
        if source is None:
            raise RuntimeError(f'Unable to read archive entry: {member.name}')
        written = 0
        with source, open(target, 'wb') as output:
            while True:
                chunk = source.read(1024 * 1024)
                if not chunk:
                    break
                written += len(chunk)
                if extracted_total - int(getattr(member, 'size', 0) or 0) + written > max_total_bytes:
                    raise RuntimeError('Archive entry exceeds safe extraction limits')
                output.write(chunk)
`;

  await execFileAsync('python3', ['-c', script, archivePath, destinationDir, String(maxEntries), String(maxTotalBytes)], {
    maxBuffer: 20 * 1024 * 1024,
  });
}

async function extractArchive({
  archivePath,
  destinationDir,
  format,
  maxEntries = DEFAULT_MAX_ENTRIES,
  maxTotalBytes = DEFAULT_MAX_TOTAL_BYTES,
}) {
  const archiveFormat = resolveArchiveFormat({ archivePath, format });
  if (!archiveFormat) {
    throw new Error(`Unsupported archive format. Supported formats: ${getSupportedArchiveSummary()}`);
  }

  if (archiveFormat.id === 'zip') {
    await extractZipArchive({ archivePath, destinationDir, maxEntries, maxTotalBytes });
    return archiveFormat;
  }

  await extractTarArchive({ archivePath, destinationDir, maxEntries, maxTotalBytes });
  return archiveFormat;
}

async function listArchiveEntries({ archivePath, format, maxEntries = DEFAULT_LIST_MAX_ENTRIES }) {
  const inspection = await inspectArchive({ archivePath, format, maxEntries });
  return {
    entries: (inspection.members || []).map((member) => ({
      path: member.path,
      isDirectory: Boolean(member.isDirectory),
      size: member.size,
    })),
    totalEntries: inspection.entryCount,
    truncated: Boolean(inspection.truncated),
    format: inspection.format,
  };
}

async function buildArchiveEntries({ sourceHostPath, sourceHostPaths = [], stripTopLevel = false }) {
  const sourcePaths = Array.isArray(sourceHostPaths) && sourceHostPaths.length > 0
    ? [...new Set(sourceHostPaths.map((item) => path.resolve(item)))]
    : [path.resolve(sourceHostPath)];
  const sourceRoot = path.resolve(sourceHostPath);
  const rootStat = await fsp.stat(sourceRoot);

  if (sourcePaths.length === 1 && sourcePaths[0] === sourceRoot && rootStat.isDirectory() && stripTopLevel) {
    const children = await fsp.readdir(sourceRoot);
    return {
      cwd: sourceRoot,
      entries: children.sort(),
    };
  }

  if (sourcePaths.length > 1 || (sourcePaths.length === 1 && sourcePaths[0] !== sourceRoot)) {
    const entries = sourcePaths.map((item) => {
      const relative = path.relative(sourceRoot, item);
      if (!relative || relative.startsWith('..')) {
        throw new Error(`Archive source path escapes base root: ${item}`);
      }
      return relative.replace(/\\/g, '/');
    });
    return {
      cwd: sourceRoot,
      entries: [...new Set(entries)].sort(),
    };
  }

  return {
    cwd: path.dirname(sourceRoot),
    entries: [path.basename(sourceRoot)],
  };
}

async function createZipArchive({ sourceHostPath, sourceHostPaths = [], outputHostPath, stripTopLevel = false }) {
  const { cwd, entries } = await buildArchiveEntries({ sourceHostPath, sourceHostPaths, stripTopLevel });
  const tempZipPath = path.join(
    os.tmpdir(),
    `fk521ai-archive-${Date.now()}-${Math.random().toString(36).slice(2)}.zip`,
  );

  try {
    await execFileAsync('zip', ['-r', '-q', tempZipPath, ...entries], {
      cwd,
      maxBuffer: 50 * 1024 * 1024,
    });
    await fsp.copyFile(tempZipPath, outputHostPath);
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw error;
    }

    await runPythonScriptFile('archive_pack.py', ['zip', cwd, outputHostPath, JSON.stringify(entries)]);
  } finally {
    await fsp.rm(tempZipPath, { force: true }).catch(() => undefined);
  }
}

async function createTarArchive({
  sourceHostPath,
  sourceHostPaths = [],
  outputHostPath,
  format,
  stripTopLevel = false,
}) {
  const { cwd, entries } = await buildArchiveEntries({ sourceHostPath, sourceHostPaths, stripTopLevel });
  const args = ['-cf', outputHostPath, ...entries];

  if (format === 'tar.gz') {
    args[0] = '-czf';
  } else if (format === 'tar.bz2') {
    args[0] = '-cjf';
  } else if (format === 'tar.xz') {
    args[0] = '-cJf';
  }

  try {
    await execFileAsync('tar', args, {
      cwd,
      maxBuffer: 50 * 1024 * 1024,
    });
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw error;
    }

    await runPythonScriptFile('archive_pack.py', [format, cwd, outputHostPath, JSON.stringify(entries)]);
  }
}

function getArchiveFormatById(formatId) {
  return Object.values(ARCHIVE_FORMATS).find((format) => format.id === formatId) || null;
}

function inferArchiveFormat({ outputFilename, archiveFormat }) {
  if (archiveFormat) {
    const explicit = getArchiveFormatById(normalizeArchiveFormatId(archiveFormat));
    if (!explicit) {
      throw new Error(`Unsupported archive format "${archiveFormat}". Supported formats: ${SUPPORTED_ARCHIVE_FORMAT_IDS.join(', ')}`);
    }
    return explicit;
  }

  const fromFilename = detectArchiveFormat(outputFilename || '');
  return fromFilename || ARCHIVE_FORMATS.zip;
}

async function createArchive({
  sourceHostPath,
  sourceHostPaths = [],
  outputHostPath,
  format,
  stripTopLevel = false,
}) {
  const archiveFormat = getArchiveFormatById(format);
  if (!archiveFormat) {
    throw new Error(`Unsupported archive format "${format}". Supported formats: ${SUPPORTED_ARCHIVE_FORMAT_IDS.join(', ')}`);
  }

  if (archiveFormat.id === 'zip') {
    await createZipArchive({ sourceHostPath, sourceHostPaths, outputHostPath, stripTopLevel });
    return archiveFormat;
  }

  await createTarArchive({ sourceHostPath, sourceHostPaths, outputHostPath, format: archiveFormat.id, stripTopLevel });
  return archiveFormat;
}

module.exports = {
  DEFAULT_MAX_ENTRIES,
  DEFAULT_MAX_TOTAL_BYTES,
  DEFAULT_LIST_MAX_ENTRIES,
  DEFAULT_INSPECT_MAX_ENTRIES,
  ARCHIVE_FORMATS,
  SUPPORTED_ARCHIVE_FORMAT_IDS,
  SUPPORTED_ARCHIVE_EXTENSIONS,
  sanitizeArchiveEntry,
  ensureWithinRoot,
  detectArchiveFormat,
  isSupportedArchive,
  getSupportedArchiveSummary,
  getSourceSize,
  listArchiveEntries,
  inspectArchive,
  validateArchive,
  extractArchive,
  inferArchiveFormat,
  createArchive,
  normalizeArchiveFormatId,
  getArchiveToolStatus,
};
