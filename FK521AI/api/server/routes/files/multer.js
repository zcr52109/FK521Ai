const fs = require('fs');
const fsp = require('fs/promises');
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
const { getSystemSettings } = require('~/server/services/Config/systemSettings');
const MAX_FILENAME_LENGTH = 180;
const DANGEROUS_FILENAME_SEGMENTS = [/[\u0000-\u001f]/, /\.\./, /[<>:"|?*]/];
const MAGIC_SIGNATURES = Object.freeze({
  'image/png': Buffer.from([0x89, 0x50, 0x4e, 0x47]),
  'image/jpeg': Buffer.from([0xff, 0xd8, 0xff]),
  'image/webp': Buffer.from([0x52, 0x49, 0x46, 0x46]),
  'application/pdf': Buffer.from([0x25, 0x50, 0x44, 0x46]),
  'application/zip': Buffer.from([0x50, 0x4b, 0x03, 0x04]),
});

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

function createStorage(appConfig) {
  return multer.diskStorage({
    destination: function (req, _file, cb) {
      const userId = String(req?.user?.id || 'anonymous');
      const baseUploadsPath = appConfig?.paths?.uploads || path.join(process.cwd(), '.runtime', 'uploads');
      const outputPath = path.join(baseUploadsPath, 'temp', userId);
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
}

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
const createFileFilter = (customFileConfig, options = {}) => {
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
    const allowAllTypes = options.allowAllUploadTypes !== false;
    if (
      !allowAllTypes &&
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
  const runtimeSettings = await getSystemSettings();
  const fileConfig = mergeFileConfig(appConfig?.fileConfig);
  const fileFilter = createFileFilter(fileConfig, {
    allowAllUploadTypes: runtimeSettings.settings?.featureToggles?.allowAllUploadTypes !== false,
  });
  const configuredLimit = Number(
    runtimeSettings.settings?.limits?.uploadMaxFileSize ?? process.env.FK521_UPLOAD_MAX_FILE_SIZE ?? fileConfig.serverFileSizeLimit ?? 0,
  );
  const effectiveLimit = Number.isFinite(configuredLimit) && configuredLimit > 0 ? configuredLimit : null;
  return multer({
    storage: createStorage(appConfig),
    fileFilter,
    ...(effectiveLimit ? { limits: { fileSize: effectiveLimit } } : {}),
  });
};

async function validateUploadedFileMagic(filePath, mimeType) {
  const signature = MAGIC_SIGNATURES[mimeType];
  if (!signature) {
    return true;
  }
  const handle = await fsp.open(filePath, 'r');
  try {
    const { buffer } = await handle.read(Buffer.alloc(signature.length), 0, signature.length, 0);
    return buffer.subarray(0, signature.length).equals(signature);
  } finally {
    await handle.close();
  }
}

function magicNumberValidationMiddleware() {
  return async (req, res, next) => {
    try {
      const files = [];
      if (Array.isArray(req.files)) {
        files.push(...req.files);
      } else if (req.files && typeof req.files === 'object') {
        for (const value of Object.values(req.files)) {
          if (Array.isArray(value)) {
            files.push(...value);
          }
        }
      } else if (req.file) {
        files.push(req.file);
      }

      for (const file of files) {
        const valid = await validateUploadedFileMagic(file.path, file.mimetype);
        if (!valid) {
          return res.status(400).json({ message: `File signature mismatch: ${file.originalname}` });
        }
      }
      return next();
    } catch (error) {
      return next(error);
    }
  };
}

module.exports = {
  createMulterInstance,
  createStorage,
  importFileFilter,
  validateUploadedFileMagic,
  magicNumberValidationMiddleware,
};
