import { TelegramApiError } from "../../src/telegram-api.js";

export class FakeBotApi {
  constructor({ failMarkdownOnce = false, failMarkdownEditOnce = false } = {}) {
    this.failMarkdownOnce = failMarkdownOnce;
    this.failMarkdownEditOnce = failMarkdownEditOnce;
    this.messages = [];
    this.edits = [];
    this.actions = [];
    this.filesById = new Map();
    this.filesByPath = new Map();
    this.getFileCalls = [];
    this.downloadCalls = [];
  }

  async sendMessage(payload) {
    if (this.failMarkdownOnce && payload.parseMode === "MarkdownV2") {
      this.failMarkdownOnce = false;
      throw new TelegramApiError("can't parse entities", { errorCode: 400 });
    }
    this.messages.push(payload);
    return { message_id: this.messages.length };
  }

  async editMessageText(payload) {
    if (this.failMarkdownEditOnce && payload.parseMode === "MarkdownV2") {
      this.failMarkdownEditOnce = false;
      throw new TelegramApiError("can't parse entities", { errorCode: 400 });
    }
    this.edits.push(payload);
    return { message_id: payload.messageId };
  }

  async sendChatAction(payload) {
    this.actions.push(payload);
    return true;
  }

  async getMe() {
    return { username: "relaybot" };
  }

  async setMyCommands() {
    return true;
  }

  registerFile(
    fileId,
    {
      filePath = `${fileId}.bin`,
      body = Buffer.from(`file:${fileId}`),
      fileSize = body.length
    } = {}
  ) {
    this.filesById.set(fileId, {
      file_id: fileId,
      file_path: filePath,
      file_size: fileSize
    });
    this.filesByPath.set(filePath, Buffer.from(body));
  }

  async getFile(fileId) {
    this.getFileCalls.push(fileId);
    const file = this.filesById.get(fileId);
    if (!file) {
      throw new Error(`Unknown Telegram file: ${fileId}`);
    }
    return { ...file };
  }

  async downloadFile(filePath, options = {}) {
    this.downloadCalls.push({ filePath, options });
    const body = this.filesByPath.get(filePath);
    if (!body) {
      throw new Error(`Unknown Telegram file path: ${filePath}`);
    }
    if (Number.isFinite(options.maxBytes) && body.length > options.maxBytes) {
      throw new Error("download exceeds limit");
    }
    return Buffer.from(body);
  }
}

export class FakeConfigStore {
  constructor() {
    this.patches = [];
    this.failure = null;
  }

  async patchBotConfig(botName, patch) {
    if (this.failure) {
      throw this.failure;
    }
    this.patches.push({ botName, patch });
  }
}

export function createControlledRunnerFactory() {
  const runs = [];

  return {
    runs,
    createRun(params) {
      let resolveDone;
      const run = {
        params,
        aborted: false,
        done: new Promise((resolve) => {
          resolveDone = resolve;
        }),
        async emit(event) {
          await params.onEvent(event);
        },
        finish(result = { code: 0, signal: null, aborted: false, sawTerminalEvent: true }) {
          resolveDone(result);
        },
        abort() {
          this.aborted = true;
          resolveDone({ code: null, signal: "SIGTERM", aborted: true, sawTerminalEvent: false });
        }
      };
      runs.push(run);
      return run;
    }
  };
}
