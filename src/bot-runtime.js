import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  ALBUM_QUIET_PERIOD_MS,
  ATTACHMENT_SIZE_LIMIT_BYTES,
  attachmentDescriptorFromMessage,
  attachmentLimitText,
  buildAttachmentFileName,
  buildAttachmentPrompt,
  hasSupportedAttachment,
  unsupportedAttachmentMessage
} from "./attachments.js";
import { eventToActions } from "./codex-events.js";
import { buildCodexArgs, startCodexRun } from "./codex-runner.js";
import { buildTurnUsage, readContextLengthForThread } from "./codex-usage.js";
import {
  cronMatchesDate,
  formatScheduleMinuteKey,
  normalizeSchedule,
  normalizeScheduleName,
  scheduleLookupKey
} from "./schedules.js";
import {
  DEFAULT_MODEL,
  DEFAULT_REASONING_EFFORT,
  normalizeSettingArgument
} from "./runtime-settings.js";
import {
  formatYolo,
  parseYoloArgument,
  YOLO_DEFAULT
} from "./yolo.js";
import {
  escapeTelegramMarkdown,
  renderStatusMessage
} from "./render.js";
import { TelegramApiError, TelegramBotApi } from "./telegram-api.js";
import {
  DEFAULT_CACHE_PATH,
  buildChatCacheDirName,
  ensureDir,
  expandWorkdirPath,
  formatTokenCountK,
  INVALID_WORKDIR_MESSAGE,
  normalizeTelegramUsername,
  resolveWorkdirPath,
  splitPlainText,
  sleep,
  toErrorMessage
} from "./utils.js";

export const TELEGRAM_COMMANDS = [
  { command: "status", description: "Show current Codex status" },
  { command: "schedule", description: "Manage scheduled prompts for this chat" },
  { command: "workdir", description: "Show or change the bot workdir" },
  { command: "yolo", description: "Toggle full-access Codex mode" },
  { command: "model", description: "Set model for future runs" },
  { command: "reasoning", description: "Set reasoning effort for future runs" },
  { command: "clear_cache", description: "Clear cached attachments for this bot" },
  { command: "abort", description: "Abort current run and clear queued messages" },
  { command: "new", description: "Start a fresh session and clear context" }
];

const NOOP_CONFIG_STORE = {
  async patchBotConfig() {}
};

function isParseError(error) {
  return (
    error instanceof TelegramApiError &&
    error.errorCode === 400 &&
    /parse entities/i.test(error.message)
  );
}

const TELEGRAM_RENDER_CHUNK_SIZE = 3500;
const SCHEDULE_TICK_INTERVAL_MS = 30_000;

function scheduleUsageText() {
  return [
    "Usage:",
    "/schedule list",
    "/schedule add <name>",
    "<cron>",
    "",
    "<prompt>",
    "/schedule pause <name>",
    "/schedule resume <name>",
    "/schedule delete <name>",
    "/schedule run <name>"
  ].join("\n");
}

function getTelegramMessageId(result) {
  const rawMessageId = result?.message_id ?? result?.messageId;
  const messageId = Number(rawMessageId);
  return Number.isFinite(messageId) ? messageId : null;
}

function formatProgressText(text) {
  return `🟢 ${text}`;
}

function normalizeCaption(value) {
  return String(value ?? "").trim();
}

function mediaGroupKey(chatId, mediaGroupId) {
  return `${chatId}:${mediaGroupId}`;
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

  return {
    command: commandName.toLowerCase(),
    args: trimmed.slice(token.length).trim()
  };
}

function unauthorizedMessage(user) {
  const username = normalizeTelegramUsername(user?.username);
  if (username) {
    return `You are not authorized to use this bot. Your Telegram username is @${username}. Add "${username}" to allowedUsernames in the relay config.`;
  }

  return "You are not authorized to use this bot. Your Telegram account has no username set. Add one in Telegram Settings, then add it to allowedUsernames in the relay config.";
}

function formatScheduleOutput(name, text) {
  return `[schedule: ${name}]\n\n${text}`;
}

function parseScheduleCommandArgs(args) {
  const trimmed = String(args ?? "").trim();
  if (!trimmed) {
    return { subcommand: null };
  }

  const [subcommand] = trimmed.split(/\s+/, 1);
  const remainder = trimmed.slice(subcommand.length).trimStart();
  return {
    subcommand: subcommand.toLowerCase(),
    remainder
  };
}

export class ChatSession {
  constructor({
    botConfig,
    botApi,
    stateStore,
    configStore,
    logger,
    chatId,
    cacheRootDir = DEFAULT_CACHE_PATH,
    createCodexRun = startCodexRun,
    resolveContextLength = readContextLengthForThread,
    resolveHomeDir
  }) {
    this.botConfig = botConfig;
    this.botApi = botApi;
    this.stateStore = stateStore;
    this.configStore = configStore ?? NOOP_CONFIG_STORE;
    this.logger = logger;
    this.chatId = chatId;
    this.cacheRootDir = cacheRootDir;

    const persisted = stateStore.getChatState(botConfig.name, chatId);
    this.threadId = persisted.threadId;
    this.lastUsage = persisted.lastUsage;
    this.cumulativeUsage = persisted.cumulativeUsage;
    this.yolo = persisted.yolo ?? botConfig.yolo ?? YOLO_DEFAULT;
    this.model = persisted.model ?? botConfig.model ?? DEFAULT_MODEL;
    this.reasoningEffort =
      persisted.reasoningEffort ?? botConfig.reasoningEffort ?? DEFAULT_REASONING_EFFORT;
    this.queue = [];
    this.isRunning = false;
    this.activeRun = null;
    this.typingTimer = null;
    this.createCodexRun = createCodexRun;
    this.resolveContextLength = resolveContextLength;
    this.resolveHomeDir = resolveHomeDir;
    this.progressMessageId = null;
    this.lastRenderedProgressText = null;
  }

  resetTransientTurnState() {
    this.progressMessageId = null;
    this.lastRenderedProgressText = null;
  }

  async sendMessageChunk(rawChunk) {
    const chunk = escapeTelegramMarkdown(rawChunk);
    try {
      return await this.botApi.sendMessage({
        chatId: this.chatId,
        text: chunk,
        parseMode: "MarkdownV2"
      });
    } catch (error) {
      if (!isParseError(error)) {
        throw error;
      }

      return this.botApi.sendMessage({
        chatId: this.chatId,
        text: rawChunk
      });
    }
  }

  async editMessageChunk(messageId, rawChunk) {
    const chunk = escapeTelegramMarkdown(rawChunk);
    try {
      return await this.botApi.editMessageText({
        chatId: this.chatId,
        messageId,
        text: chunk,
        parseMode: "MarkdownV2"
      });
    } catch (error) {
      if (!isParseError(error)) {
        throw error;
      }

      return this.botApi.editMessageText({
        chatId: this.chatId,
        messageId,
        text: rawChunk
      });
    }
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

  async renderFinalMessage(text) {
    const rawText = String(text ?? "");
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

  async renderErrorText(text) {
    const rawText = String(text ?? "").trim();
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

  async sendText(text) {
    const rawText = String(text ?? "");
    if (!rawText) {
      return;
    }

    await this.sendSplitText(rawText);
  }

  startTyping() {
    if (this.typingTimer) {
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

  cacheDir() {
    return path.join(this.cacheRootDir, this.botConfig.name);
  }

  chatCacheDir() {
    return path.join(this.cacheDir(), buildChatCacheDirName(this.chatId));
  }

  normalizeTurn(turn) {
    if (typeof turn === "string") {
      const promptText = String(turn).trim();
      return promptText ? { promptText, attachments: [] } : null;
    }

    const promptText = String(turn?.promptText ?? "").trim();
    const attachments = Array.isArray(turn?.attachments) ? turn.attachments.filter(Boolean) : [];
    if (!promptText && attachments.length === 0) {
      return null;
    }

    return {
      promptText,
      attachments
    };
  }

  async clearCache() {
    await fs.rm(this.cacheDir(), { recursive: true, force: true });
  }

  async stageAttachment(descriptor) {
    if (descriptor.fileSize !== null && descriptor.fileSize > ATTACHMENT_SIZE_LIMIT_BYTES) {
      throw new Error(
        `${descriptor.fileName ?? descriptor.kind} exceeds the ${attachmentLimitText()} limit.`
      );
    }

    const file = await this.botApi.getFile(descriptor.telegramFileId);
    const resolvedFileSize = Number.isFinite(Number(file?.file_size)) ? Number(file.file_size) : descriptor.fileSize;
    if (resolvedFileSize !== null && resolvedFileSize > ATTACHMENT_SIZE_LIMIT_BYTES) {
      throw new Error(
        `${descriptor.fileName ?? descriptor.kind} exceeds the ${attachmentLimitText()} limit.`
      );
    }

    if (typeof file?.file_path !== "string" || !file.file_path) {
      throw new Error("Telegram did not return a downloadable file path.");
    }

    const fileName = buildAttachmentFileName({
      kind: descriptor.kind,
      fileName: descriptor.fileName,
      filePath: file.file_path,
      sourceMessageId: descriptor.sourceMessageId
    });
    const localPath = path.join(this.chatCacheDir(), fileName);

    await ensureDir(path.dirname(localPath));
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

  async handleAttachmentMessages(messages) {
    if (!Array.isArray(messages) || messages.length === 0) {
      return;
    }

    try {
      const turn = await this.buildAttachmentTurn(messages);
      await this.enqueueTurn(turn);
    } catch (error) {
      await this.sendText(toErrorMessage(error));
    }
  }

  snapshotPersistedState() {
    return {
      threadId: this.threadId,
      lastUsage: this.lastUsage,
      cumulativeUsage: this.cumulativeUsage
    };
  }

  restorePersistedState(snapshot) {
    this.threadId = snapshot.threadId;
    this.lastUsage = snapshot.lastUsage;
    this.cumulativeUsage = snapshot.cumulativeUsage;
  }

  async updateThreadId(threadId) {
    const previousState = this.snapshotPersistedState();

    try {
      await this.stateStore.patchChatState(this.botConfig.name, this.chatId, {
        threadId,
        lastUsage: this.lastUsage,
        cumulativeUsage: this.cumulativeUsage
      });
    } catch (error) {
      this.restorePersistedState(previousState);
      throw error;
    }

    this.threadId = threadId;
  }

  async updateUsage({ lastUsage, cumulativeUsage }) {
    const previousState = this.snapshotPersistedState();

    try {
      await this.stateStore.patchChatState(this.botConfig.name, this.chatId, {
        threadId: this.threadId,
        lastUsage,
        cumulativeUsage
      });
    } catch (error) {
      this.restorePersistedState(previousState);
      throw error;
    }

    this.lastUsage = lastUsage;
    this.cumulativeUsage = cumulativeUsage;
  }

  async clearPersistedState() {
    const previousState = this.snapshotPersistedState();

    try {
      await this.stateStore.patchChatState(this.botConfig.name, this.chatId, {
        threadId: null,
        lastUsage: null,
        cumulativeUsage: null
      });
    } catch (error) {
      this.restorePersistedState(previousState);
      throw error;
    }

    this.threadId = null;
    this.lastUsage = null;
    this.cumulativeUsage = null;
  }

  async persistBotConfig(patch) {
    const previousValues = {};
    for (const [key] of Object.entries(patch)) {
      previousValues[key] = this.botConfig[key];
    }

    await this.configStore.patchBotConfig(this.botConfig.name, patch);
    Object.assign(this.botConfig, patch);

    return previousValues;
  }

  async rollbackBotConfig(previousValues) {
    try {
      await this.configStore.patchBotConfig(this.botConfig.name, previousValues);
    } catch (error) {
      this.logger(`config rollback failed: ${toErrorMessage(error)}`);
      throw error;
    }

    Object.assign(this.botConfig, previousValues);
  }

  workdirValidationError() {
    return `Invalid workdir. ${INVALID_WORKDIR_MESSAGE}`;
  }

  async resolveRequestedWorkdir(args) {
    try {
      return await resolveWorkdirPath(args, {
        homeDir: this.resolveHomeDir ? this.resolveHomeDir() : undefined
      });
    } catch (error) {
      if (error instanceof Error && error.message === INVALID_WORKDIR_MESSAGE) {
        throw new Error(this.workdirValidationError());
      }
      throw error;
    }
  }

  async handleWorkdir(args) {
    const requestedWorkdir = normalizeSettingArgument(args);
    if (!requestedWorkdir) {
      await this.sendText(`Current workdir: ${this.botConfig.workdir}.`);
      return;
    }

    const homeDir = this.resolveHomeDir ? this.resolveHomeDir() : undefined;
    let normalizedWorkdir;
    try {
      normalizedWorkdir = expandWorkdirPath(requestedWorkdir, { homeDir });
    } catch (error) {
      if (error instanceof Error && error.message === INVALID_WORKDIR_MESSAGE) {
        await this.sendText(this.workdirValidationError());
        return;
      }
      await this.sendText(toErrorMessage(error));
      return;
    }

    if (normalizedWorkdir === this.botConfig.workdir) {
      await this.sendText(`Workdir is already set to ${normalizedWorkdir}.`);
      return;
    }

    let nextWorkdir;
    try {
      nextWorkdir = await this.resolveRequestedWorkdir(normalizedWorkdir);
    } catch (error) {
      await this.sendText(toErrorMessage(error));
      return;
    }

    const previousState = this.snapshotPersistedState();
    const previousWorkdir = this.botConfig.workdir;

    this.queue = [];
    await this.abortCurrentRun();
    this.stopTyping();
    this.resetTransientTurnState();

    try {
      await this.persistBotConfig({ workdir: nextWorkdir });
    } catch (error) {
      await this.sendText(`Failed to persist workdir setting: ${toErrorMessage(error)}`);
      return;
    }

    try {
      await this.clearPersistedState();
    } catch (error) {
      this.restorePersistedState(previousState);

      try {
        await this.rollbackBotConfig({ workdir: previousWorkdir });
      } catch (rollbackError) {
        await this.sendText(
          `Failed to reset session after changing workdir: ${toErrorMessage(error)}. Config rollback also failed: ${toErrorMessage(rollbackError)}`
        );
        return;
      }

      await this.sendText(`Failed to reset session after changing workdir: ${toErrorMessage(error)}`);
      return;
    }

    await this.sendText(
      `Workdir set to ${nextWorkdir}. Started a new session. The next message will open a fresh Codex thread.`
    );
  }

  async persistRuntimeSettings(patch) {
    const previousDefaults = await this.persistBotConfig(patch);

    try {
      await this.stateStore.patchChatState(this.botConfig.name, this.chatId, patch);
    } catch (error) {
      try {
        await this.rollbackBotConfig(previousDefaults);
      } catch (rollbackError) {
        this.logger(`runtime settings rollback failed: ${toErrorMessage(rollbackError)}`);
      }
      throw error;
    }
  }

  async applyRuntimeSettings(patch) {
    await this.persistRuntimeSettings(patch);
    if (Object.hasOwn(patch, "yolo")) {
      this.yolo = patch.yolo;
    }
    if (Object.hasOwn(patch, "model")) {
      this.model = patch.model;
    }
    if (Object.hasOwn(patch, "reasoningEffort")) {
      this.reasoningEffort = patch.reasoningEffort;
    }
  }

  statusText() {
    return renderStatusMessage({
      isRunning: this.isRunning,
      workdir: this.botConfig.workdir,
      yolo: this.yolo,
      model: this.model,
      reasoningEffort: this.reasoningEffort,
      usage: {
        contextLength: formatTokenCountK(this.lastUsage?.contextLength)
      },
      queue: this.queue
    });
  }

  async handleStatus() {
    await this.sendText(this.statusText());
  }

  async handleYolo(args) {
    const normalized = String(args || "").trim();
    const nextYolo = normalized ? parseYoloArgument(normalized) : !this.yolo;
    if (normalized && nextYolo === null) {
      await this.sendText(
        "Unknown yolo value. Use /yolo, /yolo on, or /yolo off."
      );
      return;
    }

    const previousYolo = this.yolo;
    try {
      await this.applyRuntimeSettings({ yolo: nextYolo });
    } catch (error) {
      await this.sendText(`Failed to persist yolo setting: ${toErrorMessage(error)}`);
      return;
    }

    if (this.isRunning) {
      await this.sendText(
        `Yolo set to ${formatYolo(nextYolo)}. The current run stays on ${formatYolo(previousYolo)}; the next run will use ${formatYolo(nextYolo)}.`
      );
      return;
    }

    await this.sendText(`Yolo set to ${formatYolo(nextYolo)}.`);
  }

  async handleModel(args) {
    const nextModel = normalizeSettingArgument(args);
    if (!nextModel) {
      await this.sendText(`Current model: ${this.model}.`);
      return;
    }

    const previousModel = this.model;
    try {
      await this.applyRuntimeSettings({ model: nextModel });
    } catch (error) {
      await this.sendText(`Failed to persist model setting: ${toErrorMessage(error)}`);
      return;
    }

    if (this.isRunning) {
      await this.sendText(
        `Model set to ${nextModel}. The current run stays on ${previousModel}; the next run will use ${nextModel}.`
      );
      return;
    }

    await this.sendText(`Model set to ${nextModel}.`);
  }

  async handleReasoningEffort(args) {
    const nextReasoningEffort = normalizeSettingArgument(args);
    if (!nextReasoningEffort) {
      await this.sendText(`Current reasoning effort: ${this.reasoningEffort}.`);
      return;
    }

    const previousReasoningEffort = this.reasoningEffort;
    try {
      await this.applyRuntimeSettings({ reasoningEffort: nextReasoningEffort });
    } catch (error) {
      await this.sendText(`Failed to persist reasoning effort setting: ${toErrorMessage(error)}`);
      return;
    }

    if (this.isRunning) {
      await this.sendText(
        `Reasoning effort set to ${nextReasoningEffort}. The current run stays on ${previousReasoningEffort}; the next run will use ${nextReasoningEffort}.`
      );
      return;
    }

    await this.sendText(`Reasoning effort set to ${nextReasoningEffort}.`);
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
    this.resetTransientTurnState();
    await this.sendText(
      wasRunning ? "Aborted current run and cleared the queue." : "No active run. Queue cleared."
    );
  }

  async handleNewSession() {
    this.queue = [];
    await this.abortCurrentRun();
    this.stopTyping();
    this.resetTransientTurnState();
    await this.clearPersistedState();
    await this.sendText("Started a new session. The next message will open a fresh Codex thread.");
  }

  async enqueueTurn(turn) {
    const normalizedTurn = this.normalizeTurn(turn);
    if (!normalizedTurn) {
      return;
    }

    if (this.isRunning) {
      this.queue.push(normalizedTurn);
      await this.sendText(`Queued message ${this.queue.length}.`);
      return;
    }

    this.queue.push(normalizedTurn);
    void this.drainQueue();
  }

  async enqueueMessage(text) {
    await this.enqueueTurn({
      promptText: text,
      attachments: []
    });
  }

  async drainQueue() {
    if (this.isRunning) {
      return;
    }

    const nextTurn = this.queue.shift();
    if (!nextTurn) {
      return;
    }

    this.isRunning = true;
    this.startTyping();
    this.resetTransientTurnState();

    let emittedError = false;
    const initialThreadId = this.threadId;
    const previousCumulativeUsage = this.cumulativeUsage;
    let currentThreadId = this.threadId;
    let completedTurnCumulativeUsage = null;
    const imagePaths = nextTurn.attachments
      .filter((attachment) => attachment.mode === "native-image")
      .map((attachment) => attachment.localPath);
    const message = buildAttachmentPrompt(nextTurn.promptText, nextTurn.attachments);
    const debugArgs = buildCodexArgs({
      workdir: this.botConfig.workdir,
      threadId: this.threadId,
      message,
      imagePaths,
      yolo: this.yolo,
      model: this.model,
      reasoningEffort: this.reasoningEffort
    });
    const redactedArgs = debugArgs.slice();
    if (redactedArgs.length > 0) {
      redactedArgs[redactedArgs.length - 1] = `<prompt:${message.length}>`;
    }
    this.logger(
      `starting codex run ${JSON.stringify({
        threadId: this.threadId,
        attachments: nextTurn.attachments.map((attachment) => ({
          kind: attachment.kind,
          mode: attachment.mode,
          localPath: attachment.localPath
        })),
        args: redactedArgs
      })}`
    );

    const run = this.createCodexRun({
      workdir: this.botConfig.workdir,
      threadId: this.threadId,
      message,
      imagePaths,
      yolo: this.yolo,
      model: this.model,
      reasoningEffort: this.reasoningEffort,
      onEvent: async (event) => {
        const actions = eventToActions(event);
        for (const action of actions) {
          if (action.kind === "thread_started" && action.threadId) {
            currentThreadId = action.threadId;
            await this.updateThreadId(action.threadId);
            continue;
          }
          if (action.kind === "turn_completed") {
            completedTurnCumulativeUsage = action.cumulativeUsage;
            continue;
          }
          if (action.kind === "progress") {
            await this.renderProgressText(action.text);
            continue;
          }
          if (action.kind === "error") {
            emittedError = true;
            await this.renderErrorText(action.text);
            continue;
          }
          if (action.kind === "message") {
            await this.renderFinalMessage(action.text);
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
      if (completedTurnCumulativeUsage) {
        // Codex emits cumulative usage totals on `turn.completed`. The last model-call
        // size must be read from the rollout log to match Hi-Boss's context-length semantics.
        const contextLength = await this.resolveContextLength(currentThreadId);
        const lastUsage = buildTurnUsage({
          contextLength,
          currentCumulativeUsage: completedTurnCumulativeUsage,
          previousCumulativeUsage,
          isResume: Boolean(initialThreadId)
        });
        await this.updateUsage({
          lastUsage,
          cumulativeUsage: completedTurnCumulativeUsage
        });
      }
      if (!result.sawTerminalEvent && !emittedError) {
        await this.renderErrorText("Codex exited without a terminal JSON event.");
      }
    } catch (error) {
      await this.renderErrorText(`Codex process error: ${toErrorMessage(error)}`);
    } finally {
      this.activeRun = null;
      this.isRunning = false;
      this.stopTyping();
      this.resetTransientTurnState();
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
    this.pendingMediaGroups = new Map();
    this.scheduleTimer = null;
    this.scheduleTriggerHistory = new Map();
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
    if (this.pendingMediaGroups.size > 0) {
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

  schedulesForChat(chatId) {
    return (this.botConfig.schedules ?? []).filter((schedule) => schedule.chatId === Number(chatId));
  }

  findSchedule(chatId, name) {
    const targetKey = scheduleLookupKey(chatId, name);
    return (this.botConfig.schedules ?? []).find(
      (schedule) => scheduleLookupKey(schedule.chatId, schedule.name) === targetKey
    );
  }

  async persistSchedules(nextSchedules) {
    await this.configStore.patchBotConfig(this.botConfig.name, { schedules: nextSchedules });
    this.botConfig.schedules = nextSchedules;
  }

  scheduleHistoryKey(schedule) {
    return scheduleLookupKey(schedule.chatId, schedule.name);
  }

  markScheduleCreated(schedule) {
    this.scheduleTriggerHistory.set(
      this.scheduleHistoryKey(schedule),
      formatScheduleMinuteKey(new Date())
    );
  }

  formatScheduleList(chatId) {
    const schedules = this.schedulesForChat(chatId)
      .slice()
      .sort((left, right) => left.name.localeCompare(right.name));
    if (schedules.length === 0) {
      return "No schedules for this chat.";
    }

    return [
      "Schedules for this chat:",
      ...schedules.map(
        (schedule) =>
          `- ${schedule.name}: ${schedule.enabled ? "on" : "paused"}, ${schedule.cron}`
      )
    ].join("\n");
  }

  async handleScheduleList(session) {
    await session.sendText(this.formatScheduleList(session.chatId));
  }

  parseScheduleAddPayload(remainder) {
    const normalizedRemainder = String(remainder ?? "").trimStart();
    if (!normalizedRemainder) {
      throw new Error(scheduleUsageText());
    }

    const [nameToken] = normalizedRemainder.split(/\s+/, 1);
    const name = normalizeScheduleName(nameToken);
    const body = normalizedRemainder.slice(nameToken.length).trimStart();
    const firstNewlineIndex = body.indexOf("\n");
    if (firstNewlineIndex < 0) {
      throw new Error(scheduleUsageText());
    }

    const cron = body.slice(0, firstNewlineIndex).trim();
    const prompt = body.slice(firstNewlineIndex + 1).trim();
    if (!cron || !prompt) {
      throw new Error(scheduleUsageText());
    }

    return { name, cron, prompt };
  }

  async handleScheduleAdd(session, remainder) {
    let schedule;
    try {
      const payload = this.parseScheduleAddPayload(remainder);
      schedule = normalizeSchedule(
        {
          ...payload,
          chatId: session.chatId,
          enabled: true
        },
        "schedule"
      );
    } catch (error) {
      await session.sendText(toErrorMessage(error));
      return;
    }

    if (this.findSchedule(session.chatId, schedule.name)) {
      await session.sendText(`Schedule ${schedule.name} already exists for this chat.`);
      return;
    }

    const nextSchedules = [...(this.botConfig.schedules ?? []), schedule];
    try {
      await this.persistSchedules(nextSchedules);
    } catch (error) {
      await session.sendText(`Failed to persist schedule: ${toErrorMessage(error)}`);
      return;
    }

    this.markScheduleCreated(schedule);
    await session.sendText(`Schedule ${schedule.name} added with cron ${schedule.cron}.`);
  }

  async updateSchedule(session, name, patch) {
    let normalizedName;
    try {
      normalizedName = normalizeScheduleName(name, "schedule name");
    } catch (error) {
      await session.sendText(toErrorMessage(error));
      return null;
    }

    const existing = this.findSchedule(session.chatId, normalizedName);
    if (!existing) {
      await session.sendText(`Schedule ${normalizedName} was not found for this chat.`);
      return null;
    }

    const nextSchedule = normalizeSchedule(
      {
        ...existing,
        ...patch
      },
      "schedule"
    );
    const nextSchedules = (this.botConfig.schedules ?? []).map((candidate) =>
      this.scheduleHistoryKey(candidate) === this.scheduleHistoryKey(existing) ? nextSchedule : candidate
    );

    try {
      await this.persistSchedules(nextSchedules);
    } catch (error) {
      await session.sendText(`Failed to persist schedule: ${toErrorMessage(error)}`);
      return null;
    }

    return nextSchedule;
  }

  async handleSchedulePause(session, name) {
    const schedule = await this.updateSchedule(session, name, { enabled: false });
    if (!schedule) {
      return;
    }

    await session.sendText(`Schedule ${schedule.name} paused.`);
  }

  async handleScheduleResume(session, name) {
    const schedule = await this.updateSchedule(session, name, { enabled: true });
    if (!schedule) {
      return;
    }

    await session.sendText(`Schedule ${schedule.name} resumed.`);
  }

  async handleScheduleDelete(session, name) {
    let normalizedName;
    try {
      normalizedName = normalizeScheduleName(name, "schedule name");
    } catch (error) {
      await session.sendText(toErrorMessage(error));
      return;
    }

    const existing = this.findSchedule(session.chatId, normalizedName);
    if (!existing) {
      await session.sendText(`Schedule ${normalizedName} was not found for this chat.`);
      return;
    }

    const nextSchedules = (this.botConfig.schedules ?? []).filter(
      (candidate) =>
        this.scheduleHistoryKey(candidate) !== this.scheduleHistoryKey(existing)
    );
    try {
      await this.persistSchedules(nextSchedules);
    } catch (error) {
      await session.sendText(`Failed to persist schedule: ${toErrorMessage(error)}`);
      return;
    }

    this.scheduleTriggerHistory.delete(this.scheduleHistoryKey(existing));
    await session.sendText(`Schedule ${existing.name} deleted.`);
  }

  async runSchedule(schedule) {
    const session = this.sessionFor(schedule.chatId);
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-telegram-relay-schedule-"));
    const outputPath = path.join(tempDir, "last-message.txt");
    const run = this.createCodexRun({
      workdir: session.botConfig.workdir,
      threadId: null,
      message: schedule.prompt,
      outputLastMessagePath: outputPath,
      ephemeral: true,
      yolo: session.yolo,
      model: session.model,
      reasoningEffort: session.reasoningEffort,
      onEvent: async () => {},
      onStdErr: (chunk) => {
        const message = chunk.trim();
        if (message) {
          this.log(`${schedule.chatId}: schedule ${schedule.name} stderr: ${message}`);
        }
      }
    });

    try {
      await run.done;
      const lastMessage = (await fs.readFile(outputPath, "utf8")).trim();
      if (!lastMessage) {
        throw new Error("No final agent message returned.");
      }
      await this.sendDirectMessage(
        schedule.chatId,
        formatScheduleOutput(schedule.name, lastMessage)
      );
    } catch (error) {
      await this.sendDirectMessage(
        schedule.chatId,
        formatScheduleOutput(schedule.name, `failed: ${toErrorMessage(error)}`)
      );
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }

  launchScheduleRun(schedule) {
    void this.runSchedule(schedule).catch((error) => {
      this.log(
        `${schedule.chatId}: schedule ${schedule.name} failed unexpectedly: ${toErrorMessage(error)}`
      );
    });
  }

  async handleScheduleRun(session, name) {
    let normalizedName;
    try {
      normalizedName = normalizeScheduleName(name, "schedule name");
    } catch (error) {
      await session.sendText(toErrorMessage(error));
      return;
    }

    const schedule = this.findSchedule(session.chatId, normalizedName);
    if (!schedule) {
      await session.sendText(`Schedule ${normalizedName} was not found for this chat.`);
      return;
    }

    this.launchScheduleRun(schedule);
    await session.sendText(`Schedule ${schedule.name} started.`);
  }

  async handleScheduleCommand(session, args) {
    const parsed = parseScheduleCommandArgs(args);
    switch (parsed.subcommand) {
      case "list":
        await this.handleScheduleList(session);
        return;
      case "add":
        await this.handleScheduleAdd(session, parsed.remainder);
        return;
      case "pause":
        await this.handleSchedulePause(session, parsed.remainder);
        return;
      case "resume":
        await this.handleScheduleResume(session, parsed.remainder);
        return;
      case "delete":
        await this.handleScheduleDelete(session, parsed.remainder);
        return;
      case "run":
        await this.handleScheduleRun(session, parsed.remainder);
        return;
      default:
        await session.sendText(scheduleUsageText());
    }
  }

  startScheduleLoop() {
    if (this.scheduleTimer) {
      return;
    }

    const tick = async () => {
      try {
        await this.tickSchedules();
      } catch (error) {
        this.log(`schedule tick failed: ${toErrorMessage(error)}`);
      }
    };

    this.scheduleTimer = setInterval(() => {
      void tick();
    }, SCHEDULE_TICK_INTERVAL_MS);
    void tick();
  }

  stopScheduleLoop() {
    if (!this.scheduleTimer) {
      return;
    }

    clearInterval(this.scheduleTimer);
    this.scheduleTimer = null;
  }

  async tickSchedules(now = new Date()) {
    const minuteKey = formatScheduleMinuteKey(now);
    for (const schedule of this.botConfig.schedules ?? []) {
      if (!schedule.enabled || !cronMatchesDate(schedule.cron, now)) {
        continue;
      }

      const historyKey = this.scheduleHistoryKey(schedule);
      if (this.scheduleTriggerHistory.get(historyKey) === minuteKey) {
        continue;
      }

      this.scheduleTriggerHistory.set(historyKey, minuteKey);
      this.launchScheduleRun(schedule);
    }
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

  queueMediaGroupMessage(session, message) {
    const mediaGroupId = message?.media_group_id;
    if (!mediaGroupId) {
      return session.handleAttachmentMessages([message]);
    }

    const key = mediaGroupKey(session.chatId, mediaGroupId);
    const existing = this.pendingMediaGroups.get(key);
    if (existing?.timer) {
      clearTimeout(existing.timer);
    }

    const entry = existing ?? {
      session,
      messages: []
    };
    entry.messages.push(message);
    entry.timer = setTimeout(() => {
      void this.flushMediaGroup(key);
    }, this.albumQuietPeriodMs);

    this.pendingMediaGroups.set(key, entry);
    return undefined;
  }

  async flushMediaGroup(key) {
    const entry = this.pendingMediaGroups.get(key);
    if (!entry) {
      return;
    }

    clearTimeout(entry.timer);
    this.pendingMediaGroups.delete(key);
    await entry.session.handleAttachmentMessages(entry.messages);
  }

  clearPendingMediaGroups() {
    for (const entry of this.pendingMediaGroups.values()) {
      clearTimeout(entry.timer);
    }
    this.pendingMediaGroups.clear();
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
      await this.queueMediaGroupMessage(session, message);
      return;
    }

    const text = message.text;
    if (typeof text === "string" && text.trim()) {
      const parsedCommand = parseCommand(text, this.botUsername);
      if (parsedCommand?.ignored) {
        return;
      }

      switch (parsedCommand?.command) {
        case "status":
          await session.handleStatus();
          return;
        case "schedule":
          await this.handleScheduleCommand(session, parsedCommand.args);
          return;
        case "workdir":
          await session.handleWorkdir(parsedCommand.args);
          return;
        case "yolo":
          await session.handleYolo(parsedCommand.args);
          return;
        case "model":
          await session.handleModel(parsedCommand.args);
          return;
        case "reasoning":
          await session.handleReasoningEffort(parsedCommand.args);
          return;
        case "clear_cache":
          await this.handleClearCache(chatId);
          return;
        case "abort":
          await session.handleAbort();
          return;
        case "new":
          await session.handleNewSession();
          return;
        default:
          await session.enqueueMessage(text);
          return;
      }
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
    this.startScheduleLoop();

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
    this.stopScheduleLoop();
    this.clearPendingMediaGroups();

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
