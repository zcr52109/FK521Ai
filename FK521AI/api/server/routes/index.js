const express = require('express');
const fs = require('fs/promises');
const path = require('path');
const {
  createMulterInstance,
  magicNumberValidationMiddleware,
} = require('~/server/routes/files/multer');
const { getAppConfig } = require('~/server/services/Config');
const { getSystemSettings, updateSystemSettings } = require('~/server/services/Config/systemSettings');
const { listModels, saveModel } = require('~/server/services/modelsRegistry');

function buildSimpleRoute(name) {
  const router = express.Router();
  router.get('/', (_req, res) => {
    res.json({ ok: true, route: name });
  });
  return router;
}

const files = {
  async initialize() {
    const router = express.Router();
    const appConfig = await getAppConfig();
    const uploadsRoot = path.resolve(appConfig.paths.uploads);
    const dynamicUploadSingle = async (req, res, next) => {
      const uploader = await createMulterInstance();
      return uploader.single('file')(req, res, next);
    };

    router.get('/', (_req, res) => {
      res.json({ ok: true, route: 'files' });
    });

    router.post(
      '/upload',
      dynamicUploadSingle,
      magicNumberValidationMiddleware(),
      (req, res) => {
        if (!req.file) {
          return res.status(400).json({ message: 'No file uploaded' });
        }
        return res.json({
          ok: true,
          file: {
            file_id: req.file_id,
            originalname: req.file.originalname,
            mimetype: req.file.mimetype,
            size: req.file.size,
            path: req.file.path,
          },
        });
      },
    );

    router.get('/read', async (req, res, next) => {
      try {
        const relativePath = String(req.query.path || '').trim();
        if (!relativePath) {
          return res.status(400).json({ message: 'path is required' });
        }
        const targetPath = path.resolve(uploadsRoot, relativePath.replace(/^\/+/, ''));
        if (targetPath !== uploadsRoot && !targetPath.startsWith(`${uploadsRoot}${path.sep}`)) {
          return res.status(403).json({ message: 'Path escapes upload root' });
        }
        const raw = await fs.readFile(targetPath);
        const start = Math.max(0, Number(req.query.start ?? 0) || 0);
        const endInput = req.query.end == null ? raw.length : Number(req.query.end);
        const end = Number.isFinite(endInput) ? Math.min(raw.length, Math.max(start, endInput)) : raw.length;
        const chunk = raw.subarray(start, end);
        const encoding = String(req.query.encoding || 'utf8').toLowerCase() === 'base64' ? 'base64' : 'utf8';
        return res.json({
          ok: true,
          path: relativePath,
          bytes: chunk.length,
          totalBytes: raw.length,
          range: { start, end },
          encoding,
          content: chunk.toString(encoding),
        });
      } catch (error) {
        if (error?.code === 'ENOENT') {
          return res.status(404).json({ message: 'File not found' });
        }
        return next(error);
      }
    });

    return router;
  },
};

const adminSystemSettings = (() => {
  const router = express.Router();
  router.get('/', async (_req, res, next) => {
    try {
      return res.json({ ok: true, ...(await getSystemSettings()) });
    } catch (error) {
      return next(error);
    }
  });
  router.put('/', async (req, res, next) => {
    const payload = req.body && typeof req.body === 'object' ? req.body : {};
    try {
      return res.json({ ok: true, ...(await updateSystemSettings(payload)) });
    } catch (error) {
      return next(error);
    }
  });
  return router;
})();

const models = (() => {
  const router = express.Router();
  router.get('/', async (_req, res, next) => {
    try {
      return res.json({ ok: true, ...(await listModels()) });
    } catch (error) {
      return next(error);
    }
  });
  router.post('/', async (req, res, next) => {
    const payload = req.body && typeof req.body === 'object' ? req.body : {};
    try {
      return res.status(201).json({ ok: true, ...(await saveModel(payload)) });
    } catch (error) {
      return next(error);
    }
  });
  return router;
})();

module.exports = {
  oauth: buildSimpleRoute('oauth'),
  auth: buildSimpleRoute('auth'),
  adminAuth: buildSimpleRoute('adminAuth'),
  adminConfig: buildSimpleRoute('adminConfig'),
  adminGrants: buildSimpleRoute('adminGrants'),
  adminGroups: buildSimpleRoute('adminGroups'),
  adminRoles: buildSimpleRoute('adminRoles'),
  adminUsers: buildSimpleRoute('adminUsers'),
  adminProjectApis: buildSimpleRoute('adminProjectApis'),
  adminSystemSettings,
  adminDifyConsole: buildSimpleRoute('adminDifyConsole'),
  actions: buildSimpleRoute('actions'),
  keys: buildSimpleRoute('keys'),
  apiKeys: buildSimpleRoute('apiKeys'),
  user: buildSimpleRoute('user'),
  search: buildSimpleRoute('search'),
  messages: buildSimpleRoute('messages'),
  convos: buildSimpleRoute('convos'),
  presets: buildSimpleRoute('presets'),
  prompts: buildSimpleRoute('prompts'),
  categories: buildSimpleRoute('categories'),
  endpoints: buildSimpleRoute('endpoints'),
  balance: buildSimpleRoute('balance'),
  models,
  config: buildSimpleRoute('config'),
  assistants: buildSimpleRoute('assistants'),
  files,
  staticRoute: (() => { const router = express.Router(); router.use((_req, res) => res.status(404).json({ ok: false })); return router; })(),
  share: buildSimpleRoute('share'),
  roles: buildSimpleRoute('roles'),
  agents: buildSimpleRoute('agents'),
  banner: buildSimpleRoute('banner'),
  memories: buildSimpleRoute('memories'),
  accessPermissions: buildSimpleRoute('accessPermissions'),
  tags: buildSimpleRoute('tags'),
};
