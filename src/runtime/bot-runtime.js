import { ALBUM_QUIET_PERIOD_MS, hasSupportedAttachment, unsupportedAttachmentMessage } from "../attachments.js";
import { startCodexRun } from "../codex/runner.js";
import { ChatSession } from "../session/chat-session.js";
import { NOOP_CONFIG_STORE } from "../session/session-persistence.js";
import { TelegramApiError, TelegramBotApi } from "../telegram-api.js";
import { DEFAULT_CACHE_PATH, normalizeTelegramUsername, sleep, toErrorMessage } from "../utils.js";
import { routeTextMessage } from "./command-router.js";
import { MediaGroupBuffer } from "./media-group-buffer.js";
import { ScheduleService } from "./schedule-service.js";

export const TELEGRAM_COMMANDS = [
  { command: "status", description: "Show current Codex status" },
  { command: "schedule", description: "Manage scheduled prompts for this chat" },
  { command: "workdir", description: "Show or change the bot workdir" },
  { command: "auto", description: "Set Codex automation level for this chat" },
  { command: "model", description: "Set model for future runs" },
  { command: "reasoning", description: "Set reasoning effort for future runs" },
  { command: "clear_cache", description: "Clear cached attachments for this bot" },
  { command: "abort", description: "Abort current run and clear queued messages" },
  { command: "new", description: "Start a fresh session and clear context" }
];

function unauthorizedMessage(user) {
  const username = normalizeTelegramUsername(user?.username);
  if (username) {
    return `You are not authorized to use this bot. Your Telegram username is @${username}. Add "${username}" to allowedUsernames in the relay config.`;
  }

  return "You are not authorized to use this bot. Your Telegram account has no username set. Add one in Telegram Settings, then add it to allowedUsernames in the relay config.";
}

export class BotRuntime {
  constructor({
    botConfig,
    stateStore,
    configStore = NOOP_CONFIG_STORE,
    fetchImpl = globalThis.fetch,
    botApi = null,
    createCodexRun = startCodexRun,
    cacheRootDir = DEFAULT_CACHE_PATH,
    albumQuietPeriodMs = ALBUM_QUIET_PERIOD_MS
  }) {
    this.botConfig = botConfig;
    this.stateStore = stateStore;
    this.configStore = configStore;
    this.botApi = botApi ?? new TelegramBotApi(botConfig.token, fetchImpl);
    this.createCodexRun = createCodexRun;
    this.cacheRootDir = cacheRootDir;
    this.albumQuietPeriodMs = albumQuietPeriodMs;
    this.botUsername = null;
    this.offset = undefined;
    this.polling = false;
    this.pollPromise = null;
    this.pollAbortController = null;
    this.sessions = new Map();
    this.mediaGroupBuffer = new MediaGroupBuffer({ quietPeriodMs: albumQuietPeriodMs });
    this.scheduleService = new ScheduleService({
      botConfig: this.botConfig,
      configStore: this.configStore,
      createCodexRun: this.createCodexRun,
      sessionFor: (chatId) => this.sessionFor(chatId),
      sendDirectMessage: (chatId, text) => this.sendDirectMessage(chatId, text),
      log: (message) => this.log(message)
    });
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
        configStore: this.configStore,
        logger: (message) => this.log(`${chatId}: ${message}`),
        chatId,
        cacheRootDir: this.cacheRootDir,
        createCodexRun: this.createCodexRun
      });
      this.sessions.set(key, session);
    }
    return session;
  }

  hasPendingBotWork() {
    if (this.mediaGroupBuffer.hasPending()) {
      return true;
    }

    for (const session of this.sessions.values()) {
      if (session.isRunning || session.queue.length > 0) {
        return true;
      }
    }

    return false;
  }

  isAuthorized(user) {
    const username = normalizeTelegramUsername(user?.username);
    return Boolean(username && this.botConfig.allowedUsernames.includes(username));
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

  async handleClearCache(chatId) {
    const session = this.sessionFor(chatId);
    if (this.hasPendingBotWork()) {
      await session.sendText("Cannot clear cache while runs, queued turns, or media albums are pending.");
      return;
    }

    try {
      await session.clearCache();
    } catch (error) {
      await session.sendText(`Failed to clear cache: ${toErrorMessage(error)}`);
      return;
    }

    await session.sendText(`Cleared cache for ${this.botConfig.name}.`);
  }

  async tickSchedules(now = new Date()) {
    await this.scheduleService.tickSchedules(now);
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
      await this.sendDirectMessage(chatId, unauthorizedMessage(message.from));
      return;
    }

    const session = this.sessionFor(chatId);
    if (hasSupportedAttachment(message)) {
      await this.mediaGroupBuffer.queue(session, message);
      return;
    }

    const text = message.text;
    if (typeof text === "string" && text.trim()) {
      await routeTextMessage({
        text,
        botUsername: this.botUsername,
        session,
        runtime: this
      });
      return;
    }

    await session.sendText(unsupportedAttachmentMessage());
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
    this.scheduleService.startLoop();

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
    this.scheduleService.stopLoop();
    this.mediaGroupBuffer.clear();

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
