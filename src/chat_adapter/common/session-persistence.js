import { AUTO_DEFAULT } from "../../auto-mode.js";
import {
  DEFAULT_MODEL,
  DEFAULT_REASONING_EFFORT
} from "../../runtime-settings.js";

export const NOOP_CONFIG_STORE = {
  async loadChatBindingConfig() {
    throw new Error("Config reload is unavailable.");
  }
};

function applyObjectPatch(target, patch) {
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) {
      delete target[key];
    } else {
      target[key] = value;
    }
  }
}

function runtimeStateFromAgent(agent) {
  return {
    sessionId: null,
    contextLength: null,
    cli: agent?.cli,
    workdir: agent?.workdir,
    auto: agent?.auto ?? AUTO_DEFAULT,
    model: agent?.model ?? DEFAULT_MODEL,
    reasoningEffort: agent?.reasoningEffort ?? DEFAULT_REASONING_EFFORT
  };
}

export class SessionPersistence {
  constructor({ bindingConfig, botConfig = null }) {
    this.bindingConfig = bindingConfig ?? botConfig;
    this.state = runtimeStateFromAgent(this.bindingConfig?.agent);
  }

  get sessionId() {
    return this.state.sessionId;
  }

  set sessionId(sessionId) {
    this.state.sessionId = sessionId;
  }

  get contextLength() {
    return this.state.contextLength;
  }

  set contextLength(contextLength) {
    this.state.contextLength = contextLength;
  }

  get cli() {
    return this.state.cli;
  }

  set cli(cli) {
    this.state.cli = cli;
  }

  get workdir() {
    return this.state.workdir;
  }

  set workdir(workdir) {
    this.state.workdir = workdir;
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

  async updateSessionId(sessionId) {
    this.sessionId = sessionId;
  }

  async updateContextLength(contextLength) {
    this.contextLength = contextLength;
  }

  async clearPersistedState() {
    this.sessionId = null;
    this.contextLength = null;
  }

  async resetChatToBindingDefaults() {
    this.state = runtimeStateFromAgent(this.bindingConfig?.agent);
  }

  async resetChatToBotDefaults() {
    await this.resetChatToBindingDefaults();
  }

  async applyRuntimeSettings(patch) {
    applyObjectPatch(this.state, patch);
  }
}
