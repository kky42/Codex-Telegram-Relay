import {
  readPersistedModel,
  readPersistedReasoningEffort
} from "./runtime-settings.js";
import { readPersistedYolo } from "./yolo.js";
import { readJsonFile, writeJsonFileAtomic } from "./utils.js";

function normalizeContextLength(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function defaultState() {
  return { bots: {} };
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
      contextLength: normalizeContextLength(chatState.contextLength),
      yolo: readPersistedYolo(chatState),
      model: readPersistedModel(chatState),
      reasoningEffort: readPersistedReasoningEffort(chatState)
    };
  }

  async patchChatState(botName, chatId, patch) {
    const task = this.writeChain.then(async () => {
      const chatKey = String(chatId);
      const nextState = structuredClone(this.state);
      nextState.bots ??= {};
      nextState.bots[botName] ??= { chats: {} };
      nextState.bots[botName].chats ??= {};
      const previous = nextState.bots[botName].chats[chatKey] ?? {};

      const next = {
        ...previous,
        ...patch
      };

      if (!next.threadId) {
        delete next.threadId;
      }

      if (!Number.isFinite(next.contextLength)) {
        delete next.contextLength;
      }

      if (typeof next.yolo !== "boolean") {
        delete next.yolo;
      }

      if (typeof next.model !== "string") {
        delete next.model;
      }

      if (typeof next.reasoningEffort !== "string") {
        delete next.reasoningEffort;
      }

      if (Object.keys(next).length === 0) {
        delete nextState.bots[botName].chats[chatKey];
      } else {
        nextState.bots[botName].chats[chatKey] = next;
      }

      if (Object.keys(nextState.bots[botName].chats).length === 0) {
        delete nextState.bots[botName];
      }

      await writeJsonFileAtomic(this.statePath, nextState);
      this.state = nextState;
    });

    this.writeChain = task.catch(() => {});
    await task;
  }

  async clearChatState(botName, chatId) {
    await this.patchChatState(botName, chatId, { threadId: null, contextLength: null });
  }
}
