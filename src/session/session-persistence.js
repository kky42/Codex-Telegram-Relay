import {
  DEFAULT_MODEL,
  DEFAULT_REASONING_EFFORT
} from "../runtime-settings.js";
import { AUTO_DEFAULT } from "../auto-mode.js";
import { toErrorMessage } from "../utils.js";

export const NOOP_CONFIG_STORE = {
  async patchBotConfig() {}
};

/**
 * @typedef {object} ChatStatePatch
 * @property {string | null | undefined} [threadId]
 * @property {number | null | undefined} [contextLength]
 * @property {string | undefined} [auto]
 * @property {string | undefined} [model]
 * @property {string | undefined} [reasoningEffort]
 */

function applyObjectPatch(target, patch) {
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) {
      delete target[key];
    } else {
      target[key] = value;
    }
  }
}

export class SessionPersistence {
  constructor({
    botConfig,
    stateStore,
    configStore,
    chatId,
    logger = () => {}
  }) {
    this.botConfig = botConfig;
    this.stateStore = stateStore;
    this.configStore = configStore ?? NOOP_CONFIG_STORE;
    this.chatId = chatId;
    this.logger = logger;

    const persisted = stateStore.getChatState(botConfig.name, chatId);
    this.state = {
      threadId: persisted.threadId,
      contextLength: persisted.contextLength,
      auto: persisted.auto ?? botConfig.auto ?? AUTO_DEFAULT,
      model: persisted.model ?? botConfig.model ?? DEFAULT_MODEL,
      reasoningEffort:
        persisted.reasoningEffort ?? botConfig.reasoningEffort ?? DEFAULT_REASONING_EFFORT
    };
  }

  get threadId() {
    return this.state.threadId;
  }

  set threadId(threadId) {
    this.state.threadId = threadId;
  }

  get contextLength() {
    return this.state.contextLength;
  }

  set contextLength(contextLength) {
    this.state.contextLength = contextLength;
  }

  get auto() {
    return this.state.auto;
  }

  set auto(auto) {
    this.state.auto = auto;
  }

  get model() {
    return this.state.model;
  }

  set model(model) {
    this.state.model = model;
  }

  get reasoningEffort() {
    return this.state.reasoningEffort;
  }

  set reasoningEffort(reasoningEffort) {
    this.state.reasoningEffort = reasoningEffort;
  }

  snapshotPersistedState() {
    return {
      threadId: this.threadId,
      contextLength: this.contextLength
    };
  }

  restorePersistedState(snapshot) {
    this.threadId = snapshot.threadId;
    this.contextLength = snapshot.contextLength;
  }

  async updateThreadId(threadId) {
    const previousState = this.snapshotPersistedState();

    try {
      await this.stateStore.patchChatState(this.botConfig.name, this.chatId, {
        threadId,
        contextLength: this.contextLength
      });
    } catch (error) {
      this.restorePersistedState(previousState);
      throw error;
    }

    this.threadId = threadId;
  }

  async updateContextLength(contextLength) {
    const previousState = this.snapshotPersistedState();

    try {
      await this.stateStore.patchChatState(this.botConfig.name, this.chatId, {
        threadId: this.threadId,
        contextLength
      });
    } catch (error) {
      this.restorePersistedState(previousState);
      throw error;
    }

    this.contextLength = contextLength;
  }

  async clearPersistedState() {
    const previousState = this.snapshotPersistedState();

    try {
      await this.stateStore.patchChatState(this.botConfig.name, this.chatId, {
        threadId: null,
        contextLength: null
      });
    } catch (error) {
      this.restorePersistedState(previousState);
      throw error;
    }

    this.threadId = null;
    this.contextLength = null;
  }

  async persistBotConfig(patch) {
    const previousValues = {};
    for (const [key] of Object.entries(patch)) {
      previousValues[key] = this.botConfig[key];
    }

    await this.configStore.patchBotConfig(this.botConfig.name, patch);
    applyObjectPatch(this.botConfig, patch);

    return previousValues;
  }

  async rollbackBotConfig(previousValues) {
    try {
      await this.configStore.patchBotConfig(this.botConfig.name, previousValues);
    } catch (error) {
      this.logger(`config rollback failed: ${toErrorMessage(error)}`);
      throw error;
    }

    applyObjectPatch(this.botConfig, previousValues);
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
    if (Object.hasOwn(patch, "auto")) {
      this.auto = patch.auto;
    }
    if (Object.hasOwn(patch, "model")) {
      this.model = patch.model;
    }
    if (Object.hasOwn(patch, "reasoningEffort")) {
      this.reasoningEffort = patch.reasoningEffort;
    }
  }
}
