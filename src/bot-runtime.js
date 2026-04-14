import { eventToActions } from "./codex-events.js";
import { startCodexRun } from "./codex-runner.js";
import {
  escapeTelegramMarkdown,
  renderStatusMessage
} from "./render.js";
import { TelegramApiError, TelegramBotApi } from "./telegram-api.js";
import {
  formatUsageK,
  normalizeTelegramUsername,
  splitPlainText,
  sleep,
  toErrorMessage
} from "./utils.js";

export const TELEGRAM_COMMANDS = [
  { command: "status", description: "Show current Codex status" },
  { command: "abort", description: "Abort current run and clear queued messages" },
  { command: "new", description: "Start a fresh session and clear context" }
];

function isParseError(error) {
  return (
    error instanceof TelegramApiError &&
    error.errorCode === 400 &&
    /parse entities/i.test(error.message)
  );
}

export function parseCommand(text, botUsername) {
  const trimmed = String(text || "").trim();
  if (!trimmed.startsWith("/")) {
    return null;
  }

  const [token] = trimmed.split(/\s+/, 1);
  const [commandName, mention] = token.slice(1).split("@");
  if (mention && normalizeTelegramUsername(mention) !== normalizeTelegramUsername(botUsername)) {
    return { ignored: true };
  }

  return { command: commandName.toLowerCase() };
}

export class ChatSession {
  constructor({ botConfig, botApi, stateStore, logger, chatId, createCodexRun = startCodexRun }) {
    this.botConfig = botConfig;
    this.botApi = botApi;
    this.stateStore = stateStore;
    this.logger = logger;
    this.chatId = chatId;

    const persisted = stateStore.getChatState(botConfig.name, chatId);
    this.threadId = persisted.threadId;
    this.lastUsage = persisted.lastUsage;
    this.queue = [];
    this.isRunning = false;
    this.activeRun = null;
    this.typingTimer = null;
    this.createCodexRun = createCodexRun;
  }

  async sendText(text) {
    const rawText = String(text ?? "");
    if (!rawText) {
      return;
    }

    const rawChunks = splitPlainText(rawText, 3500);

    for (const rawChunk of rawChunks) {
      const chunk = escapeTelegramMarkdown(rawChunk);
      try {
        await this.botApi.sendMessage({
          chatId: this.chatId,
          text: chunk,
          parseMode: "MarkdownV2"
        });
      } catch (error) {
        if (!isParseError(error)) {
          throw error;
        }

        await this.botApi.sendMessage({
          chatId: this.chatId,
          text: rawChunk
        });
      }
    }
  }

  startTyping() {
    if (this.botConfig.runningIndicator !== "typing" || this.typingTimer) {
      return;
    }

    const tick = async () => {
      try {
        await this.botApi.sendChatAction({
          chatId: this.chatId,
          action: "typing"
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

  async updateThreadId(threadId) {
    this.threadId = threadId;
    await this.stateStore.patchChatState(this.botConfig.name, this.chatId, {
      threadId,
      lastUsage: this.lastUsage
    });
  }

  async updateUsage(usage) {
    this.lastUsage = usage;
    await this.stateStore.patchChatState(this.botConfig.name, this.chatId, {
      threadId: this.threadId,
      lastUsage: usage
    });
  }

  async clearPersistedState() {
    this.threadId = null;
    this.lastUsage = null;
    await this.stateStore.clearChatState(this.botConfig.name, this.chatId);
  }

  statusText() {
    return renderStatusMessage({
      isRunning: this.isRunning,
      workdir: this.botConfig.workdir,
      usage: formatUsageK(this.lastUsage),
      queue: this.queue
    });
  }

  async handleStatus() {
    await this.sendText(this.statusText());
  }

  async abortCurrentRun() {
    const run = this.activeRun;
    if (!run) {
      return false;
    }
    run.abort();
    try {
      await run.done;
    } catch (error) {
      this.logger(`abort wait failed: ${toErrorMessage(error)}`);
    }
    return true;
  }

  async handleAbort() {
    const wasRunning = this.isRunning;
    this.queue = [];
    await this.abortCurrentRun();
    this.stopTyping();
    await this.sendText(
      wasRunning ? "Aborted current run and cleared the queue." : "No active run. Queue cleared."
    );
  }

  async handleNewSession() {
    this.queue = [];
    await this.abortCurrentRun();
    this.stopTyping();
    await this.clearPersistedState();
    await this.sendText("Started a new session. The next message will open a fresh Codex thread.");
  }

  async enqueueMessage(text) {
    const normalized = String(text || "").trim();
    if (!normalized) {
      return;
    }

    if (this.isRunning) {
      this.queue.push(normalized);
      await this.sendText(`Queued message ${this.queue.length}.`);
      return;
    }

    this.queue.push(normalized);
    void this.drainQueue();
  }

  async drainQueue() {
    if (this.isRunning) {
      return;
    }

    const nextMessage = this.queue.shift();
    if (!nextMessage) {
      return;
    }

    this.isRunning = true;
    this.startTyping();

    let emittedError = false;

    const run = this.createCodexRun({
      workdir: this.botConfig.workdir,
      threadId: this.threadId,
      message: nextMessage,
      codexArgs: this.botConfig.codexArgs,
      onEvent: async (event) => {
        const actions = eventToActions(event);
        for (const action of actions) {
          if (action.kind === "thread_started" && action.threadId) {
            await this.updateThreadId(action.threadId);
            continue;
          }
          if (action.kind === "turn_completed") {
            await this.updateUsage(action.usage);
            continue;
          }
          if (action.kind === "error") {
            emittedError = true;
          }
          if (action.kind === "message" || action.kind === "error") {
            await this.sendText(action.text);
          }
        }
      },
      onStdErr: (chunk) => {
        const message = chunk.trim();
        if (message) {
          this.logger(`codex stderr: ${message}`);
        }
      }
    });

    this.activeRun = run;

    try {
      const result = await run.done;
      if (result.aborted) {
        return;
      }
      if (!result.sawTerminalEvent && !emittedError) {
        await this.sendText("Codex exited without a terminal JSON event.");
      }
    } catch (error) {
      await this.sendText(`Codex process error: ${toErrorMessage(error)}`);
    } finally {
      this.activeRun = null;
      this.isRunning = false;
      this.stopTyping();
      if (this.queue.length > 0) {
        void this.drainQueue();
      }
    }
  }
}

export class BotRuntime {
  constructor({
    botConfig,
    stateStore,
    fetchImpl = globalThis.fetch,
    botApi = null,
    createCodexRun = startCodexRun
  }) {
    this.botConfig = botConfig;
    this.stateStore = stateStore;
    this.botApi = botApi ?? new TelegramBotApi(botConfig.token, fetchImpl);
    this.createCodexRun = createCodexRun;
    this.botUsername = null;
    this.offset = undefined;
    this.polling = false;
    this.pollPromise = null;
    this.pollAbortController = null;
    this.sessions = new Map();
  }

  log(message) {
    process.stderr.write(`[${this.botConfig.name}] ${message}\n`);
  }

  sessionFor(chatId) {
    const key = String(chatId);
    let session = this.sessions.get(key);
    if (!session) {
      session = new ChatSession({
        botConfig: this.botConfig,
        botApi: this.botApi,
        stateStore: this.stateStore,
        logger: (message) => this.log(`${chatId}: ${message}`),
        chatId,
        createCodexRun: this.createCodexRun
      });
      this.sessions.set(key, session);
    }
    return session;
  }

  isAuthorized(user) {
    const username = normalizeTelegramUsername(user?.username);
    const userId = Number(user?.id);
    if (username && this.botConfig.allowedUsernames.includes(username)) {
      return true;
    }
    if (Number.isInteger(userId) && this.botConfig.allowedUserIds.includes(userId)) {
      return true;
    }
    return false;
  }

  async initialize() {
    const me = await this.botApi.getMe();
    this.botUsername = me.username ?? null;
    await this.botApi.setMyCommands(TELEGRAM_COMMANDS);
    this.log(`ready as @${this.botUsername ?? "unknown"} with workdir ${this.botConfig.workdir}`);
  }

  async sendDirectMessage(chatId, text) {
    const session = this.sessionFor(chatId);
    await session.sendText(text);
  }

  async handleMessage(message) {
    const chatId = message.chat?.id;
    if (!chatId) {
      return;
    }

    if (message.chat?.type !== "private") {
      await this.sendDirectMessage(chatId, "This bot only supports private chats.");
      return;
    }

    if (!this.isAuthorized(message.from)) {
      await this.sendDirectMessage(chatId, "You are not authorized to use this bot.");
      return;
    }

    const text = message.text;
    if (typeof text !== "string" || !text.trim()) {
      return;
    }

    const session = this.sessionFor(chatId);
    const parsedCommand = parseCommand(text, this.botUsername);
    if (parsedCommand?.ignored) {
      return;
    }

    switch (parsedCommand?.command) {
      case "status":
        await session.handleStatus();
        return;
      case "abort":
        await session.handleAbort();
        return;
      case "new":
        await session.handleNewSession();
        return;
      default:
        await session.enqueueMessage(text);
    }
  }

  async handleUpdate(update) {
    if (typeof update.update_id === "number") {
      this.offset = update.update_id + 1;
    }
    if (update.message) {
      await this.handleMessage(update.message);
    }
  }

  async start() {
    if (this.polling) {
      return;
    }

    await this.initialize();
    this.polling = true;
    this.pollAbortController = new AbortController();

    this.pollPromise = (async () => {
      while (this.polling) {
        try {
          const updates = await this.botApi.getUpdates(
            {
              offset: this.offset,
              timeout: 50
            },
            {
              signal: this.pollAbortController.signal
            }
          );

          for (const update of updates) {
            await this.handleUpdate(update);
          }
        } catch (error) {
          if (!this.polling) {
            break;
          }

          if (error instanceof TelegramApiError) {
            this.log(`telegram polling error: ${error.message}`);
          } else {
            this.log(`polling failure: ${toErrorMessage(error)}`);
          }
          await sleep(2000);
        }
      }
    })();
  }

  async stop() {
    if (!this.polling) {
      return;
    }

    this.polling = false;
    this.pollAbortController?.abort();

    for (const session of this.sessions.values()) {
      session.queue = [];
      session.stopTyping();
      await session.abortCurrentRun();
    }

    if (this.pollPromise) {
      await this.pollPromise;
    }
  }
}
