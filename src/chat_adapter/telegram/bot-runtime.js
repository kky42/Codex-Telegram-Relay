import { DEFAULT_CACHE_PATH, normalizeTelegramUsername, sleep, toErrorMessage } from "../../utils.js";
import { ALBUM_QUIET_PERIOD_MS, hasSupportedAttachment, unsupportedAttachmentMessage } from "./attachments.js";
import { ChatSession, replyTargetFromTelegramMessage } from "./chat-session.js";
import { parseCommand, routeTextMessage } from "./command-router.js";
import {
  buildGroupPrompt,
  DEFAULT_GROUP_HISTORY_HOURS,
  DEFAULT_GROUP_HISTORY_MESSAGES,
  GroupHistory,
  isBotAddressed
} from "./group-history.js";
import { MediaGroupBuffer } from "./media-group-buffer.js";
import { NOOP_CONFIG_STORE } from "../common/session-persistence.js";
import { TelegramApiError, TelegramBotApi } from "./telegram-api.js";
import { CHAT_COMMANDS, ROUTED_COMMAND_NAMES } from "../common/render.js";

export const TELEGRAM_COMMANDS = CHAT_COMMANDS;

const ROUTED_GROUP_COMMANDS = ROUTED_COMMAND_NAMES;

function unauthorizedMessage(user) {
  const username = normalizeTelegramUsername(user?.username);
  if (username) {
    return `You are not authorized to use this bot. Your Telegram username is @${username}. Add "${username}" to allowedUsernames in this Telegram binding.`;
  }

  return "You are not authorized to use this bot. Your Telegram account has no username set. Add one in Telegram Settings, then add it to allowedUsernames in this Telegram binding.";
}

const IGNORED_SERVICE_MESSAGE_FIELDS = [
  "forum_topic_created",
  "forum_topic_closed",
  "forum_topic_reopened",
  "forum_topic_edited",
  "general_forum_topic_hidden",
  "general_forum_topic_unhidden"
];

function isIgnoredServiceMessage(message) {
  return IGNORED_SERVICE_MESSAGE_FIELDS.some((field) => message?.[field]);
}

function messageText(message) {
  if (typeof message?.text === "string") {
    return message.text;
  }
  if (typeof message?.caption === "string") {
    return message.caption;
  }
  return "";
}

function messageId(message) {
  const id = Number(message?.message_id);
  return Number.isFinite(id) ? id : null;
}

function latestMessageById(messages) {
  let latest = null;
  let latestId = null;

  for (const message of messages) {
    const id = messageId(message);
    if (latest === null || (id !== null && (latestId === null || id > latestId))) {
      latest = message;
      latestId = id;
    }
  }

  return latest;
}

function groupLikeConversationId(message) {
  const chatType = message?.chat?.type;
  if (chatType === "group" || chatType === "supergroup") {
    return String(message.chat.id);
  }

  if (chatType === "private") {
    const title = typeof message?.chat?.title === "string" ? message.chat.title.trim() : "";
    if (title) {
      const topicId =
        message?.direct_messages_topic?.topic_id ??
        message?.message_thread_id;
      return topicId === null || topicId === undefined
        ? String(message.chat.id)
        : `${message.chat.id}:topic:${topicId}`;
    }
  }

  return null;
}

export class BotRuntime {
  constructor({
    botConfig,
    configStore = NOOP_CONFIG_STORE,
    fetchImpl = globalThis.fetch,
    botApi = null,
    createAgentRun = null,
    createCodexRun = null,
    cacheRootDir = DEFAULT_CACHE_PATH,
    albumQuietPeriodMs = ALBUM_QUIET_PERIOD_MS
  }) {
    this.botConfig = botConfig;
    this.configStore = configStore;
    this.botApi = botApi ?? new TelegramBotApi(botConfig.token, fetchImpl);
    this.createAgentRun = createAgentRun ?? createCodexRun;
    this.cacheRootDir = cacheRootDir;
    this.albumQuietPeriodMs = albumQuietPeriodMs;
    this.botUsername = null;
    this.offset = undefined;
    this.polling = false;
    this.pollPromise = null;
    this.pollAbortController = null;
    this.sessions = new Map();
    this.groupHistories = new Map();
    this.mediaGroupBuffer = new MediaGroupBuffer({ quietPeriodMs: albumQuietPeriodMs });
  }

  log(message) {
    process.stderr.write(`[telegram:@${this.botConfig.username}] ${message}\n`);
  }

  sessionFor(chatId, options = {}) {
    const conversationId = options.conversationId ?? chatId;
    const key = String(conversationId);
    let session = this.sessions.get(key);
    if (!session) {
      session = new ChatSession({
        botConfig: this.botConfig,
        botApi: this.botApi,
        configStore: this.configStore,
        logger: (message) => this.log(`${key}: ${message}`),
        chatId,
        conversationId,
        cacheRootDir: this.cacheRootDir,
        createAgentRun: this.createAgentRun
      });
      this.sessions.set(key, session);
    }
    return session;
  }

  groupHistoryFor(conversationId) {
    const key = String(conversationId);
    let history = this.groupHistories.get(key);
    if (!history) {
      const groupHistory = this.botConfig.groupHistory ?? {};
      history = new GroupHistory({
        maxHours: groupHistory.hours ?? DEFAULT_GROUP_HISTORY_HOURS,
        maxMessages: groupHistory.messages ?? DEFAULT_GROUP_HISTORY_MESSAGES
      });
      this.groupHistories.set(key, history);
    }
    return history;
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
    this.botUsername = normalizeTelegramUsername(me.username);
    if (this.botUsername !== this.botConfig.username) {
      throw new Error(
        `Configured Telegram bot username @${this.botConfig.username} does not match token owner @${this.botUsername || "unknown"}.`
      );
    }
    await this.discardPendingUpdates();
    await this.botApi.setMyCommands(TELEGRAM_COMMANDS);
    this.log(
      `ready as @${this.botUsername} for agent ${this.botConfig.agent.id} with workdir ${this.botConfig.agent.workdir}`
    );
  }

  async discardPendingUpdates() {
    const updates = await this.botApi.getUpdates({
      offset: -1,
      limit: 1,
      timeout: 0
    });
    const lastUpdate = updates.at(-1);
    if (typeof lastUpdate?.update_id === "number") {
      this.offset = lastUpdate.update_id + 1;
    }
  }

  async sendDirectMessage(chatId, text) {
    const session = this.sessionFor(chatId);
    await session.sendText(text);
  }

  async handleClearCache(sessionOrChatId, options = {}) {
    const session =
      sessionOrChatId instanceof ChatSession
        ? sessionOrChatId
        : this.sessionFor(sessionOrChatId);
    if (this.hasPendingBotWork()) {
      await session.sendText(
        "Cannot clear cache while runs, queued turns, or media albums are pending.",
        options
      );
      return;
    }

    try {
      await session.clearCache();
    } catch (error) {
      await session.sendText(`Failed to clear cache: ${toErrorMessage(error)}`, options);
      return;
    }

    await session.sendText("Cleared cache for this chat.", options);
  }

  async handleMessage(message) {
    const chatId = message.chat?.id;
    if (!chatId) {
      return;
    }

    const groupConversationId = groupLikeConversationId(message);
    if (groupConversationId !== null) {
      await this.handleGroupMessage(message, { conversationId: groupConversationId });
      return;
    }

    if (message.chat?.type === "private") {
      await this.handlePrivateMessage(message);
      return;
    }
  }

  async handlePrivateMessage(message) {
    const chatId = message.chat?.id;
    if (!this.isAuthorized(message.from)) {
      await this.sendDirectMessage(chatId, unauthorizedMessage(message.from));
      return;
    }

    if (isIgnoredServiceMessage(message)) {
      return;
    }

    const session = this.sessionFor(chatId);
    const replyTarget = replyTargetFromTelegramMessage(message);
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
        runtime: this,
        replyTarget
      });
      return;
    }

    await session.sendText(unsupportedAttachmentMessage(), { replyTarget });
  }

  async handleGroupMessage(message, { conversationId = message.chat?.id } = {}) {
    const chatId = message.chat?.id;
    if (isIgnoredServiceMessage(message)) {
      return;
    }

    const session = this.sessionFor(chatId, { conversationId });
    const history = this.groupHistoryFor(conversationId);
    const addressed = isBotAddressed(message, this.botUsername ?? this.botConfig.username);
    history.remember(message);

    if (!this.isAuthorized(message.from)) {
      if (hasSupportedAttachment(message)) {
        await this.mediaGroupBuffer.queue(session, message, null);
      }
      return;
    }

    if (!addressed && hasSupportedAttachment(message)) {
      await this.mediaGroupBuffer.queue(session, message, null);
      return;
    }

    if (!addressed) {
      return;
    }

    const text = messageText(message);
    const parsedCommand = parseCommand(text, this.botUsername ?? this.botConfig.username);
    if (ROUTED_GROUP_COMMANDS.has(parsedCommand?.command)) {
      await routeTextMessage({
        text,
        botUsername: this.botUsername ?? this.botConfig.username,
        session,
        runtime: this,
        replyTarget: replyTargetFromTelegramMessage(message)
      });
      return;
    }

    if (hasSupportedAttachment(message)) {
      await this.mediaGroupBuffer.queue(session, message, (messages) =>
        this.handleGroupTriggerMessages({ session, history, messages, triggerMessage: message })
      );
      return;
    }

    await this.handleGroupTriggerMessages({
      session,
      history,
      triggerMessage: message,
      messages: [message]
    });
  }

  async handleGroupTriggerMessages({ session, history, messages, triggerMessage = null }) {
    if (!Array.isArray(messages) || messages.length === 0) {
      return;
    }

    const primaryMessage = triggerMessage ?? messages[0];
    const referenceMessage = primaryMessage.reply_to_message ?? null;
    const attachmentMessages = [
      ...messages,
      ...(referenceMessage ? [referenceMessage] : [])
    ];

    try {
      const contextMessages = history.contextBefore(primaryMessage);
      const promptText = buildGroupPrompt({
        contextMessages,
        triggerMessage: primaryMessage,
        attachmentMessages: messages,
        referenceMessage
      });
      const attachments = await session.stageAttachmentsFromMessages(attachmentMessages);

      history.markTriggered(latestMessageById(messages) ?? primaryMessage);
      await session.enqueueTurn({
        promptText,
        attachments,
        replyTarget: replyTargetFromTelegramMessage(primaryMessage)
      });
    } catch (error) {
      await session.sendText(toErrorMessage(error), {
        replyTarget: replyTargetFromTelegramMessage(primaryMessage)
      });
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
