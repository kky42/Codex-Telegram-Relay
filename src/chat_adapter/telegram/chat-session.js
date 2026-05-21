import fs from "node:fs/promises";
import path from "node:path";

import {
  ATTACHMENT_SIZE_LIMIT_BYTES,
  attachmentLimitText,
  buildAttachmentFileName
} from "../common/attachments.js";
import { ChatSession as CommonChatSession } from "../common/chat-session.js";
import { ensureCacheScope } from "../common/cache-scope.js";
import { DEFAULT_CACHE_PATH, toErrorMessage } from "../../utils.js";
import {
  attachmentDescriptorFromMessage,
  unsupportedAttachmentMessage
} from "./attachments.js";
import { MessageRenderer } from "./message-renderer.js";

function normalizeCaption(value) {
  return String(value ?? "").trim();
}

export function replyTargetFromTelegramMessage(message) {
  const target = {};
  const messageThreadId = message?.message_thread_id;
  const directMessagesTopicId = message?.direct_messages_topic?.topic_id;
  const isPrivateChat = message?.chat?.type === "private";

  if (messageThreadId !== null && messageThreadId !== undefined) {
    target.messageThreadId = messageThreadId;
  }
  if (
    directMessagesTopicId !== null &&
    directMessagesTopicId !== undefined
  ) {
    target.directMessagesTopicId = directMessagesTopicId;
  }
  if (
    isPrivateChat &&
    target.directMessagesTopicId === undefined &&
    messageThreadId !== null &&
    messageThreadId !== undefined
  ) {
    target.directMessagesTopicId = messageThreadId;
  }
  if (
    isPrivateChat &&
    target.messageThreadId === undefined &&
    directMessagesTopicId !== null &&
    directMessagesTopicId !== undefined
  ) {
    target.messageThreadId = directMessagesTopicId;
  }
  return Object.keys(target).length > 0 ? target : null;
}

export class ChatSession extends CommonChatSession {
  constructor({
    botConfig,
    botApi,
    configStore,
    logger,
    chatId,
    conversationId = chatId,
    cacheRootDir = DEFAULT_CACHE_PATH,
    createAgentRun = null,
    createCodexRun = null,
    resolveContextLength = null,
    resolveHomeDir
  }) {
    const messageRenderer = new MessageRenderer({ botApi, chatId, logger });
    super({
      bindingConfig: botConfig,
      output: messageRenderer,
      configStore,
      logger,
      platform: "telegram",
      bindingId: botConfig.username,
      conversationId,
      cacheRootDir,
      createAgentRun,
      createCodexRun,
      resolveContextLength,
      resolveHomeDir
    });
    this.botApi = botApi;
    this.chatId = chatId;
    this.messageRenderer = messageRenderer;
  }

  startTyping(replyTarget = this.activeReplyTarget) {
    return this.messageRenderer.startTyping(replyTarget);
  }

  stopTyping() {
    return this.messageRenderer.stopTyping();
  }

  async resolveAttachmentLocalPath(descriptor, filePath) {
    const scope = this.cacheScope();
    await ensureCacheScope(scope);

    for (let collisionIndex = 1; collisionIndex <= 1000; collisionIndex += 1) {
      const fileName = buildAttachmentFileName({
        kind: descriptor.kind,
        fileName: descriptor.fileName,
        filePath,
        sourceMessageId: descriptor.sourceMessageId,
        collisionIndex
      });
      const localPath = path.join(scope.scopeDir, fileName);

      try {
        await fs.stat(localPath);
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
          return { fileName, localPath };
        }
        throw error;
      }
    }

    throw new Error("Could not allocate a unique attachment cache filename.");
  }

  async stageAttachment(descriptor) {
    if (descriptor.fileSize !== null && descriptor.fileSize > ATTACHMENT_SIZE_LIMIT_BYTES) {
      throw new Error(
        `${descriptor.fileName ?? descriptor.kind} exceeds the ${attachmentLimitText()} limit.`
      );
    }

    const file = await this.botApi.getFile(descriptor.telegramFileId);
    const resolvedFileSize =
      Number.isFinite(Number(file?.file_size)) ? Number(file.file_size) : descriptor.fileSize;
    if (resolvedFileSize !== null && resolvedFileSize > ATTACHMENT_SIZE_LIMIT_BYTES) {
      throw new Error(
        `${descriptor.fileName ?? descriptor.kind} exceeds the ${attachmentLimitText()} limit.`
      );
    }

    if (typeof file?.file_path !== "string" || !file.file_path) {
      throw new Error("Telegram did not return a downloadable file path.");
    }

    const { fileName, localPath } = await this.resolveAttachmentLocalPath(
      descriptor,
      file.file_path
    );

    const buffer = await this.botApi.downloadFile(file.file_path, {
      maxBytes: ATTACHMENT_SIZE_LIMIT_BYTES
    });
    await fs.writeFile(localPath, buffer);

    return {
      ...descriptor,
      localPath,
      fileName,
      fileSize: resolvedFileSize ?? buffer.length
    };
  }

  async buildAttachmentTurn(messages) {
    const attachments = [];
    const downloadedPaths = [];
    let promptText = "";

    try {
      for (const message of messages) {
        const descriptor = attachmentDescriptorFromMessage(message);
        if (!descriptor) {
          throw new Error(unsupportedAttachmentMessage());
        }

        promptText ||= normalizeCaption(message?.caption);
        const attachment = await this.stageAttachment(descriptor);
        attachments.push(attachment);
        downloadedPaths.push(attachment.localPath);
      }
    } catch (error) {
      await Promise.allSettled(downloadedPaths.map((filePath) => fs.rm(filePath, { force: true })));
      throw error;
    }

    return {
      promptText,
      attachments
    };
  }

  async stageAttachmentsFromMessages(messages) {
    const attachments = [];
    const downloadedPaths = [];

    try {
      for (const message of messages) {
        const descriptor = attachmentDescriptorFromMessage(message);
        if (!descriptor) {
          continue;
        }

        const attachment = await this.stageAttachment(descriptor);
        attachments.push(attachment);
        downloadedPaths.push(attachment.localPath);
      }
    } catch (error) {
      await Promise.allSettled(downloadedPaths.map((filePath) => fs.rm(filePath, { force: true })));
      throw error;
    }

    return attachments;
  }

  async handleAttachmentMessages(messages) {
    if (!Array.isArray(messages) || messages.length === 0) {
      return;
    }
    const replyTarget = replyTargetFromTelegramMessage(messages[0]);

    try {
      const turn = await this.buildAttachmentTurn(messages);
      turn.replyTarget = replyTarget;
      await this.enqueueTurn(turn);
    } catch (error) {
      await this.sendText(toErrorMessage(error), { replyTarget });
    }
  }
}
