const { nanoid } = require('nanoid');
const { EnvVar } = require('@fk521ai/agents');
const { logger } = require('@fk521ai/data-schemas');
const { checkAccess } = require('@fk521ai/api');
const {
  Tools,
  AuthType,
  Permissions,
  ToolCallTypes,
  PermissionTypes,
} = require('fk521ai-data-provider');
const {
  getRoleByName,
  createToolCall,
  getToolCallsByConvo,
  getMessage,
  getConvoFiles,
} = require('~/models');
const { processFileURL, uploadImageBuffer } = require('~/server/services/Files/process');
const { processCodeOutput } = require('~/server/services/Files/Code/process');
const { loadAuthValues } = require('~/server/services/Tools/credentials');
const { loadTools } = require('~/app/clients/tools/util');
const { executeDockerSandbox } = require('~/server/services/Sandbox/dockerExecutor');
const { syncConversationFilesToSandbox } = require('~/server/services/Sandbox/uploads');
const { ensureSandboxCapabilityManifest } = require('~/server/services/Sandbox/runtimeContract');
const { authorizeSandboxAction, SANDBOX_ACTIONS } = require('~/server/services/Sandbox/authorization');
const { createAttachmentDownloadLink } = require('~/server/services/DownloadLinks');
const { readDifyConsoleConfig } = require('~/server/utils/difyConsoleConfig');


async function decorateAttachments(req, attachments = []) {
  if (!Array.isArray(attachments) || attachments.length === 0) {
    return attachments || [];
  }

  return await Promise.all(attachments.map(async (attachment) => {
    try {
      const signedLink = await createAttachmentDownloadLink({ req, attachment });
      if (!signedLink?.download_path) {
        return attachment;
      }
      return {
        ...attachment,
        downloadPath: signedLink.download_path,
        downloadTokenizedPath: signedLink.download_path,
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

const fieldsMap = {
  [Tools.execute_code]: [EnvVar.CODE_API_KEY],
};

const toolAccessPermType = {};

function endpointHasExecuteCodeCapability(config = {}) {
  const capabilities = config?.endpoints?.agents?.capabilities;
  if (!Array.isArray(capabilities)) {
    return false;
  }
  return capabilities.includes('execute_code');
}

const verifyToolAuth = async (req, res) => {
  try {
    const { toolId } = req.params;
    if (toolId === Tools.execute_code) {
      return res.status(200).json({
        authenticated: true,
        message: AuthType.SYSTEM_DEFINED,
        mode: 'local',
      });
    }
    const authFields = fieldsMap[toolId];
    if (!authFields) {
      res.status(404).json({ message: 'Tool not found' });
      return;
    }
    let result;
    try {
      result = await loadAuthValues({
        userId: req.user.id,
        authFields,
        throwError: false,
      });
    } catch (error) {
      logger.error('Error loading auth values', error);
      res.status(200).json({ authenticated: false, message: AuthType.USER_PROVIDED });
      return;
    }
    let isUserProvided = false;
    for (const field of authFields) {
      if (!result[field]) {
        res.status(200).json({ authenticated: false, message: AuthType.USER_PROVIDED });
        return;
      }
      if (!isUserProvided && process.env[field] !== result[field]) {
        isUserProvided = true;
      }
    }
    res.status(200).json({
      authenticated: true,
      message: isUserProvided ? AuthType.USER_PROVIDED : AuthType.SYSTEM_DEFINED,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const callTool = async (req, res) => {
  try {
    const appConfig = req.config;
    const { toolId = '' } = req.params;
    if (!fieldsMap[toolId]) {
      logger.warn(`[${toolId}/call] User ${req.user.id} attempted call to invalid tool`);
      res.status(404).json({ message: 'Tool not found' });
      return;
    }

    const { partIndex, blockIndex, messageId, conversationId, ...args } = req.body;
    if (!messageId) {
      logger.warn(`[${toolId}/call] User ${req.user.id} attempted call without message ID`);
      res.status(400).json({ message: 'Message ID required' });
      return;
    }

    const message = await getMessage({ user: req.user.id, messageId });
    if (!message) {
      logger.debug(`[${toolId}/call] User ${req.user.id} attempted call with invalid message ID`);
      res.status(404).json({ message: 'Message not found' });
      return;
    }

    logger.debug(`[${toolId}/call] User: ${req.user.id}`);
    if (toolId === Tools.execute_code) {
      if (conversationId && message.conversationId && conversationId !== message.conversationId) {
        return res.status(403).json({
          message: 'Forbidden: Conversation mismatch',
          error: 'Forbidden',
          error_code: 'CONVERSATION_MISMATCH',
        });
      }

      const effectiveConversationId = message.conversationId || conversationId || 'new';
      const allowExecuteCode = endpointHasExecuteCodeCapability(appConfig);
      const decision = await authorizeSandboxAction({
        user: req.user,
        action: SANDBOX_ACTIONS.EXECUTE_CODE,
        allowExecuteCode,
      });

      if (!decision.allow) {
        return res.status(403).json({
          message: 'Forbidden: Insufficient permissions',
          error: 'Forbidden',
          error_code: 'PERMISSION_DENIED',
          reason: decision.reasonCode,
          decision_id: decision.decisionId,
          policy_version: decision.policyVersion,
          remediation: decision.remediation,
        });
      }

      const conversationFileIds = effectiveConversationId
        ? await getConvoFiles(effectiveConversationId, {
          user: req.user.id,
          tenantId: req.user.tenantId,
        })
        : [];
      const capabilityManifest = await ensureSandboxCapabilityManifest(effectiveConversationId, { user: req.user });
      const { syncedFiles, skippedFiles } = await syncConversationFilesToSandbox({
        conversationId: effectiveConversationId,
        conversationFileIds,
        user: req.user,
        authContext: { user: req.user },
      });

      const taskId = `${messageId || 'msg'}_${partIndex ?? 0}_${blockIndex ?? 0}`;
      const consoleConfig = readDifyConsoleConfig();
      const sandboxResult = await executeDockerSandbox({
        conversationId: effectiveConversationId,
        taskId,
        language: args.language || args.lang,
        code: args.code,
        networkMode: consoleConfig.codeExecutor?.allowNetwork === true ? 'bridge' : 'none',
        authContext: { user: req.user },
      });

      sandboxResult.attachments = await decorateAttachments(req, sandboxResult.attachments || []);

      const resultSections = [];
      resultSections.push(`sandbox: ${sandboxResult.image}`);
      resultSections.push(`sandbox_capabilities: ${capabilityManifest.sandboxPath}`);
      resultSections.push(`cwd: ${sandboxResult.cwd}`);
      resultSections.push(`sandbox_capability_api: /api/files/sandbox/${encodeURIComponent(String(effectiveConversationId))}/capabilities`);

      if (syncedFiles.length > 0) {
        resultSections.push(
          `uploaded files:\n${syncedFiles.map((file) => `- ${file.filename} -> ${file.path}`).join('\n')}`,
        );
      }

      if (skippedFiles.length > 0) {
        resultSections.push(
          `skipped uploads:\n${skippedFiles.map((file) => `- ${file.filename}: ${file.reason}`).join('\n')}`,
        );
      }

      if (sandboxResult.stdout) {
        resultSections.push(`stdout:\n${sandboxResult.stdout}`);
      }
      if (sandboxResult.stderr) {
        resultSections.push(`stderr:\n${sandboxResult.stderr}`);
      }
      if (sandboxResult.attachments?.length > 0) {
        resultSections.push(
          `generated files:\n${sandboxResult.attachments
            .map((file) => formatAttachmentForConversation(file))
            .join('\n')}`,
        );
      }
      if (resultSections.length === 0) {
        resultSections.push('执行完成，无输出。');
      }

      const toolCallData = {
        toolId,
        messageId,
        partIndex,
        blockIndex,
        conversationId,
        result: resultSections.join('\n\n'),
        user: req.user.id,
        attachments: sandboxResult.attachments || [],
      };

      createToolCall(toolCallData).catch((error) => {
        logger.error(`Error creating sandbox tool call: ${error.message}`);
      });

      return res.status(200).json({
        result: toolCallData.result,
        attachments: sandboxResult.attachments || [],
        metadata: {
          ...sandboxResult,
          capabilityManifest: capabilityManifest.manifest,
          capabilityManifestPath: capabilityManifest.sandboxPath,
          capabilityApiPath: `/api/files/sandbox/${encodeURIComponent(String(effectiveConversationId))}/capabilities`,
        },
      });
    }

    let hasAccess = true;
    if (toolAccessPermType[toolId]) {
      hasAccess = await checkAccess({
        user: req.user,
        permissionType: toolAccessPermType[toolId],
        permissions: [Permissions.USE],
        getRoleByName,
      });
    }
    if (!hasAccess) {
      logger.warn(
        `[${toolAccessPermType[toolId]}] Forbidden: Insufficient permissions for User ${req.user.id}: ${Permissions.USE}`,
      );
      return res.status(403).json({ message: 'Forbidden: Insufficient permissions' });
    }
    const { loadedTools } = await loadTools({
      user: req.user.id,
      tools: [toolId],
      functions: true,
      options: {
        req,
        returnMetadata: true,
        processFileURL,
        uploadImageBuffer,
      },
      webSearch: appConfig.webSearch,
      fileStrategy: appConfig.fileStrategy,
      imageOutputType: appConfig.imageOutputType,
    });

    const tool = loadedTools[0];
    const toolCallId = `${req.user.id}_${nanoid()}`;
    const result = await tool.invoke({
      args,
      name: toolId,
      id: toolCallId,
      type: ToolCallTypes.TOOL_CALL,
    });

    const { content, artifact } = result;
    if (Array.isArray(artifact?.attachments) && artifact.attachments.length > 0) {
      artifact.attachments = await decorateAttachments(req, artifact.attachments);
    }
    const toolCallData = {
      toolId,
      messageId,
      partIndex,
      blockIndex,
      conversationId,
      result: content,
      user: req.user.id,
    };

    if (Array.isArray(artifact?.attachments) && artifact.attachments.length > 0) {
      toolCallData.attachments = artifact.attachments;
      createToolCall(toolCallData).catch((error) => {
        logger.error(`Error creating tool call: ${error.message}`);
      });
      return res.status(200).json({
        result: content,
        attachments: artifact.attachments,
      });
    }

    if (!artifact || toolId !== Tools.execute_code || !artifact.files) {
      createToolCall(toolCallData).catch((error) => {
        logger.error(`Error creating tool call: ${error.message}`);
      });
      return res.status(200).json({
        result: content,
      });
    }

    const artifactPromises = [];
    for (const file of artifact.files) {
      const { id, name } = file;
      artifactPromises.push(
        (async () => {
          const fileMetadata = await processCodeOutput({
            req,
            id,
            name,
            apiKey: tool.apiKey,
            messageId,
            toolCallId,
            conversationId,
            session_id: artifact.session_id,
          });

          if (!fileMetadata) {
            return null;
          }

          const [decorated] = await decorateAttachments(req, [fileMetadata]);
          return decorated;
        })().catch((error) => {
          logger.error('Error processing code output:', error);
          return null;
        }),
      );
    }
    const attachments = await Promise.all(artifactPromises);
    toolCallData.attachments = attachments;
    createToolCall(toolCallData).catch((error) => {
      logger.error(`Error creating tool call: ${error.message}`);
    });
    res.status(200).json({
      result: content,
      attachments,
    });
  } catch (error) {
    logger.error('Error calling tool', error);
    res.status(500).json({ message: 'Error calling tool' });
  }
};

const getToolCalls = async (req, res) => {
  try {
    const { conversationId } = req.query;
    const toolCalls = await getToolCallsByConvo(conversationId, req.user.id);
    res.status(200).json(toolCalls);
  } catch (error) {
    logger.error('Error getting tool calls', error);
    res.status(500).json({ message: 'Error getting tool calls' });
  }
};

module.exports = {
  callTool,
  getToolCalls,
  verifyToolAuth,
};
