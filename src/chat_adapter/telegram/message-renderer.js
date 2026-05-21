import fs from "node:fs/promises";
import path from "node:path";

import {
  OUTBOUND_ATTACHMENT_SIZE_LIMIT_BYTES,
  outboundAttachmentLimitText
} from "../common/attachments.js";
import { splitPlainText, toErrorMessage } from "../../utils.js";
import { parseOutputSegments } from "../common/output-attachments.js";
import { renderMarkdownToTelegramHtml } from "./markdown-renderer.js";
import { escapeTelegramMarkdown } from "./render.js";
import { TelegramApiError } from "./telegram-api.js";

const TELEGRAM_RENDER_CHUNK_SIZE = 3500;

function isParseError(error) {
  return (
    error instanceof TelegramApiError &&
    error.errorCode === 400 &&
    /parse entities/i.test(error.message)
  );
}

function getTelegramMessageId(result) {
  const rawMessageId = result?.message_id ?? result?.messageId;
  const messageId = Number(rawMessageId);
  return Number.isFinite(messageId) ? messageId : null;
}

function formatProgressText(text) {
  return `🟢 ${text}`;
}

function resolveAttachmentPath(filePath, workdir) {
  const normalizedPath = String(filePath ?? "").trim();
  if (!normalizedPath) {
    return "";
  }

  if (path.isAbsolute(normalizedPath)) {
    return normalizedPath;
  }

  return path.resolve(workdir || process.cwd(), normalizedPath);
}

function attachmentLabel(attachment) {
  return attachment.fileName || path.basename(String(attachment.path ?? "")) || attachment.kind;
}

function attachmentKindLabel(entry) {
  return entry.rawKind || entry.kind || null;
}

function formatAttachmentFailure(error) {
  if (!error || typeof error !== "object") {
    return String(error);
  }

  if (error instanceof TelegramApiError) {
    return error.message;
  }

  if (error instanceof Error) {
    if (error.message === "path is not a file") {
      return error.message;
    }

    if (error && "code" in error) {
      if (error.code === "ENOENT") {
        return "file not found";
      }
      if (error.code === "EACCES" || error.code === "EPERM") {
        return "permission denied";
      }
    }

    return error.message;
  }

  return String(error);
}

function formatAttachmentErrorText(entry, reason) {
  const parts = [`Attachment error: path=${entry.path || "(missing)"}`];
  const kind = attachmentKindLabel(entry);
  if (kind) {
    parts.push(`kind=${kind}`);
  }
  parts.push(`reason=${reason}`);
  return parts.join("; ");
}

function hasVisibleText(text) {
  return Boolean(String(text ?? "").trim());
}

function buildRenderAttempts(rawChunk) {
  return [
    { text: rawChunk, parseMode: "HTML" },
    { text: escapeTelegramMarkdown(rawChunk), parseMode: "MarkdownV2" },
    { text: rawChunk, parseMode: null }
  ];
}

function outboundMessageTarget(replyTarget) {
  if (!replyTarget) {
    return {};
  }
  const target = {};
  if (replyTarget.directMessagesTopicId !== null && replyTarget.directMessagesTopicId !== undefined) {
    target.directMessagesTopicId = replyTarget.directMessagesTopicId;
  }
  if (replyTarget.messageThreadId !== null && replyTarget.messageThreadId !== undefined) {
    target.messageThreadId = replyTarget.messageThreadId;
  }
  return target;
}

export class MessageRenderer {
  constructor({ botApi, chatId, logger = () => {} }) {
    this.botApi = botApi;
    this.chatId = chatId;
    this.logger = logger;
    this.progressMessageId = null;
    this.lastRenderedProgressText = null;
    this.typingTimer = null;
  }

  resetTransientState() {
    this.progressMessageId = null;
    this.lastRenderedProgressText = null;
  }

  async clearProgressMessage() {
    const messageId = this.progressMessageId;
    this.progressMessageId = null;
    this.lastRenderedProgressText = null;

    if (!messageId) {
      return;
    }

    try {
      await this.botApi.deleteMessage({
        chatId: this.chatId,
        messageId
      });
    } catch {
      // Keep attachment delivery moving even if Telegram refuses to delete the transient status.
    }
  }

  async renderWithFallback(renderAttempt) {
    let previousParseError = null;

    for (const attempt of buildRenderAttempts(renderAttempt.rawChunk)) {
      try {
        return await renderAttempt.send(attempt);
      } catch (error) {
        if (!isParseError(error) || attempt.parseMode === null) {
          throw error;
        }
        previousParseError = error;
      }
    }

    throw previousParseError ?? new Error("Telegram render fallback exhausted unexpectedly.");
  }

  async sendMessageChunk(rawChunk, options = {}) {
    const renderChunk = options.renderMarkdown
      ? renderMarkdownToTelegramHtml(rawChunk)
      : rawChunk;
    return this.renderWithFallback({
      rawChunk: renderChunk,
      send: ({ text, parseMode }) =>
        this.botApi.sendMessage({
          chatId: this.chatId,
          text,
          parseMode,
          ...outboundMessageTarget(options.replyTarget)
        })
    });
  }

  async editMessageChunk(messageId, rawChunk, options = {}) {
    const renderChunk = options.renderMarkdown
      ? renderMarkdownToTelegramHtml(rawChunk)
      : rawChunk;
    return this.renderWithFallback({
      rawChunk: renderChunk,
      send: ({ text, parseMode }) =>
        this.botApi.editMessageText({
          chatId: this.chatId,
          messageId,
          text,
          parseMode
        })
    });
  }

  async sendSplitText(rawText, options = {}) {
    let firstMessageId = null;

    for (const rawChunk of splitPlainText(rawText, TELEGRAM_RENDER_CHUNK_SIZE)) {
      const result = await this.sendMessageChunk(rawChunk, options);
      firstMessageId ??= getTelegramMessageId(result);
    }

    return firstMessageId;
  }

  async renderProgressText(text, options = {}) {
    const rawText = String(text ?? "").trim();
    if (!rawText) {
      return;
    }

    const displayText = formatProgressText(rawText);
    if (this.lastRenderedProgressText === displayText) {
      return;
    }

    if (this.progressMessageId) {
      await this.editMessageChunk(this.progressMessageId, displayText);
    } else {
      this.progressMessageId = await this.sendSplitText(displayText, options);
    }

    this.lastRenderedProgressText = displayText;
  }

  async renderTerminalText(rawText, options = {}) {
    if (!rawText) {
      return;
    }

    const rawChunks = splitPlainText(rawText, TELEGRAM_RENDER_CHUNK_SIZE);
    const [firstChunk, ...remainingChunks] = rawChunks;

    if (this.progressMessageId) {
      if (firstChunk !== this.lastRenderedProgressText) {
        await this.editMessageChunk(this.progressMessageId, firstChunk, options);
      }
      this.progressMessageId = null;
      this.lastRenderedProgressText = null;

      for (const rawChunk of remainingChunks) {
        await this.sendMessageChunk(rawChunk, options);
      }
      return;
    }

    await this.sendSplitText(rawText, options);
  }

  async sendAttachment(attachment, options = {}) {
    const filePath = options.filePath ?? resolveAttachmentPath(attachment.path, options.workdir);
    return this.botApi.sendLocalAttachment({
      chatId: this.chatId,
      kind: attachment.kind,
      filePath,
      fileName: attachment.fileName || path.basename(filePath),
      ...outboundMessageTarget(options.replyTarget)
    });
  }

  async validateAttachmentEntry(entry, options = {}) {
    if (entry.error) {
      return { ok: false, reason: entry.error };
    }

    const filePath = resolveAttachmentPath(entry.path, options.workdir);
    let stats;
    try {
      stats = await fs.stat(filePath);
    } catch (error) {
      return {
        ok: false,
        reason: formatAttachmentFailure(error)
      };
    }

    if (!stats.isFile()) {
      return { ok: false, reason: "path is not a file" };
    }

    if (stats.size > OUTBOUND_ATTACHMENT_SIZE_LIMIT_BYTES) {
      return {
        ok: false,
        reason: `file exceeds the ${outboundAttachmentLimitText()} limit`
      };
    }

    return {
      ok: true,
      filePath
    };
  }

  async deliverAttachmentEntry(entry, options = {}) {
    const validation = await this.validateAttachmentEntry(entry, options);
    if (!validation.ok) {
      return {
        kind: "text",
        text: formatAttachmentErrorText(entry, validation.reason)
      };
    }

    try {
      await this.sendAttachment(entry, {
        ...options,
        filePath: validation.filePath
      });
    } catch (error) {
      return {
        kind: "text",
        text: formatAttachmentErrorText(entry, formatAttachmentFailure(error))
      };
    }

    return { kind: "attachment" };
  }

  async renderOutputSegments(segments, options = {}) {
    const deliverText = options.deliverText ?? ((text) => this.sendText(text, options));
    let hasVisibleOutput = false;

    for (const segment of segments) {
      if (segment.kind === "text") {
        if (!hasVisibleText(segment.text)) {
          continue;
        }
        await deliverText(segment.text);
        hasVisibleOutput = true;
        continue;
      }

      for (const entry of segment.entries) {
        const result = await this.deliverAttachmentEntry(entry, options);
        if (result.kind === "text") {
          if (!hasVisibleText(result.text)) {
            continue;
          }
          await deliverText(result.text);
          hasVisibleOutput = true;
          continue;
        }

        if (!hasVisibleOutput && options.clearProgressAfterFirstAttachment) {
          await this.clearProgressMessage();
        }
        hasVisibleOutput = true;
      }
    }
  }

  async sendCodexOutput(text, options = {}) {
    const segments = parseOutputSegments(String(text ?? ""));
    await this.renderOutputSegments(segments, {
      ...options,
      deliverText: (rawText) =>
        this.sendText(rawText, {
          ...options,
          renderMarkdown: true
        })
    });
  }

  async renderFinalMessage(text, options = {}) {
    const segments = parseOutputSegments(String(text ?? ""));
    await this.renderOutputSegments(segments, {
      ...options,
      clearProgressAfterFirstAttachment: true,
      deliverText: (rawText) =>
        this.renderTerminalText(rawText, {
          ...options,
          renderMarkdown: true
        })
    });
  }

  async renderErrorText(text, options = {}) {
    await this.renderTerminalText(String(text ?? "").trim(), options);
  }

  async sendText(text, options = {}) {
    const rawText = String(text ?? "");
    if (!rawText) {
      return;
    }

    await this.sendSplitText(rawText, options);
  }

  startTyping(replyTarget = null) {
    if (this.typingTimer) {
      return;
    }

    const tick = async () => {
      try {
        await this.botApi.sendChatAction({
          chatId: this.chatId,
          action: "typing",
          ...outboundMessageTarget(replyTarget)
        });
      } catch (error) {
        this.logger(`typing indicator failed: ${toErrorMessage(error)}`);
      }
    };

    void tick();
    this.typingTimer = setInterval(() => {
      void tick();
    }, 4000);
  }

  stopTyping() {
    if (this.typingTimer) {
      clearInterval(this.typingTimer);
      this.typingTimer = null;
    }
  }
}
