const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const { sanitizeFilename, getDisplayFilename } = require('@fk521ai/api');
const {
  mergeFileConfig,
  inferMimeType,
  getEndpointFileConfig,
  archiveExtensionRegex,
  fileConfig: defaultFileConfig,
} = require('fk521ai-data-provider');
const { getAppConfig } = require('~/server/services/Config');
const MAX_FILENAME_LENGTH = 180;
const DANGEROUS_FILENAME_SEGMENTS = [/[\u0000-\u001f]/, /\.\./, /[<>:"|?*]/];

function isSafeFilename(name = '') {
  const value = String(name || '');
  if (!value || value.length > MAX_FILENAME_LENGTH) {
    return false;
  }
  if (DANGEROUS_FILENAME_SEGMENTS.some((pattern) => pattern.test(value))) {
    return false;
  }
  return true;
}

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const appConfig = req.config;
    const outputPath = path.join(appConfig.paths.uploads, 'temp', req.user.id);
    if (!fs.existsSync(outputPath)) {
      fs.mkdirSync(outputPath, { recursive: true });
    }
    cb(null, outputPath);
  },
  filename: function (req, file, cb) {
    req.file_id = crypto.randomUUID();
    file.originalname = getDisplayFilename(file.originalname, 'upload');
    if (!isSafeFilename(file.originalname)) {
      return cb(new Error('Invalid filename'));
    }
    const sanitizedFilename = sanitizeFilename(file.originalname);
    cb(null, sanitizedFilename);
  },
});

const importFileFilter = (req, file, cb) => {
  if (file.mimetype === 'application/json') {
    cb(null, true);
  } else if (path.extname(file.originalname).toLowerCase() === '.json') {
    cb(null, true);
  } else {
    cb(new Error('Only JSON files are allowed'), false);
  }
};

/**
 *
 * @param {import('fk521ai-data-provider').FileConfig | undefined} customFileConfig
 */
const createFileFilter = (customFileConfig) => {
  /**
   * @param {ServerRequest} req
   * @param {Express.Multer.File}
   * @param {import('multer').FileFilterCallback} cb
   */
  const fileFilter = (req, file, cb) => {
    if (!file) {
      return cb(new Error('No file provided'), false);
    }

    if (!isSafeFilename(file.originalname)) {
      return cb(new Error('Invalid filename'), false);
    }

    if (req.originalUrl.endsWith('/speech/stt') && file.mimetype.startsWith('audio/')) {
      return cb(null, true);
    }

    file.mimetype = inferMimeType(file.originalname, file.mimetype);

    const endpoint = req.body.endpoint;
    const endpointType = req.body.endpointType;
    const endpointFileConfig = getEndpointFileConfig({
      fileConfig: customFileConfig,
      endpoint,
      endpointType,
    });

    const isArchiveByExtension = archiveExtensionRegex.test(file.originalname);
    const ext = path.extname(file.originalname).toLowerCase();
    const disallowedExtensions = new Set(['.exe', '.dll', '.bat', '.cmd', '.ps1', '.js', '.jar', '.com', '.scr']);
    if (disallowedExtensions.has(ext)) {
      return cb(new Error(`Forbidden file extension: ${ext}`), false);
    }

    if (/(\.(json|txt|csv|md|pdf|docx|png|jpg|jpeg|webp|zip|tar|gz|bz2|xz)){2,}$/i.test(file.originalname)) {
      return cb(new Error('Ambiguous multi-extension filename is not allowed'), false);
    }

    if (
      !defaultFileConfig.checkType(file.mimetype, endpointFileConfig.supportedMimeTypes) &&
      !isArchiveByExtension
    ) {
      return cb(new Error('Unsupported file type: ' + file.mimetype), false);
    }

    cb(null, true);
  };

  return fileFilter;
};

const createMulterInstance = async () => {
  const appConfig = await getAppConfig();
  const fileConfig = mergeFileConfig(appConfig?.fileConfig);
  const fileFilter = createFileFilter(fileConfig);
  return multer({
    storage,
    fileFilter,
    limits: { fileSize: fileConfig.serverFileSizeLimit },
  });
};

module.exports = { createMulterInstance, storage, importFileFilter };
