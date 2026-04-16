import { escapeTelegramMarkdown } from "../render.js";
import { TelegramApiError } from "../telegram-api.js";
import { splitPlainText } from "../utils.js";

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

function buildRenderAttempts(rawChunk) {
  return [
    { text: rawChunk, parseMode: "HTML" },
    { text: escapeTelegramMarkdown(rawChunk), parseMode: "MarkdownV2" },
    { text: rawChunk, parseMode: null }
  ];
}

export class MessageRenderer {
  constructor({ botApi, chatId }) {
    this.botApi = botApi;
    this.chatId = chatId;
    this.progressMessageId = null;
    this.lastRenderedProgressText = null;
  }

  resetTransientState() {
    this.progressMessageId = null;
    this.lastRenderedProgressText = null;
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

  async sendMessageChunk(rawChunk) {
    return this.renderWithFallback({
      rawChunk,
      send: ({ text, parseMode }) =>
        this.botApi.sendMessage({
          chatId: this.chatId,
          text,
          parseMode
        })
    });
  }

  async editMessageChunk(messageId, rawChunk) {
    return this.renderWithFallback({
      rawChunk,
      send: ({ text, parseMode }) =>
        this.botApi.editMessageText({
          chatId: this.chatId,
          messageId,
          text,
          parseMode
        })
    });
  }

  async sendSplitText(rawText) {
    let firstMessageId = null;

    for (const rawChunk of splitPlainText(rawText, TELEGRAM_RENDER_CHUNK_SIZE)) {
      const result = await this.sendMessageChunk(rawChunk);
      firstMessageId ??= getTelegramMessageId(result);
    }

    return firstMessageId;
  }

  async renderProgressText(text) {
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
      this.progressMessageId = await this.sendSplitText(displayText);
    }

    this.lastRenderedProgressText = displayText;
  }

  async renderTerminalText(rawText) {
    if (!rawText) {
      return;
    }

    const rawChunks = splitPlainText(rawText, TELEGRAM_RENDER_CHUNK_SIZE);
    const [firstChunk, ...remainingChunks] = rawChunks;

    if (this.progressMessageId) {
      if (firstChunk !== this.lastRenderedProgressText) {
        await this.editMessageChunk(this.progressMessageId, firstChunk);
      }
      this.progressMessageId = null;
      this.lastRenderedProgressText = null;

      for (const rawChunk of remainingChunks) {
        await this.sendMessageChunk(rawChunk);
      }
      return;
    }

    await this.sendSplitText(rawText);
  }

  async renderFinalMessage(text) {
    await this.renderTerminalText(String(text ?? ""));
  }

  async renderErrorText(text) {
    await this.renderTerminalText(String(text ?? "").trim());
  }

  async sendText(text) {
    const rawText = String(text ?? "");
    if (!rawText) {
      return;
    }

    await this.sendSplitText(rawText);
  }
}
