import fs from "node:fs/promises";
import path from "node:path";

import {
  ATTACHMENT_SIZE_LIMIT_BYTES,
  attachmentDescriptorFromMessage,
  attachmentLimitText,
  buildAttachmentFileName
} from "../attachments.js";
import { formatAuto, parseAutoArgument } from "../auto-mode.js";
import { buildCodexArgs } from "../codex/args.js";
import { eventToActions } from "../codex/events.js";
import { readContextLengthForThread } from "../codex/context-length.js";
import { startCodexRun } from "../codex/runner.js";
import { buildTurnInputMessage } from "../prompt/turn-input.js";
import { TELEGRAM_OUTPUT_DEVELOPER_INSTRUCTIONS } from "../prompt/telegram-output.js";
import { renderStatusMessage } from "../render.js";
import {
  normalizeSettingArgument
} from "../runtime-settings.js";
import {
  DEFAULT_CACHE_PATH,
  buildChatCacheDirName,
  ensureDir,
  expandWorkdirPath,
  formatTokenCountK,
  INVALID_WORKDIR_MESSAGE,
  resolveWorkdirPath,
  toErrorMessage
} from "../utils.js";
import { unsupportedAttachmentMessage } from "../attachments.js";
import { MessageRenderer } from "./message-renderer.js";
import { NOOP_CONFIG_STORE, SessionPersistence } from "./session-persistence.js";
import { prepareForSessionReset, resetSession } from "./session-reset.js";

function normalizeCaption(value) {
  return String(value ?? "").trim();
}

/**
 * @typedef {import("../prompt/turn-input.js").Turn} Turn
 */

export class ChatSession {
  constructor({
    botConfig,
    botApi,
    stateStore,
    configStore = NOOP_CONFIG_STORE,
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
    this.configStore = configStore;
    this.logger = logger;
    this.chatId = chatId;
    this.cacheRootDir = cacheRootDir;
    this.queue = [];
    this.isRunning = false;
    this.activeRun = null;
    this.typingTimer = null;
    this.createCodexRun = createCodexRun;
    this.resolveContextLength = resolveContextLength;
    this.resolveHomeDir = resolveHomeDir;
    this.messageRenderer = new MessageRenderer({ botApi, chatId });
    this.persistence = new SessionPersistence({
      botConfig,
      stateStore,
      configStore,
      chatId,
      logger
    });
  }

  get threadId() {
    return this.persistence.threadId;
  }

  set threadId(threadId) {
    this.persistence.threadId = threadId;
  }

  get contextLength() {
    return this.persistence.contextLength;
  }

  set contextLength(contextLength) {
    this.persistence.contextLength = contextLength;
  }

  get auto() {
    return this.persistence.auto;
  }

  set auto(auto) {
    this.persistence.auto = auto;
  }

  get model() {
    return this.persistence.model;
  }

  set model(model) {
    this.persistence.model = model;
  }

  get reasoningEffort() {
    return this.persistence.reasoningEffort;
  }

  set reasoningEffort(reasoningEffort) {
    this.persistence.reasoningEffort = reasoningEffort;
  }

  resetTransientTurnState() {
    this.messageRenderer.resetTransientState();
  }

  sendMessageChunk(rawChunk) {
    return this.messageRenderer.sendMessageChunk(rawChunk);
  }

  editMessageChunk(messageId, rawChunk) {
    return this.messageRenderer.editMessageChunk(messageId, rawChunk);
  }

  sendSplitText(rawText) {
    return this.messageRenderer.sendSplitText(rawText);
  }

  renderProgressText(text) {
    return this.messageRenderer.renderProgressText(text);
  }

  renderFinalMessage(text) {
    return this.messageRenderer.renderFinalMessage(text, {
      workdir: this.botConfig.workdir
    });
  }

  renderErrorText(text) {
    return this.messageRenderer.renderErrorText(text);
  }

  sendText(text) {
    return this.messageRenderer.sendText(text);
  }

  sendCodexOutput(text) {
    return this.messageRenderer.sendCodexOutput(text, {
      workdir: this.botConfig.workdir
    });
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
    const resolvedFileSize =
      Number.isFinite(Number(file?.file_size)) ? Number(file.file_size) : descriptor.fileSize;
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
    return this.persistence.snapshotPersistedState();
  }

  restorePersistedState(snapshot) {
    this.persistence.restorePersistedState(snapshot);
  }

  updateThreadId(threadId) {
    return this.persistence.updateThreadId(threadId);
  }

  updateContextLength(contextLength) {
    return this.persistence.updateContextLength(contextLength);
  }

  clearPersistedState() {
    return this.persistence.clearPersistedState();
  }

  resetChatToBotDefaults() {
    return this.persistence.resetChatToBotDefaults();
  }

  persistBotConfig(patch) {
    return this.persistence.persistBotConfig(patch);
  }

  rollbackBotConfig(previousValues) {
    return this.persistence.rollbackBotConfig(previousValues);
  }

  persistRuntimeSettings(patch) {
    return this.persistence.persistRuntimeSettings(patch);
  }

  applyRuntimeSettings(patch) {
    return this.persistence.applyRuntimeSettings(patch);
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

    await prepareForSessionReset(this);

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

  statusText() {
    return renderStatusMessage({
      isRunning: this.isRunning,
      workdir: this.botConfig.workdir,
      auto: this.auto,
      model: this.model,
      reasoningEffort: this.reasoningEffort,
      usage: {
        contextLength: formatTokenCountK(this.contextLength)
      },
      queue: this.queue
    });
  }

  async handleStatus() {
    await this.sendText(this.statusText());
  }

  async handleAuto(args) {
    const normalized = String(args || "").trim();
    if (!normalized) {
      await this.sendText(`Current auto level: ${formatAuto(this.auto)}.`);
      return;
    }

    const nextAuto = parseAutoArgument(normalized);
    if (nextAuto === null) {
      await this.sendText("Unknown auto level. Use /auto, /auto low, /auto medium, or /auto high.");
      return;
    }

    const previousAuto = this.auto;
    try {
      await this.applyRuntimeSettings({ auto: nextAuto });
    } catch (error) {
      await this.sendText(`Failed to persist auto level: ${toErrorMessage(error)}`);
      return;
    }

    if (this.isRunning) {
      await this.sendText(
        `Auto level set to ${formatAuto(nextAuto)}. The current run stays on ${formatAuto(previousAuto)}; the next run will use ${formatAuto(nextAuto)}.`
      );
      return;
    }

    await this.sendText(`Auto level set to ${formatAuto(nextAuto)}.`);
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
    await resetSession(this);
    await this.sendText(
      wasRunning ? "Aborted current run and cleared the queue." : "No active run. Queue cleared."
    );
  }

  async handleNewSession() {
    await resetSession(this, { clearPersistedState: true });
    await this.sendText("Started a new session. The next message will open a fresh Codex thread.");
  }

  async handleReset() {
    let reloadedBotConfig;
    try {
      reloadedBotConfig = await this.configStore.loadBotConfig(this.botConfig.name);
    } catch (error) {
      await this.sendText(`Failed to reload bot config: ${toErrorMessage(error)}`);
      return;
    }

    const previousDefaults = {
      workdir: this.botConfig.workdir,
      auto: this.botConfig.auto,
      model: this.botConfig.model,
      reasoningEffort: this.botConfig.reasoningEffort
    };

    await prepareForSessionReset(this);

    this.botConfig.workdir = reloadedBotConfig.workdir;
    this.botConfig.auto = reloadedBotConfig.auto;
    this.botConfig.model = reloadedBotConfig.model;
    this.botConfig.reasoningEffort = reloadedBotConfig.reasoningEffort;

    try {
      await this.resetChatToBotDefaults();
    } catch (error) {
      this.botConfig.workdir = previousDefaults.workdir;
      this.botConfig.auto = previousDefaults.auto;
      this.botConfig.model = previousDefaults.model;
      this.botConfig.reasoningEffort = previousDefaults.reasoningEffort;
      await this.sendText(`Failed to reset chat to config defaults: ${toErrorMessage(error)}`);
      return;
    }

    await this.sendText(
      `Reset current chat to config defaults. Started a new session with workdir ${this.botConfig.workdir}, auto ${formatAuto(this.auto)}, model ${this.model}, reasoning effort ${this.reasoningEffort}.`
    );
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
    let currentThreadId = this.threadId;
    let completedTurn = false;
    const imagePaths = nextTurn.attachments
      .filter((attachment) => attachment.mode === "native-image")
      .map((attachment) => attachment.localPath);
    const message = buildTurnInputMessage(nextTurn);
    const debugArgs = buildCodexArgs({
      workdir: this.botConfig.workdir,
      threadId: this.threadId,
      message,
      imagePaths,
      autoMode: this.auto,
      model: this.model,
      reasoningEffort: this.reasoningEffort,
      developerInstructions: TELEGRAM_OUTPUT_DEVELOPER_INSTRUCTIONS
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
      autoMode: this.auto,
      model: this.model,
      reasoningEffort: this.reasoningEffort,
      developerInstructions: TELEGRAM_OUTPUT_DEVELOPER_INSTRUCTIONS,
      onEvent: async (event) => {
        const actions = eventToActions(event);
        for (const action of actions) {
          if (action.kind === "thread_started" && action.threadId) {
            currentThreadId = action.threadId;
            await this.updateThreadId(action.threadId);
            continue;
          }
          if (action.kind === "turn_completed") {
            completedTurn = true;
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
      if (completedTurn && currentThreadId) {
        const contextLength = await this.resolveContextLength(currentThreadId);
        await this.updateContextLength(contextLength);
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
