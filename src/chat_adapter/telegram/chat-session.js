import fs from "node:fs/promises";
import path from "node:path";

import {
  ATTACHMENT_SIZE_LIMIT_BYTES,
  attachmentDescriptorFromMessage,
  attachmentLimitText,
  buildAttachmentFileName
} from "./attachments.js";
import { formatAuto, parseAutoArgument } from "../../auto-mode.js";
import { cliAdapterFor } from "../../cli_adapter/index.js";
import { buildTurnInputMessage } from "../../cli_adapter/turn-input.js";
import { ATTACHMENT_OUTPUT_DEVELOPER_INSTRUCTIONS } from "../output-instructions.js";
import { renderStatusMessage } from "./render.js";
import {
  normalizeSettingArgument
} from "../../runtime-settings.js";
import {
  DEFAULT_CACHE_PATH,
  buildChatCacheDirName,
  ensureDir,
  expandWorkdirPath,
  formatTokenCountK,
  INVALID_WORKDIR_MESSAGE,
  resolveWorkdirPath,
  toErrorMessage
} from "../../utils.js";
import { unsupportedAttachmentMessage } from "./attachments.js";
import { MessageRenderer } from "./message-renderer.js";
import { NOOP_CONFIG_STORE, SessionPersistence } from "./session-persistence.js";
import { prepareForSessionReset, resetSession } from "./session-reset.js";

function normalizeCaption(value) {
  return String(value ?? "").trim();
}

/**
 * @typedef {import("../../cli_adapter/turn-input.js").Turn} Turn
 */

export class ChatSession {
  constructor({
    botConfig,
    botApi,
    configStore = NOOP_CONFIG_STORE,
    logger,
    chatId,
    cacheRootDir = DEFAULT_CACHE_PATH,
    createAgentRun = null,
    createCodexRun = null,
    resolveContextLength = null,
    resolveHomeDir
  }) {
    this.botConfig = botConfig;
    this.cliAdapter = cliAdapterFor(botConfig.agent?.cli);
    this.botApi = botApi;
    this.configStore = configStore;
    this.logger = logger;
    this.chatId = chatId;
    this.cacheRootDir = cacheRootDir;
    this.queue = [];
    this.isRunning = false;
    this.activeRun = null;
    this.typingTimer = null;
    this.usesDefaultRunFactory = !createAgentRun && !createCodexRun;
    this.createAgentRun =
      createAgentRun ?? createCodexRun ?? ((params) => this.cliAdapter.startRun(params));
    this.usesDefaultContextLengthResolver = !resolveContextLength;
    this.resolveContextLength = resolveContextLength ?? this.cliAdapter.resolveContextLength;
    this.resolveHomeDir = resolveHomeDir;
    this.messageRenderer = new MessageRenderer({ botApi, chatId });
    this.persistence = new SessionPersistence({
      botConfig
    });
  }

  get sessionId() {
    return this.persistence.sessionId;
  }

  set sessionId(sessionId) {
    this.persistence.sessionId = sessionId;
  }

  get contextLength() {
    return this.persistence.contextLength;
  }

  set contextLength(contextLength) {
    this.persistence.contextLength = contextLength;
  }

  get workdir() {
    return this.persistence.workdir;
  }

  set workdir(workdir) {
    this.persistence.workdir = workdir;
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

  clearProgressMessage() {
    return this.messageRenderer.clearProgressMessage();
  }

  renderFinalMessage(text) {
    return this.messageRenderer.renderFinalMessage(text, {
      workdir: this.workdir
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
      workdir: this.workdir
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
    return path.join(this.cacheRootDir, "telegram", this.botConfig.username);
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

  updateSessionId(sessionId) {
    return this.persistence.updateSessionId(sessionId);
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
      await this.sendText(`Current workdir: ${this.workdir}.`);
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

    if (normalizedWorkdir === this.workdir) {
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

    await prepareForSessionReset(this);
    this.workdir = nextWorkdir;
    await this.clearPersistedState();

    await this.sendText(
      `Workdir set to ${nextWorkdir}. Started a new session. The next message will open a fresh ${this.cliAdapter.displayName} session.`
    );
  }

  statusText() {
    return renderStatusMessage({
      isRunning: this.isRunning,
      workdir: this.workdir,
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
    await this.sendText(
      `Started a new session. The next message will open a fresh ${this.cliAdapter.displayName} session.`
    );
  }

  async handleReset() {
    let reloadedBotConfig;
    try {
      reloadedBotConfig = await this.configStore.loadTelegramBotConfig({
        agentId: this.botConfig.agent.id,
        username: this.botConfig.username
      });
    } catch (error) {
      await this.sendText(`Failed to reload bot config: ${toErrorMessage(error)}`);
      return;
    }

    await prepareForSessionReset(this);
    this.botConfig.allowedUsernames = reloadedBotConfig.allowedUsernames;
    this.botConfig.agent = reloadedBotConfig.agent;
    this.cliAdapter = cliAdapterFor(this.botConfig.agent?.cli);
    if (this.usesDefaultRunFactory) {
      this.createAgentRun = (params) => this.cliAdapter.startRun(params);
    }
    if (this.usesDefaultContextLengthResolver) {
      this.resolveContextLength = this.cliAdapter.resolveContextLength;
    }
    await this.resetChatToBotDefaults();

    await this.sendText(
      `Reset current chat to config defaults. Started a new session with workdir ${this.workdir}, auto ${formatAuto(this.auto)}, model ${this.model}, reasoning effort ${this.reasoningEffort}.`
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
    let currentSessionId = this.sessionId;
    let completedTurn = false;
    const message = buildTurnInputMessage(nextTurn);
    const buildArgParams = {
      sessionId: this.sessionId,
      message,
      autoMode: this.auto,
      model: this.model,
      reasoningEffort: this.reasoningEffort,
      developerInstructions: ATTACHMENT_OUTPUT_DEVELOPER_INSTRUCTIONS
    };
    const runParams = {
      workdir: this.workdir,
      ...buildArgParams
    };
    const debugArgs = this.cliAdapter.buildArgs(buildArgParams);
    const redactedArgs = debugArgs.slice();
    if (redactedArgs.length > 0) {
      redactedArgs[redactedArgs.length - 1] = `<prompt:${message.length}>`;
    }
    this.logger(
      `starting ${this.cliAdapter.id} run ${JSON.stringify({
        sessionId: this.sessionId,
        attachments: nextTurn.attachments.map((attachment) => ({
          kind: attachment.kind,
          localPath: attachment.localPath
        })),
        args: redactedArgs
      })}`
    );

    const run = this.createAgentRun({
      ...runParams,
      onEvent: async (event) => {
        const actions = this.cliAdapter.eventToActions(event);
        for (const action of actions) {
          if (action.kind === "session_started" && action.sessionId) {
            currentSessionId = action.sessionId;
            await this.updateSessionId(action.sessionId);
            continue;
          }
          if (action.kind === "turn_completed") {
            completedTurn = true;
            continue;
          }
          if (action.kind === "context_length") {
            await this.updateContextLength(action.contextLength);
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
          this.logger(`${this.cliAdapter.id} stderr: ${message}`);
        }
      }
    });

    this.activeRun = run;

    try {
      const result = await run.done;
      if (result.aborted) {
        return;
      }
      if (completedTurn && currentSessionId) {
        const contextLength = await this.resolveContextLength(currentSessionId);
        if (contextLength !== null && contextLength !== undefined) {
          await this.updateContextLength(contextLength);
        }
      }
      if (completedTurn) {
        await this.clearProgressMessage();
      }
      if (!result.sawTerminalEvent && !emittedError) {
        await this.renderErrorText(`${this.cliAdapter.displayName} exited without a terminal JSON event.`);
      }
    } catch (error) {
      await this.renderErrorText(`${this.cliAdapter.displayName} process error: ${toErrorMessage(error)}`);
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
