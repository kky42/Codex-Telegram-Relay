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
  attachmentDescriptorsFromPost,
  unsupportedAttachmentMessage
} from "./attachments.js";
import { MessageRenderer } from "./message-renderer.js";

function normalizeCaption(value) {
  return String(value ?? "").trim();
}

export function replyTargetFromMattermostPost(post) {
  const rootId = String(post?.root_id ?? "").trim();
  return rootId ? { rootId } : null;
}

export class ChatSession extends CommonChatSession {
  constructor({
    botConfig,
    botApi,
    configStore,
    logger,
    channelId,
    conversationId = channelId,
    websocket = null,
    cacheRootDir = DEFAULT_CACHE_PATH,
    createAgentRun = null,
    createCodexRun = null,
    resolveContextLength = null,
    resolveHomeDir
  }) {
    const messageRenderer = new MessageRenderer({ botApi, channelId, websocket, logger });
    super({
      bindingConfig: botConfig,
      output: messageRenderer,
      configStore,
      logger,
      platform: "mattermost",
      bindingId: botConfig.bindingId,
      conversationId,
      cacheRootDir,
      createAgentRun,
      createCodexRun,
      resolveContextLength,
      resolveHomeDir
    });
    this.botApi = botApi;
    this.channelId = channelId;
    this.messageRenderer = messageRenderer;
  }

  setWebSocket(websocket) {
    this.messageRenderer.setWebSocket(websocket);
  }

  startTyping(replyTarget = this.activeReplyTarget) {
    return this.messageRenderer.startTyping(replyTarget);
  }

  stopTyping() {
    return this.messageRenderer.stopTyping();
  }

  async resolveAttachmentLocalPath(descriptor) {
    const scope = this.cacheScope();
    await ensureCacheScope(scope);

    for (let collisionIndex = 1; collisionIndex <= 1000; collisionIndex += 1) {
      const fileName = buildAttachmentFileName({
        kind: descriptor.kind,
        fileName: descriptor.fileName,
        filePath: descriptor.mattermostFileId,
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
    let resolvedDescriptor = descriptor;
    try {
      const fileInfo = await this.botApi.getFileInfo?.(descriptor.mattermostFileId);
      if (fileInfo) {
        resolvedDescriptor = {
          ...descriptor,
          fileName: descriptor.fileName ?? fileInfo.name ?? null,
          mimeType: descriptor.mimeType ?? fileInfo.mime_type ?? null,
          fileSize:
            descriptor.fileSize ??
            (Number.isFinite(Number(fileInfo.size)) ? Number(fileInfo.size) : null)
        };
      }
    } catch {
      // File metadata is optional; download size enforcement still protects the cache.
    }

    if (resolvedDescriptor.fileSize !== null && resolvedDescriptor.fileSize > ATTACHMENT_SIZE_LIMIT_BYTES) {
      throw new Error(
        `${resolvedDescriptor.fileName ?? resolvedDescriptor.kind} exceeds the ${attachmentLimitText()} limit.`
      );
    }

    const { fileName, localPath } = await this.resolveAttachmentLocalPath(resolvedDescriptor);
    const buffer = await this.botApi.downloadFile(resolvedDescriptor.mattermostFileId, {
      maxBytes: ATTACHMENT_SIZE_LIMIT_BYTES
    });
    if (buffer.length > ATTACHMENT_SIZE_LIMIT_BYTES) {
      throw new Error(
        `${resolvedDescriptor.fileName ?? resolvedDescriptor.kind} exceeds the ${attachmentLimitText()} limit.`
      );
    }
    await fs.writeFile(localPath, buffer);

    return {
      ...resolvedDescriptor,
      localPath,
      fileName,
      fileSize: resolvedDescriptor.fileSize ?? buffer.length
    };
  }

  async buildAttachmentTurn(posts) {
    const attachments = [];
    const downloadedPaths = [];
    let promptText = "";

    try {
      for (const post of posts) {
        const descriptors = attachmentDescriptorsFromPost(post);
        if (descriptors.length === 0) {
          throw new Error(unsupportedAttachmentMessage());
        }

        promptText ||= normalizeCaption(post?.message);
        for (const descriptor of descriptors) {
          const attachment = await this.stageAttachment(descriptor);
          attachments.push(attachment);
          downloadedPaths.push(attachment.localPath);
        }
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

  async stageAttachmentsFromPosts(posts) {
    const attachments = [];
    const downloadedPaths = [];

    try {
      for (const post of posts) {
        for (const descriptor of attachmentDescriptorsFromPost(post)) {
          const attachment = await this.stageAttachment(descriptor);
          attachments.push(attachment);
          downloadedPaths.push(attachment.localPath);
        }
      }
    } catch (error) {
      await Promise.allSettled(downloadedPaths.map((filePath) => fs.rm(filePath, { force: true })));
      throw error;
    }

    return attachments;
  }

  async handleAttachmentPosts(posts) {
    if (!Array.isArray(posts) || posts.length === 0) {
      return;
    }
    const replyTarget = replyTargetFromMattermostPost(posts[0]);

    try {
      const turn = await this.buildAttachmentTurn(posts);
      turn.replyTarget = replyTarget;
      await this.enqueueTurn(turn);
    } catch (error) {
      await this.sendText(toErrorMessage(error), { replyTarget });
    }
  }
}
