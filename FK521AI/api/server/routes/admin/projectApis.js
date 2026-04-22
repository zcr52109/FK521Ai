const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const express = require('express');
const { sanitizeFilename } = require('@fk521ai/api');
const { SystemCapabilities } = require('@fk521ai/data-schemas');
const { requireCapability } = require('~/server/middleware/roles/capabilities');
const { requireJwtAuth } = require('~/server/middleware');
const difyConsoleRouter = require('./difyConsole');
const { invalidateConfigCaches } = require('~/server/services/Config');
const { invalidateUIModelCache } = require('~/server/controllers/ModelController');
const { getFileStrategy } = require('~/server/utils/getFileStrategy');
const { getStrategyFunctions } = require('~/server/services/Files/strategies');
const { respondWithStandardError, respondWithInternalError } = require('~/server/utils/respondWithStandardError');
const {
  readProjectApis,
  writeProjectApis,
  normalizeProjectApis,
  loadManagedCustomEndpoints,
  loadManagedModelSpecs,
  loadManagedFileConfig,
  loadRagEmbeddingConfig,
  isMaskedApiKeyValue,
  sanitizeProjectApisForAdmin,
} = require('~/server/utils/projectApiConfig');
const { parseImportFile, mergeImportedProjectApis } = require('~/server/utils/projectApiImport');
const {
  readManagedModelStyles,
  upsertManagedModelStyle,
  removeManagedModelStyle,
} = require('~/server/utils/managedModelStyles');
const { recordPolicyAuditEvent, getCachedRuntimePolicySnapshot } = require('~/server/services/RuntimePolicy');

const router = express.Router();
const requireAdminAccess = requireCapability(SystemCapabilities.ACCESS_ADMIN);
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024,
  },
});

router.use(requireJwtAuth, requireAdminAccess);
router.use((_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});

router.get('/', (_req, res) => {
  return res.status(200).json({
    items: sanitizeProjectApisForAdmin(readProjectApis()),
    styles: readManagedModelStyles(),
  });
});

router.get('/runtime', (_req, res) => {
  return res.status(200).json({
    customEndpoints: loadManagedCustomEndpoints(),
    modelSpecs: loadManagedModelSpecs(),
    fileConfig: loadManagedFileConfig(),
    ragEmbedding: loadRagEmbeddingConfig(),
  });
});

router.put('/', async (req, res) => {
  try {
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    if (items.length > 100) {
      return respondWithStandardError(res, 400, { message: '项目接口数量不能超过 100 个', error_code: 'TOO_MANY_PROJECT_APIS' });
    }

    const previousSnapshot = getCachedRuntimePolicySnapshot();
    const previousById = new Map(
      readProjectApis()
        .filter((item) => item?.id)
        .map((item) => [String(item.id), item]),
    );
    const restoredItems = items.map((item) => {
      const next = item && typeof item === 'object' ? { ...item } : item;
      if (!next || typeof next !== 'object') {
        return next;
      }
      const key = String(next.apiKey || '').trim();
      const previous = previousById.get(String(next.id || '').trim());
      if (isMaskedApiKeyValue(key) && previous?.apiKey) {
        next.apiKey = previous.apiKey;
      }
      return next;
    });
    const normalized = normalizeProjectApis(restoredItems);
    writeProjectApis(normalized);
    invalidateUIModelCache();
    await invalidateConfigCaches(req.user?.tenantId);
    if (typeof difyConsoleRouter.invalidateConsoleStatsCache === 'function') {
      difyConsoleRouter.invalidateConsoleStatsCache(req.user?.tenantId);
    }
    recordPolicyAuditEvent({
      action: 'project_apis_updated',
      userId: req.user?.id,
      tenantId: req.user?.tenantId,
      previousSnapshotId: previousSnapshot?.snapshotId,
      itemCount: normalized.length,
    });

    return res.status(200).json({
      items: sanitizeProjectApisForAdmin(normalized),
      styles: readManagedModelStyles(),
      customEndpoints: loadManagedCustomEndpoints(),
      modelSpecs: loadManagedModelSpecs(),
      fileConfig: loadManagedFileConfig(),
      ragEmbedding: loadRagEmbeddingConfig(),
    });
  } catch (error) {
    return respondWithInternalError(res, '保存项目接口配置失败');
  }
});

router.get('/styles', (_req, res) => {
  return res.status(200).json({ styles: readManagedModelStyles() });
});

router.post('/styles/upload', upload.single('file'), async (req, res) => {
  try {
    const uploaded = req.file;
    if (!uploaded) {
      return respondWithStandardError(res, 400, { message: '请上传 .txt 文件', error_code: 'FILE_REQUIRED' });
    }

    const extension = path.extname(uploaded.originalname || '').toLowerCase();
    const mime = String(uploaded.mimetype || '').toLowerCase();
    const isText = extension === '.txt' || mime.startsWith('text/');
    if (!isText) {
      return respondWithStandardError(res, 400, { message: '仅支持上传 .txt 文本风格文件', error_code: 'INVALID_FILE_TYPE' });
    }

    const content = String(uploaded.buffer?.toString('utf8') || '').replace(/\r\n/g, '\n').trim();
    if (!content) {
      return respondWithStandardError(res, 400, { message: '风格文件内容不能为空', error_code: 'EMPTY_FILE_CONTENT' });
    }

    const style = {
      id: String(req.body?.id || '').trim() || `style-${crypto.randomUUID()}`,
      name: String(req.body?.name || path.basename(uploaded.originalname, extension) || '未命名风格').trim(),
      category: String(req.body?.category || 'general').trim() || 'general',
      description: String(req.body?.description || '').trim(),
      content,
      enabled: req.body?.enabled !== 'false',
      createdAt: new Date().toISOString(),
    };

    const previousSnapshot = getCachedRuntimePolicySnapshot();
    const styles = await upsertManagedModelStyle(style);
    invalidateUIModelCache();
    await invalidateConfigCaches(req.user?.tenantId);
    recordPolicyAuditEvent({
      action: 'managed_model_style_upserted',
      userId: req.user?.id,
      tenantId: req.user?.tenantId,
      styleId: style.id,
      previousSnapshotId: previousSnapshot?.snapshotId,
    });
    return res.status(200).json({
      message: '风格文件已上传',
      styles,
      modelSpecs: loadManagedModelSpecs(),
    });
  } catch (error) {
    return respondWithInternalError(res, '上传风格文件失败');
  }
});

router.delete('/styles/:id', async (req, res) => {
  try {
    const id = String(req.params?.id || '').trim();
    if (!id) {
      return respondWithStandardError(res, 400, { message: '风格文件 ID 不能为空', error_code: 'STYLE_FILE_ID_REQUIRED' });
    }
    const previousSnapshot = getCachedRuntimePolicySnapshot();
    const styles = await removeManagedModelStyle(id);
    invalidateUIModelCache();
    await invalidateConfigCaches(req.user?.tenantId);
    recordPolicyAuditEvent({
      action: 'managed_model_style_deleted',
      userId: req.user?.id,
      tenantId: req.user?.tenantId,
      styleId: id,
      previousSnapshotId: previousSnapshot?.snapshotId,
    });
    return res.status(200).json({
      message: '风格文件已删除',
      styles,
      modelSpecs: loadManagedModelSpecs(),
    });
  } catch (error) {
    return respondWithInternalError(res, '删除风格文件失败');
  }
});


router.post('/batch-import', upload.single('file'), async (req, res) => {
  try {
    const uploaded = req.file;
    if (!uploaded?.buffer?.length) {
      return respondWithStandardError(res, 400, { message: '请上传批量导入文件', error_code: 'IMPORT_FILE_REQUIRED' });
    }

    const rows = parseImportFile({
      buffer: uploaded.buffer,
      filename: uploaded.originalname,
      mimeType: uploaded.mimetype,
    });

    if (!Array.isArray(rows) || rows.length === 0) {
      return respondWithStandardError(res, 400, { message: '未解析到可导入的模型记录', error_code: 'IMPORT_ROWS_EMPTY' });
    }

    const previousSnapshot = getCachedRuntimePolicySnapshot();
    const currentItems = readProjectApis();
    const { items, summary } = mergeImportedProjectApis(currentItems, rows);
    writeProjectApis(items);
    invalidateUIModelCache();
    await invalidateConfigCaches(req.user?.tenantId);
    if (typeof difyConsoleRouter.invalidateConsoleStatsCache === 'function') {
      difyConsoleRouter.invalidateConsoleStatsCache(req.user?.tenantId);
    }
    recordPolicyAuditEvent({
      action: 'project_apis_batch_imported',
      userId: req.user?.id,
      tenantId: req.user?.tenantId,
      previousSnapshotId: previousSnapshot?.snapshotId,
      importedRows: summary.totalRows,
      created: summary.created,
      updated: summary.updated,
    });

    return res.status(200).json({
      message: `导入完成：新增 ${summary.created} 条，更新 ${summary.updated} 条，跳过 ${summary.skipped} 条`,
      summary,
      items: sanitizeProjectApisForAdmin(items),
      styles: readManagedModelStyles(),
      customEndpoints: loadManagedCustomEndpoints(),
      modelSpecs: loadManagedModelSpecs(),
      fileConfig: loadManagedFileConfig(),
      ragEmbedding: loadRagEmbeddingConfig(),
    });
  } catch (error) {
    return respondWithInternalError(res, '批量导入模型失败');
  }
});

router.post('/upload-avatar', upload.single('file'), async (req, res) => {
  try {
    const uploaded = req.file;
    if (!uploaded) {
      return respondWithStandardError(res, 400, { message: '请上传头像图片', error_code: 'AVATAR_FILE_REQUIRED' });
    }

    const mime = String(uploaded.mimetype || '').toLowerCase();
    if (!mime.startsWith('image/')) {
      return respondWithStandardError(res, 400, { message: '仅支持上传图片文件作为模型头像', error_code: 'INVALID_AVATAR_FILE_TYPE' });
    }

    const appConfig = req.config;
    const fileStrategy = getFileStrategy(appConfig, { isAvatar: true });
    const { saveBuffer } = getStrategyFunctions(fileStrategy);
    if (typeof saveBuffer !== 'function') {
      return respondWithInternalError(res, '当前文件存储策略不支持后台头像上传');
    }

    const safeExt = path.extname(sanitizeFilename(uploaded.originalname || 'avatar.png')) || '.png';
    const fileName = `managed-model-${crypto.randomUUID()}${safeExt}`;
    const url = await saveBuffer({
      userId: 'managed-models',
      buffer: uploaded.buffer,
      fileName,
      basePath: 'images',
    });

    return res.status(200).json({ url });
  } catch (error) {
    return respondWithInternalError(res, '上传模型头像失败');
  }
});

module.exports = router;
