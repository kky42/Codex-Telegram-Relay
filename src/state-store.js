import { readJsonFile, writeJsonFileAtomic } from "./utils.js";

function defaultState() {
  return { bots: {} };
}

function normalizeUsage(usage) {
  if (!usage || typeof usage !== "object") {
    return null;
  }

  const inputTokens = Number(usage.inputTokens ?? usage.input_tokens ?? 0);
  const cachedInputTokens = Number(usage.cachedInputTokens ?? usage.cached_input_tokens ?? 0);
  const outputTokens = Number(usage.outputTokens ?? usage.output_tokens ?? 0);

  if (![inputTokens, cachedInputTokens, outputTokens].every(Number.isFinite)) {
    return null;
  }

  return { inputTokens, cachedInputTokens, outputTokens };
}

export class StateStore {
  constructor(statePath) {
    this.statePath = statePath;
    this.state = defaultState();
    this.writeChain = Promise.resolve();
  }

  async load() {
    const state = await readJsonFile(this.statePath, defaultState());
    if (!state || typeof state !== "object" || Array.isArray(state)) {
      this.state = defaultState();
      return;
    }
    this.state = state;
  }

  getChatState(botName, chatId) {
    const botState = this.state.bots?.[botName];
    const chatState = botState?.chats?.[String(chatId)] ?? {};
    return {
      threadId: typeof chatState.threadId === "string" && chatState.threadId ? chatState.threadId : null,
      lastUsage: normalizeUsage(chatState.lastUsage)
    };
  }

  async patchChatState(botName, chatId, patch) {
    this.writeChain = this.writeChain.then(async () => {
      const chatKey = String(chatId);
      this.state.bots ??= {};
      this.state.bots[botName] ??= { chats: {} };
      this.state.bots[botName].chats ??= {};
      const previous = this.state.bots[botName].chats[chatKey] ?? {};

      const next = {
        ...previous,
        ...patch
      };

      if (!next.threadId) {
        delete next.threadId;
      }

      if (!next.lastUsage) {
        delete next.lastUsage;
      }

      if (Object.keys(next).length === 0) {
        delete this.state.bots[botName].chats[chatKey];
      } else {
        this.state.bots[botName].chats[chatKey] = next;
      }

      if (Object.keys(this.state.bots[botName].chats).length === 0) {
        delete this.state.bots[botName];
      }

      await writeJsonFileAtomic(this.statePath, this.state);
    });

    await this.writeChain;
  }

  async clearChatState(botName, chatId) {
    await this.patchChatState(botName, chatId, { threadId: null, lastUsage: null });
  }
}
