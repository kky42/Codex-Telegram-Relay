import fs from "node:fs/promises";
import path from "node:path";

export class TelegramApiError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "TelegramApiError";
    this.errorCode = options.errorCode ?? null;
    this.parameters = options.parameters ?? null;
  }
}

export class TelegramBotApi {
  constructor(token, fetchImpl = globalThis.fetch) {
    if (!fetchImpl) {
      throw new Error("Global fetch is not available. Node.js 20+ is required.");
    }

    this.token = token;
    this.fetch = fetchImpl;
    this.baseUrl = `https://api.telegram.org/bot${token}`;
    this.fileBaseUrl = `https://api.telegram.org/file/bot${token}`;
  }

  async call(method, payload = {}, options = {}) {
    const response = await this.fetch(`${this.baseUrl}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: options.signal
    });

    return this.parseResponse(method, response);
  }

  async callMultipart(method, formData, options = {}) {
    const response = await this.fetch(`${this.baseUrl}/${method}`, {
      method: "POST",
      body: formData,
      signal: options.signal
    });

    return this.parseResponse(method, response);
  }

  async parseResponse(method, response) {
    let body;
    try {
      body = await response.json();
    } catch (error) {
      throw new TelegramApiError(`Telegram ${method} returned invalid JSON`);
    }

    if (!response.ok || !body.ok) {
      throw new TelegramApiError(body.description || `${method} failed`, {
        errorCode: body.error_code ?? response.status,
        parameters: body.parameters ?? null
      });
    }

    return body.result;
  }

  getMe(options = {}) {
    return this.call("getMe", {}, options);
  }

  setMyCommands(commands, options = {}) {
    return this.call("setMyCommands", { commands }, options);
  }

  getFile(fileId, options = {}) {
    return this.call("getFile", { file_id: fileId }, options);
  }

  getUpdates({ offset, timeout = 50 } = {}, options = {}) {
    return this.call(
      "getUpdates",
      {
        offset,
        timeout,
        allowed_updates: ["message"]
      },
      options
    );
  }

  sendMessage({ chatId, text, parseMode = null }, options = {}) {
    const payload = {
      chat_id: chatId,
      text,
      disable_web_page_preview: true
    };

    if (parseMode) {
      payload.parse_mode = parseMode;
    }

    return this.call("sendMessage", payload, options);
  }

  editMessageText({ chatId, messageId, text, parseMode = null }, options = {}) {
    const payload = {
      chat_id: chatId,
      message_id: messageId,
      text,
      disable_web_page_preview: true
    };

    if (parseMode) {
      payload.parse_mode = parseMode;
    }

    return this.call("editMessageText", payload, options);
  }

  deleteMessage({ chatId, messageId }, options = {}) {
    return this.call(
      "deleteMessage",
      {
        chat_id: chatId,
        message_id: messageId
      },
      options
    );
  }

  async sendLocalAttachment(
    { chatId, kind, filePath, fileName = null, caption = null, parseMode = null },
    options = {}
  ) {
    const target = OUTBOUND_ATTACHMENT_TARGETS[kind];
    if (!target) {
      throw new Error(`Unsupported outbound attachment kind: ${kind}`);
    }

    const body = await fs.readFile(filePath);
    const formData = new FormData();
    formData.append("chat_id", String(chatId));
    formData.append(
      target.field,
      new Blob([body]),
      fileName || path.basename(String(filePath ?? "")) || "attachment"
    );

    if (caption) {
      formData.append("caption", caption);
    }

    if (parseMode) {
      formData.append("parse_mode", parseMode);
    }

    return this.callMultipart(target.method, formData, options);
  }

  sendChatAction({ chatId, action = "typing" }, options = {}) {
    return this.call(
      "sendChatAction",
      {
        chat_id: chatId,
        action
      },
      options
    );
  }

  async downloadFile(filePath, options = {}) {
    const response = await this.fetch(`${this.fileBaseUrl}/${filePath}`, {
      method: "GET",
      signal: options.signal
    });

    if (!response.ok) {
      throw new TelegramApiError(`Telegram file download failed with status ${response.status}`, {
        errorCode: response.status
      });
    }

    if (!response.body || typeof response.body.getReader !== "function") {
      const buffer = Buffer.from(await response.arrayBuffer());
      if (Number.isFinite(options.maxBytes) && buffer.length > options.maxBytes) {
        throw new TelegramApiError(`Telegram file exceeds ${options.maxBytes} bytes`, {
          errorCode: 413
        });
      }
      return buffer;
    }

    const reader = response.body.getReader();
    const chunks = [];
    let totalBytes = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      const chunk = Buffer.from(value);
      totalBytes += chunk.length;
      if (Number.isFinite(options.maxBytes) && totalBytes > options.maxBytes) {
        throw new TelegramApiError(`Telegram file exceeds ${options.maxBytes} bytes`, {
          errorCode: 413
        });
      }
      chunks.push(chunk);
    }

    return Buffer.concat(chunks);
  }
}

const OUTBOUND_ATTACHMENT_TARGETS = {
  photo: { method: "sendPhoto", field: "photo" },
  document: { method: "sendDocument", field: "document" },
  video: { method: "sendVideo", field: "video" },
  audio: { method: "sendAudio", field: "audio" },
  voice: { method: "sendVoice", field: "voice" },
  animation: { method: "sendAnimation", field: "animation" }
};
