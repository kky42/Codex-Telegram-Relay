import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { BotRuntime, ChatSession } from "../src/bot-runtime.js";
import { StateStore } from "../src/state-store.js";
import { TelegramApiError } from "../src/telegram-api.js";

function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

async function waitFor(predicate, attempts = 10) {
  for (let index = 0; index < attempts; index += 1) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  assert.equal(predicate(), true);
}

class FakeBotApi {
  constructor({ failMarkdownOnce = false } = {}) {
    this.failMarkdownOnce = failMarkdownOnce;
    this.messages = [];
    this.actions = [];
  }

  async sendMessage(payload) {
    if (this.failMarkdownOnce && payload.parseMode === "MarkdownV2") {
      this.failMarkdownOnce = false;
      throw new TelegramApiError("can't parse entities", { errorCode: 400 });
    }
    this.messages.push(payload);
    return { message_id: this.messages.length };
  }

  async sendChatAction(payload) {
    this.actions.push(payload);
    return true;
  }
}

function createControlledRunnerFactory() {
  const runs = [];

  return {
    runs,
    createRun(params) {
      let resolveDone;
      const run = {
        params,
        aborted: false,
        done: new Promise((resolve) => {
          resolveDone = resolve;
        }),
        async emit(event) {
          await params.onEvent(event);
        },
        finish(result = { code: 0, signal: null, aborted: false, sawTerminalEvent: true }) {
          resolveDone(result);
        },
        abort() {
          this.aborted = true;
          resolveDone({ code: null, signal: "SIGTERM", aborted: true, sawTerminalEvent: false });
        }
      };
      runs.push(run);
      return run;
    }
  };
}

async function createSession(options = {}) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-telegram-relay-"));
  const statePath = path.join(tempDir, "state.json");
  const stateStore = new StateStore(statePath);
  await stateStore.load();

  const fakeBotApi = options.fakeBotApi ?? new FakeBotApi();
  const runnerFactory = options.runnerFactory ?? createControlledRunnerFactory();

  const session = new ChatSession({
    botConfig: {
      name: "primary",
      token: "token",
      workdir: "/tmp/project",
      allowedUsernames: ["alloweduser"],
      yolo: false
    },
    botApi: fakeBotApi,
    stateStore,
    logger: () => {},
    chatId: 1001,
    createCodexRun: (params) => runnerFactory.createRun(params),
    resolveContextLength: options.resolveContextLength ?? (async () => 21300)
  });
  session.startTyping = () => {};
  session.stopTyping = () => {};

  return { session, fakeBotApi, runnerFactory, stateStore, statePath };
}

test("session queues incoming messages and resumes with persisted thread id", async () => {
  const { session, fakeBotApi, runnerFactory, stateStore } = await createSession();

  await session.enqueueMessage("first");
  assert.equal(runnerFactory.runs.length, 1);
  assert.equal(runnerFactory.runs[0].params.threadId, null);
  assert.equal(runnerFactory.runs[0].params.yolo, false);

  await session.enqueueMessage("second");
  assert.equal(session.queue.length, 1);
  assert.equal(fakeBotApi.messages.at(-1).text, "Queued message 1\\.");

  await runnerFactory.runs[0].emit({
    type: "thread.started",
    thread_id: "thread-abc"
  });
  await runnerFactory.runs[0].emit({
    type: "item.completed",
    item: {
      id: "item_1",
      type: "agent_message",
      text: "done"
    }
  });
  await runnerFactory.runs[0].emit({
    type: "turn.completed",
    usage: {
      input_tokens: 21000,
      cached_input_tokens: 0,
      output_tokens: 300
    }
  });
  runnerFactory.runs[0].finish();

  await waitFor(() => runnerFactory.runs.length === 2);

  assert.equal(runnerFactory.runs.length, 2);
  assert.equal(runnerFactory.runs[1].params.threadId, "thread-abc");
  assert.equal(runnerFactory.runs[1].params.yolo, false);
  assert.equal(stateStore.getChatState("primary", 1001).threadId, "thread-abc");
  assert.deepEqual(stateStore.getChatState("primary", 1001).lastUsage, {
    contextLength: 21300,
    inputTokens: 21000,
    outputTokens: 300,
    cacheReadTokens: 0,
    totalTokens: 21300
  });
  assert.deepEqual(stateStore.getChatState("primary", 1001).cumulativeUsage, {
    inputTokens: 21000,
    cachedInputTokens: 0,
    outputTokens: 300
  });
  assert.equal(stateStore.getChatState("primary", 1001).yolo, null);
});

test("abort clears queue but keeps existing thread id", async () => {
  const { session, fakeBotApi, runnerFactory } = await createSession();
  session.threadId = "thread-keep";

  await session.enqueueMessage("first");
  await session.enqueueMessage("second");
  assert.equal(session.queue.length, 1);

  await session.handleAbort();

  assert.equal(runnerFactory.runs[0].aborted, true);
  assert.equal(session.queue.length, 0);
  assert.equal(session.threadId, "thread-keep");
  assert.equal(fakeBotApi.messages.at(-1).text, "Aborted current run and cleared the queue\\.");
});

test("new session clears persisted thread id and usage", async () => {
  const { session, stateStore, fakeBotApi } = await createSession();
  await session.updateThreadId("thread-old");
  await session.updateUsage({
    lastUsage: {
      contextLength: 1200,
      inputTokens: 1000,
      outputTokens: 200,
      cacheReadTokens: 0,
      totalTokens: 1200
    },
    cumulativeUsage: {
      inputTokens: 1000,
      cachedInputTokens: 0,
      outputTokens: 200
    }
  });

  await session.handleNewSession();

  assert.equal(session.threadId, null);
  assert.equal(session.lastUsage, null);
  assert.deepEqual(stateStore.getChatState("primary", 1001), {
    threadId: null,
    lastUsage: null,
    cumulativeUsage: null,
    yolo: null
  });
  assert.equal(
    fakeBotApi.messages.at(-1).text,
    "Started a new session\\. The next message will open a fresh Codex thread\\."
  );
});

test("resumed sessions without prior cumulative totals keep usage deltas unknown", async () => {
  const { session, runnerFactory, stateStore } = await createSession();
  session.threadId = "thread-existing";

  await session.enqueueMessage("resume");
  assert.equal(runnerFactory.runs.length, 1);
  assert.equal(runnerFactory.runs[0].params.threadId, "thread-existing");

  await runnerFactory.runs[0].emit({
    type: "turn.completed",
    usage: {
      input_tokens: 25000,
      cached_input_tokens: 18000,
      output_tokens: 420
    }
  });
  runnerFactory.runs[0].finish();

  await flush();
  await flush();

  assert.deepEqual(stateStore.getChatState("primary", 1001).lastUsage, {
    contextLength: 21300,
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    totalTokens: null
  });
  assert.deepEqual(stateStore.getChatState("primary", 1001).cumulativeUsage, {
    inputTokens: 25000,
    cachedInputTokens: 18000,
    outputTokens: 420
  });
  assert.equal(stateStore.getChatState("primary", 1001).yolo, null);
});

test("status shows context length and per-turn usage totals", async () => {
  const { session } = await createSession();
  session.lastUsage = {
    contextLength: 18321,
    inputTokens: 17890,
    outputTokens: 431,
    cacheReadTokens: 12000,
    totalTokens: 18321
  };

  assert.equal(
    session.statusText(),
    [
      "running: no",
      "workdir: /tmp/project",
      "yolo: off",
      "recent_context_length: 18.3k",
      "recent_usage: 18.3k",
      "queue:",
      "empty"
    ].join("\n")
  );
});

test("yolo toggles future runs and persists the override", async () => {
  const { session, runnerFactory, stateStore, fakeBotApi } = await createSession();

  await session.handleYolo("");

  assert.equal(session.yolo, true);
  assert.equal(stateStore.getChatState("primary", 1001).yolo, true);
  assert.equal(fakeBotApi.messages.at(-1).text, "Yolo set to on\\.");

  await session.enqueueMessage("hello");

  assert.equal(runnerFactory.runs[0].params.yolo, true);
});

test("yolo accepts explicit on and off values", async () => {
  const { session, fakeBotApi } = await createSession();

  await session.handleYolo("on");
  assert.equal(session.yolo, true);
  assert.equal(fakeBotApi.messages.at(-1).text, "Yolo set to on\\.");

  await session.handleYolo("off");
  assert.equal(session.yolo, false);
  assert.equal(fakeBotApi.messages.at(-1).text, "Yolo set to off\\.");
});

test("legacy usage snapshots are treated as cumulative totals during state migration", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-telegram-relay-state-"));
  const statePath = path.join(tempDir, "state.json");
  await fs.writeFile(
    statePath,
    JSON.stringify({
      bots: {
        primary: {
          chats: {
            "1001": {
              threadId: "thread-legacy",
              lastUsage: {
                inputTokens: 21000,
                cachedInputTokens: 15000,
                outputTokens: 300
              }
            }
          }
        }
      }
    }),
    "utf8"
  );

  const stateStore = new StateStore(statePath);
  await stateStore.load();

  assert.deepEqual(stateStore.getChatState("primary", 1001), {
    threadId: "thread-legacy",
    lastUsage: null,
    cumulativeUsage: {
      inputTokens: 21000,
      cachedInputTokens: 15000,
      outputTokens: 300
    },
    yolo: null
  });
});

test("sendText falls back to plain text when Telegram markdown parsing fails", async () => {
  const fakeBotApi = new FakeBotApi({ failMarkdownOnce: true });
  const { session } = await createSession({ fakeBotApi });

  await session.sendText("a_b");

  assert.deepEqual(fakeBotApi.messages, [
    {
      chatId: 1001,
      text: "a_b"
    }
  ]);
});

test("unauthorized users are told which Telegram username to allow", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-telegram-relay-"));
  const stateStore = new StateStore(path.join(tempDir, "state.json"));
  await stateStore.load();

  const fakeBotApi = new FakeBotApi();
  const runtime = new BotRuntime({
    botConfig: {
      name: "primary",
      token: "token",
      workdir: "/tmp/project",
      allowedUsernames: ["alloweduser"],
      yolo: false
    },
    botApi: fakeBotApi,
    stateStore
  });

  await runtime.handleMessage({
    chat: { id: 1001, type: "private" },
    from: { id: 42, username: "OtherUser" },
    text: "hello"
  });

  assert.equal(
    fakeBotApi.messages.at(-1).text,
    'You are not authorized to use this bot\\. Your Telegram username is @otheruser\\. Add "otheruser" to allowedUsernames in the relay config\\.'
  );
});

test("runtime routes /yolo to the session", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-telegram-relay-"));
  const stateStore = new StateStore(path.join(tempDir, "state.json"));
  await stateStore.load();

  const fakeBotApi = new FakeBotApi();
  const runtime = new BotRuntime({
    botConfig: {
      name: "primary",
      token: "token",
      workdir: "/tmp/project",
      allowedUsernames: ["alloweduser"],
      yolo: false
    },
    botApi: fakeBotApi,
    stateStore
  });

  await runtime.handleMessage({
    chat: { id: 1001, type: "private" },
    from: { id: 42, username: "AllowedUser" },
    text: "/yolo"
  });

  assert.equal(stateStore.getChatState("primary", 1001).yolo, true);
  assert.equal(fakeBotApi.messages.at(-1).text, "Yolo set to on\\.");
});
