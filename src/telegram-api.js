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
  }

  async call(method, payload = {}, options = {}) {
    const response = await this.fetch(`${this.baseUrl}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: options.signal
    });

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
}
