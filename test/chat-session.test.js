import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { BotRuntime, ChatSession } from "../src/bot-runtime.js";
import { StateStore } from "../src/state-store.js";
import { TelegramApiError } from "../src/telegram-api.js";
import { buildChatCacheDirName } from "../src/utils.js";

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
  constructor({ failMarkdownOnce = false, failMarkdownEditOnce = false } = {}) {
    this.failMarkdownOnce = failMarkdownOnce;
    this.failMarkdownEditOnce = failMarkdownEditOnce;
    this.messages = [];
    this.edits = [];
    this.actions = [];
    this.filesById = new Map();
    this.filesByPath = new Map();
    this.getFileCalls = [];
    this.downloadCalls = [];
  }

  async sendMessage(payload) {
    if (this.failMarkdownOnce && payload.parseMode === "MarkdownV2") {
      this.failMarkdownOnce = false;
      throw new TelegramApiError("can't parse entities", { errorCode: 400 });
    }
    this.messages.push(payload);
    return { message_id: this.messages.length };
  }

  async editMessageText(payload) {
    if (this.failMarkdownEditOnce && payload.parseMode === "MarkdownV2") {
      this.failMarkdownEditOnce = false;
      throw new TelegramApiError("can't parse entities", { errorCode: 400 });
    }
    this.edits.push(payload);
    return { message_id: payload.messageId };
  }

  async sendChatAction(payload) {
    this.actions.push(payload);
    return true;
  }

  registerFile(
    fileId,
    {
      filePath = `${fileId}.bin`,
      body = Buffer.from(`file:${fileId}`),
      fileSize = body.length
    } = {}
  ) {
    this.filesById.set(fileId, {
      file_id: fileId,
      file_path: filePath,
      file_size: fileSize
    });
    this.filesByPath.set(filePath, Buffer.from(body));
  }

  async getFile(fileId) {
    this.getFileCalls.push(fileId);
    const file = this.filesById.get(fileId);
    if (!file) {
      throw new Error(`Unknown Telegram file: ${fileId}`);
    }
    return { ...file };
  }

  async downloadFile(filePath, options = {}) {
    this.downloadCalls.push({ filePath, options });
    const body = this.filesByPath.get(filePath);
    if (!body) {
      throw new Error(`Unknown Telegram file path: ${filePath}`);
    }
    if (Number.isFinite(options.maxBytes) && body.length > options.maxBytes) {
      throw new Error("download exceeds limit");
    }
    return Buffer.from(body);
  }
}

class FakeConfigStore {
  constructor() {
    this.patches = [];
    this.failure = null;
  }

  async patchBotConfig(botName, patch) {
    if (this.failure) {
      throw this.failure;
    }
    this.patches.push({ botName, patch });
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
  const cacheRootDir = path.join(tempDir, "cache");
  const stateStore = new StateStore(statePath);
  await stateStore.load();

  const fakeBotApi = options.fakeBotApi ?? new FakeBotApi();
  const runnerFactory = options.runnerFactory ?? createControlledRunnerFactory();
  const configStore = options.configStore ?? new FakeConfigStore();
  const botConfig = {
    name: "primary",
    token: "token",
    workdir: "/tmp/project",
    allowedUsernames: ["alloweduser"],
    yolo: true,
    model: "default",
    reasoningEffort: "default",
    ...options.botConfig
  };

  const session = new ChatSession({
    botConfig,
    botApi: fakeBotApi,
    stateStore,
    configStore,
    logger: () => {},
    chatId: 1001,
    cacheRootDir,
    createCodexRun: (params) => runnerFactory.createRun(params),
    resolveContextLength: options.resolveContextLength ?? (async () => 21300),
    resolveHomeDir: options.resolveHomeDir
  });
  session.startTyping = () => {};
  session.stopTyping = () => {};

  return { session, fakeBotApi, runnerFactory, stateStore, statePath, configStore, cacheRootDir };
}

async function createRuntime(options = {}) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-telegram-relay-runtime-"));
  const stateStore = new StateStore(path.join(tempDir, "state.json"));
  await stateStore.load();

  const fakeBotApi = options.fakeBotApi ?? new FakeBotApi();
  const runtime = new BotRuntime({
    botConfig: {
      name: "primary",
      token: "token",
      workdir: "/tmp/project",
      allowedUsernames: ["alloweduser"],
      yolo: true,
      model: "default",
      reasoningEffort: "default",
      ...options.botConfig
    },
    botApi: fakeBotApi,
    stateStore,
    configStore: options.configStore,
    createCodexRun: options.createCodexRun,
    cacheRootDir: path.join(tempDir, "cache"),
    albumQuietPeriodMs: options.albumQuietPeriodMs
  });

  return { runtime, fakeBotApi, stateStore, tempDir, cacheRootDir: path.join(tempDir, "cache") };
}

test("session queues incoming messages and resumes with persisted thread id", async () => {
  const { session, fakeBotApi, runnerFactory, stateStore } = await createSession();

  await session.enqueueMessage("first");
  assert.equal(runnerFactory.runs.length, 1);
  assert.equal(runnerFactory.runs[0].params.threadId, null);
  assert.equal(runnerFactory.runs[0].params.yolo, true);
  assert.equal(runnerFactory.runs[0].params.model, "default");
  assert.equal(runnerFactory.runs[0].params.reasoningEffort, "default");

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
  assert.equal(runnerFactory.runs[1].params.yolo, true);
  assert.equal(stateStore.getChatState("primary", 1001).threadId, "thread-abc");
  assert.deepEqual(stateStore.getChatState("primary", 1001).lastUsage, {
    contextLength: 21300,
    inputTokens: 21000,
    outputTokens: 300,
    cacheReadTokens: 0
  });
  assert.deepEqual(stateStore.getChatState("primary", 1001).cumulativeUsage, {
    inputTokens: 21000,
    cachedInputTokens: 0,
    outputTokens: 300
  });
  assert.equal(stateStore.getChatState("primary", 1001).yolo, null);
});

test("session stages photo attachments and passes image paths to Codex", async () => {
  const { session, fakeBotApi, runnerFactory, cacheRootDir } = await createSession();
  fakeBotApi.registerFile("photo-1", {
    filePath: "photos/input.jpg",
    body: Buffer.from("jpg")
  });

  await session.handleAttachmentMessages([
    {
      message_id: 11,
      photo: [
        { file_id: "photo-small", file_unique_id: "small", file_size: 1, width: 10, height: 10 },
        { file_id: "photo-1", file_unique_id: "large", file_size: 3, width: 100, height: 100 }
      ]
    }
  ]);

  assert.equal(runnerFactory.runs.length, 1);
  assert.equal(runnerFactory.runs[0].params.message, "");
  assert.deepEqual(fakeBotApi.getFileCalls, ["photo-1"]);
  assert.equal(runnerFactory.runs[0].params.imagePaths.length, 1);
  assert.match(
    runnerFactory.runs[0].params.imagePaths[0],
    new RegExp(`${cacheRootDir}/primary/${buildChatCacheDirName(1001)}/`)
  );
  assert.equal(path.basename(runnerFactory.runs[0].params.imagePaths[0]), "msg11.jpg");
  assert.equal(await fs.readFile(runnerFactory.runs[0].params.imagePaths[0], "utf8"), "jpg");
});

test("session builds attachment prompts for path-based files", async () => {
  const { session, fakeBotApi, runnerFactory } = await createSession();
  fakeBotApi.registerFile("doc-1", {
    filePath: "documents/spec.pdf",
    body: Buffer.from("pdf-bytes")
  });

  await session.handleAttachmentMessages([
    {
      message_id: 21,
      caption: "review this",
      document: {
        file_id: "doc-1",
        file_unique_id: "doc-unique-1",
        file_name: "spec.pdf",
        mime_type: "application/pdf",
        file_size: 9
      }
    }
  ]);

  assert.equal(runnerFactory.runs.length, 1);
  assert.deepEqual(runnerFactory.runs[0].params.imagePaths, []);
  assert.match(runnerFactory.runs[0].params.message, /review this/);
  assert.match(runnerFactory.runs[0].params.message, /<attachments>/);
  assert.match(runnerFactory.runs[0].params.message, /msg21\.pdf/);
  assert.match(runnerFactory.runs[0].params.message, /kind=document path=/);
});

test("session rejects oversized attachments before starting Codex", async () => {
  const { session, fakeBotApi, runnerFactory } = await createSession();
  fakeBotApi.registerFile("video-1", {
    filePath: "videos/demo.mp4",
    body: Buffer.from("small")
  });

  await session.handleAttachmentMessages([
    {
      message_id: 31,
      video: {
        file_id: "video-1",
        file_unique_id: "video-unique-1",
        file_name: "demo.mp4",
        file_size: 21 * 1024 * 1024
      }
    }
  ]);

  assert.equal(runnerFactory.runs.length, 0);
  assert.match(fakeBotApi.messages.at(-1).text, /20 MB limit/);
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
      cacheReadTokens: 0
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
    yolo: null,
    model: null,
    reasoningEffort: null
  });
  assert.equal(
    fakeBotApi.messages.at(-1).text,
    "Started a new session\\. The next message will open a fresh Codex thread\\."
  );
});

test("/workdir without args returns the current workdir", async () => {
  const { session, fakeBotApi } = await createSession();

  await session.handleWorkdir("");

  assert.equal(fakeBotApi.messages.at(-1).text, "Current workdir: /tmp/project\\.");
});

test("/workdir expands ~/ paths and persists the new workdir", async () => {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-telegram-relay-home-"));
  const desktopDir = path.join(homeDir, "Desktop");
  await fs.mkdir(desktopDir);
  const { session, configStore, fakeBotApi } = await createSession({
    resolveHomeDir: () => homeDir
  });

  await session.handleWorkdir("~/Desktop");

  assert.equal(session.botConfig.workdir, desktopDir);
  assert.equal(configStore.patches.at(-1).patch.workdir, desktopDir);
  assert.match(fakeBotApi.messages.at(-1).text, /Started a new session/);
});

test("/workdir rejects nonexistent paths", async () => {
  const { session, fakeBotApi } = await createSession();

  await session.handleWorkdir("/definitely/not/a/real/path");

  assert.match(fakeBotApi.messages.at(-1).text, /Invalid workdir/);
  assert.match(fakeBotApi.messages.at(-1).text, /absolute path/);
  assert.match(fakeBotApi.messages.at(-1).text, /existing directory/);
});

test("/workdir rejects file paths", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-telegram-relay-"));
  const filePath = path.join(tempDir, "config.json");
  await fs.writeFile(filePath, "{}", "utf8");
  const { session, fakeBotApi } = await createSession();

  await session.handleWorkdir(filePath);

  assert.match(fakeBotApi.messages.at(-1).text, /Invalid workdir/);
  assert.match(fakeBotApi.messages.at(-1).text, /existing directory/);
});

test("/workdir rejects plain relative paths", async () => {
  const { session, fakeBotApi } = await createSession();

  await session.handleWorkdir("subdir");
  assert.match(fakeBotApi.messages.at(-1).text, /Invalid workdir/);

  await session.handleWorkdir("../repo");
  assert.match(fakeBotApi.messages.at(-1).text, /Invalid workdir/);
});

test("/workdir is a no-op when the normalized path matches the current workdir", async () => {
  const { session, stateStore, fakeBotApi, configStore } = await createSession();
  await session.updateThreadId("thread-old");

  await session.handleWorkdir("/tmp/project");

  assert.equal(session.threadId, "thread-old");
  assert.equal(stateStore.getChatState("primary", 1001).threadId, "thread-old");
  assert.equal(configStore.patches.length, 0);
  assert.equal(fakeBotApi.messages.at(-1).text, "Workdir is already set to /tmp/project\\.");
});

test("/workdir updates config, clears persisted session state, and affects the next run while idle", async () => {
  const nextWorkdir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-telegram-relay-workdir-"));
  const { session, stateStore, fakeBotApi, runnerFactory, configStore } = await createSession();
  await session.updateThreadId("thread-old");
  await session.updateUsage({
    lastUsage: {
      contextLength: 1200,
      inputTokens: 1000,
      outputTokens: 200,
      cacheReadTokens: 0
    },
    cumulativeUsage: {
      inputTokens: 1000,
      cachedInputTokens: 0,
      outputTokens: 200
    }
  });

  await session.handleWorkdir(nextWorkdir);

  assert.equal(session.botConfig.workdir, nextWorkdir);
  assert.equal(session.threadId, null);
  assert.equal(session.lastUsage, null);
  assert.equal(configStore.patches.at(-1).patch.workdir, nextWorkdir);
  assert.deepEqual(stateStore.getChatState("primary", 1001), {
    threadId: null,
    lastUsage: null,
    cumulativeUsage: null,
    yolo: null,
    model: null,
    reasoningEffort: null
  });
  assert.match(fakeBotApi.messages.at(-1).text, /Started a new session/);

  await session.enqueueMessage("hello");
  assert.equal(runnerFactory.runs.at(-1).params.workdir, nextWorkdir);
  assert.equal(runnerFactory.runs.at(-1).params.threadId, null);
});

test("/workdir aborts the active run, clears the queue, and uses the new workdir on the next run", async () => {
  const nextWorkdir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-telegram-relay-workdir-"));
  const { session, runnerFactory, stateStore } = await createSession();
  await session.updateThreadId("thread-old");

  await session.enqueueMessage("first");
  await session.enqueueMessage("second");
  assert.equal(session.queue.length, 1);

  await session.handleWorkdir(nextWorkdir);

  assert.equal(runnerFactory.runs[0].aborted, true);
  assert.equal(session.queue.length, 0);
  assert.equal(session.threadId, null);
  assert.equal(stateStore.getChatState("primary", 1001).threadId, null);
  assert.equal(session.botConfig.workdir, nextWorkdir);

  await session.enqueueMessage("after switch");
  assert.equal(runnerFactory.runs.at(-1).params.workdir, nextWorkdir);
  assert.equal(runnerFactory.runs.at(-1).params.threadId, null);
});

test("/workdir leaves workdir and thread state unchanged when config persistence fails", async () => {
  const nextWorkdir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-telegram-relay-workdir-"));
  const configStore = new FakeConfigStore();
  configStore.failure = new Error("disk full");
  const { session, stateStore, fakeBotApi } = await createSession({ configStore });
  await session.updateThreadId("thread-old");
  await session.updateUsage({
    lastUsage: {
      contextLength: 1200,
      inputTokens: 1000,
      outputTokens: 200,
      cacheReadTokens: 0
    },
    cumulativeUsage: {
      inputTokens: 1000,
      cachedInputTokens: 0,
      outputTokens: 200
    }
  });

  await session.handleWorkdir(nextWorkdir);

  assert.equal(session.botConfig.workdir, "/tmp/project");
  assert.equal(session.threadId, "thread-old");
  assert.deepEqual(stateStore.getChatState("primary", 1001).lastUsage, {
    contextLength: 1200,
    inputTokens: 1000,
    outputTokens: 200,
    cacheReadTokens: 0
  });
  assert.equal(fakeBotApi.messages.at(-1).text, "Failed to persist workdir setting: disk full");
});

test("/workdir rolls back config and in-memory workdir if clearing the session state fails", async () => {
  const nextWorkdir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-telegram-relay-workdir-"));
  const { session, stateStore, configStore, fakeBotApi } = await createSession();
  await session.updateThreadId("thread-old");
  await session.updateUsage({
    lastUsage: {
      contextLength: 1200,
      inputTokens: 1000,
      outputTokens: 200,
      cacheReadTokens: 0
    },
    cumulativeUsage: {
      inputTokens: 1000,
      cachedInputTokens: 0,
      outputTokens: 200
    }
  });

  const originalPatchChatState = stateStore.patchChatState.bind(stateStore);
  stateStore.patchChatState = async (botName, chatId, patch) => {
    if (patch.threadId === null && patch.lastUsage === null && patch.cumulativeUsage === null) {
      throw new Error("state write failed");
    }
    return originalPatchChatState(botName, chatId, patch);
  };

  await session.handleWorkdir(nextWorkdir);

  assert.equal(session.botConfig.workdir, "/tmp/project");
  assert.equal(session.threadId, "thread-old");
  assert.deepEqual(configStore.patches.map((entry) => entry.patch), [
    { workdir: nextWorkdir },
    { workdir: "/tmp/project" }
  ]);
  assert.deepEqual(stateStore.getChatState("primary", 1001).lastUsage, {
    contextLength: 1200,
    inputTokens: 1000,
    outputTokens: 200,
    cacheReadTokens: 0
  });
  assert.equal(
    fakeBotApi.messages.at(-1).text,
    "Failed to reset session after changing workdir: state write failed"
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

  await waitFor(() => stateStore.getChatState("primary", 1001).lastUsage !== null);

  assert.deepEqual(stateStore.getChatState("primary", 1001).lastUsage, {
    contextLength: 21300,
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null
  });
  assert.deepEqual(stateStore.getChatState("primary", 1001).cumulativeUsage, {
    inputTokens: 25000,
    cachedInputTokens: 18000,
    outputTokens: 420
  });
  assert.equal(stateStore.getChatState("primary", 1001).yolo, null);
  assert.equal(stateStore.getChatState("primary", 1001).model, null);
  assert.equal(stateStore.getChatState("primary", 1001).reasoningEffort, null);
});

test("status shows the latest context length", async () => {
  const { session } = await createSession();
  session.lastUsage = {
    contextLength: 18321,
    inputTokens: 17890,
    outputTokens: 431,
    cacheReadTokens: 12000
  };

  assert.equal(
    session.statusText(),
    [
      "running: no",
      "workdir: /tmp/project",
      "yolo: on",
      "model: default",
      "reasoning_effort: default",
      "context_length: 18.3k",
      "queue:",
      "empty"
    ].join("\n")
  );
});

test("status summarizes queued attachment turns", async () => {
  const { session } = await createSession();
  session.queue = [
    {
      promptText: "Review the attached PDF",
      attachments: [{ kind: "document", mode: "path-reference", localPath: "/tmp/spec.pdf" }]
    }
  ];

  assert.equal(
    session.statusText(),
    [
      "running: no",
      "workdir: /tmp/project",
      "yolo: on",
      "model: default",
      "reasoning_effort: default",
      "context_length: n/a",
      "queue:",
      "1. [1 attachment] Review the attached PDF"
    ].join("\n")
  );
});

test("yolo toggles future runs and persists the override", async () => {
  const { session, runnerFactory, stateStore, fakeBotApi, configStore } = await createSession();

  await session.handleYolo("");

  assert.equal(session.yolo, false);
  assert.equal(stateStore.getChatState("primary", 1001).yolo, false);
  assert.equal(configStore.patches.at(-1).patch.yolo, false);
  assert.equal(fakeBotApi.messages.at(-1).text, "Yolo set to off\\.");

  await session.enqueueMessage("hello");

  assert.equal(runnerFactory.runs[0].params.yolo, false);
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

test("/model without args returns the current model", async () => {
  const { session, fakeBotApi } = await createSession();

  await session.handleModel("");

  assert.equal(fakeBotApi.messages.at(-1).text, "Current model: default\\.");
});

test("/model with a value persists to state/config and affects next run", async () => {
  const { session, fakeBotApi, runnerFactory, stateStore, configStore } = await createSession();

  await session.handleModel("gpt-5.4");

  assert.equal(session.model, "gpt-5.4");
  assert.equal(stateStore.getChatState("primary", 1001).model, "gpt-5.4");
  assert.equal(configStore.patches.at(-1).patch.model, "gpt-5.4");
  assert.equal(fakeBotApi.messages.at(-1).text, "Model set to gpt\\-5\\.4\\.");

  await session.enqueueMessage("hello");
  assert.equal(runnerFactory.runs[0].params.model, "gpt-5.4");
});

test("/reasoning without args returns the current value", async () => {
  const { session, fakeBotApi } = await createSession();

  await session.handleReasoningEffort("");

  assert.equal(fakeBotApi.messages.at(-1).text, "Current reasoning effort: default\\.");
});

test("/reasoning with a value persists to state/config and affects next run", async () => {
  const { session, fakeBotApi, runnerFactory, stateStore, configStore } = await createSession();

  await session.handleReasoningEffort("high");

  assert.equal(session.reasoningEffort, "high");
  assert.equal(stateStore.getChatState("primary", 1001).reasoningEffort, "high");
  assert.equal(configStore.patches.at(-1).patch.reasoningEffort, "high");
  assert.equal(fakeBotApi.messages.at(-1).text, "Reasoning effort set to high\\.");

  await session.enqueueMessage("hello");
  assert.equal(runnerFactory.runs[0].params.reasoningEffort, "high");
});

test("runtime settings changes fail entirely when config persistence fails", async () => {
  const configStore = new FakeConfigStore();
  configStore.failure = new Error("disk full");
  const { session, fakeBotApi, stateStore } = await createSession({ configStore });

  await session.handleModel("gpt-5.4");

  assert.equal(session.model, "default");
  assert.equal(stateStore.getChatState("primary", 1001).model, null);
  assert.equal(fakeBotApi.messages.at(-1).text, "Failed to persist model setting: disk full");
});

test("state store reads only the current usage schema", async () => {
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
                contextLength: 21300,
                inputTokens: 21000,
                outputTokens: 300,
                cacheReadTokens: 15000
              },
              cumulativeUsage: {
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
    lastUsage: {
      contextLength: 21300,
      inputTokens: 21000,
      outputTokens: 300,
      cacheReadTokens: 15000
    },
    cumulativeUsage: {
      inputTokens: 21000,
      cachedInputTokens: 15000,
      outputTokens: 300
    },
    yolo: null,
    model: null,
    reasoningEffort: null
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

test("progress items reuse one Telegram message and final agent_message replaces it", async () => {
  const { session, fakeBotApi, runnerFactory } = await createSession();

  await session.enqueueMessage("first");
  const run = runnerFactory.runs[0];

  await run.emit({
    type: "item.started",
    item: {
      id: "item_1",
      type: "reasoning",
      status: "in_progress"
    }
  });
  await run.emit({
    type: "item.started",
    item: {
      id: "item_2",
      type: "command_execution",
      status: "in_progress"
    }
  });
  await run.emit({
    type: "item.completed",
    item: {
      id: "item_2",
      type: "command_execution",
      status: "completed"
    }
  });
  await run.emit({
    type: "item.completed",
    item: {
      id: "item_3",
      type: "agent_message",
      text: "done"
    }
  });
  run.finish();

  await flush();
  await flush();

  assert.deepEqual(fakeBotApi.messages, [
    {
      chatId: 1001,
      text: "🟢 reasoning",
      parseMode: "MarkdownV2"
    }
  ]);
  assert.deepEqual(fakeBotApi.edits, [
    {
      chatId: 1001,
      messageId: 1,
      text: "🟢 command\\_execution",
      parseMode: "MarkdownV2"
    },
    {
      chatId: 1001,
      messageId: 1,
      text: "done",
      parseMode: "MarkdownV2"
    }
  ]);
});

test("subsequent agent messages in the same turn are sent as new Telegram messages", async () => {
  const { session, fakeBotApi, runnerFactory } = await createSession();

  await session.enqueueMessage("first");
  const run = runnerFactory.runs[0];

  await run.emit({
    type: "item.started",
    item: {
      id: "item_1",
      type: "reasoning",
      status: "in_progress"
    }
  });
  await run.emit({
    type: "item.completed",
    item: {
      id: "item_2",
      type: "agent_message",
      text: "working"
    }
  });
  await run.emit({
    type: "item.started",
    item: {
      id: "item_3",
      type: "command_execution",
      status: "in_progress"
    }
  });
  await run.emit({
    type: "item.completed",
    item: {
      id: "item_4",
      type: "agent_message",
      text: "done"
    }
  });
  run.finish();

  await flush();
  await flush();

  assert.deepEqual(fakeBotApi.messages, [
    {
      chatId: 1001,
      text: "🟢 reasoning",
      parseMode: "MarkdownV2"
    },
    {
      chatId: 1001,
      text: "🟢 command\\_execution",
      parseMode: "MarkdownV2"
    }
  ]);
  assert.deepEqual(fakeBotApi.edits, [
    {
      chatId: 1001,
      messageId: 1,
      text: "working",
      parseMode: "MarkdownV2"
    },
    {
      chatId: 1001,
      messageId: 2,
      text: "done",
      parseMode: "MarkdownV2"
    }
  ]);
});

test("long final agent_message edits the progress message and sends remaining chunks", async () => {
  const { session, fakeBotApi, runnerFactory } = await createSession();
  const longMessage = `${"A".repeat(3500)}${"B".repeat(250)}`;

  await session.enqueueMessage("first");
  const run = runnerFactory.runs[0];

  await run.emit({
    type: "item.started",
    item: {
      id: "item_1",
      type: "reasoning",
      status: "in_progress"
    }
  });
  await run.emit({
    type: "item.completed",
    item: {
      id: "item_2",
      type: "agent_message",
      text: longMessage
    }
  });
  run.finish();

  await flush();
  await flush();

  assert.deepEqual(fakeBotApi.messages, [
    {
      chatId: 1001,
      text: "🟢 reasoning",
      parseMode: "MarkdownV2"
    },
    {
      chatId: 1001,
      text: "B".repeat(250),
      parseMode: "MarkdownV2"
    }
  ]);
  assert.deepEqual(fakeBotApi.edits, [
    {
      chatId: 1001,
      messageId: 1,
      text: "A".repeat(3500),
      parseMode: "MarkdownV2"
    }
  ]);
});

test("turn errors replace the in-flight progress message", async () => {
  const { session, fakeBotApi, runnerFactory } = await createSession();

  await session.enqueueMessage("first");
  const run = runnerFactory.runs[0];

  await run.emit({
    type: "item.started",
    item: {
      id: "item_1",
      type: "reasoning",
      status: "in_progress"
    }
  });
  await run.emit({
    type: "turn.failed",
    error: {
      message: "boom"
    }
  });
  run.finish();

  await flush();
  await flush();

  assert.deepEqual(fakeBotApi.messages, [
    {
      chatId: 1001,
      text: "🟢 reasoning",
      parseMode: "MarkdownV2"
    }
  ]);
  assert.deepEqual(fakeBotApi.edits, [
    {
      chatId: 1001,
      messageId: 1,
      text: "Codex failed: boom",
      parseMode: "MarkdownV2"
    }
  ]);
});

test("progress message edits fall back to plain text when Telegram markdown parsing fails", async () => {
  const fakeBotApi = new FakeBotApi({ failMarkdownEditOnce: true });
  const { session, runnerFactory } = await createSession({ fakeBotApi });

  await session.enqueueMessage("first");
  const run = runnerFactory.runs[0];

  await run.emit({
    type: "item.started",
    item: {
      id: "item_1",
      type: "reasoning",
      status: "in_progress"
    }
  });
  await run.emit({
    type: "item.completed",
    item: {
      id: "item_2",
      type: "agent_message",
      text: "a_b"
    }
  });
  run.finish();

  await flush();
  await flush();

  assert.deepEqual(fakeBotApi.messages, [
    {
      chatId: 1001,
      text: "🟢 reasoning",
      parseMode: "MarkdownV2"
    }
  ]);
  assert.deepEqual(fakeBotApi.edits, [
    {
      chatId: 1001,
      messageId: 1,
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
      yolo: true,
      model: "default",
      reasoningEffort: "default"
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

test("runtime aggregates media groups into one attachment turn", async () => {
  const fakeBotApi = new FakeBotApi();
  fakeBotApi.registerFile("photo-1", {
    filePath: "photos/one.jpg",
    body: Buffer.from("one")
  });
  fakeBotApi.registerFile("photo-2", {
    filePath: "photos/two.jpg",
    body: Buffer.from("two")
  });
  const runnerFactory = createControlledRunnerFactory();
  const { runtime } = await createRuntime({
    fakeBotApi,
    createCodexRun: (params) => runnerFactory.createRun(params),
    albumQuietPeriodMs: 5
  });

  await runtime.handleMessage({
    message_id: 101,
    media_group_id: "album-1",
    chat: { id: 1001, type: "private" },
    from: { id: 42, username: "AllowedUser" },
    caption: "compare these",
    photo: [{ file_id: "photo-1", file_unique_id: "photo-1", file_size: 3, width: 100, height: 100 }]
  });
  await runtime.handleMessage({
    message_id: 102,
    media_group_id: "album-1",
    chat: { id: 1001, type: "private" },
    from: { id: 42, username: "AllowedUser" },
    photo: [{ file_id: "photo-2", file_unique_id: "photo-2", file_size: 3, width: 100, height: 100 }]
  });

  await waitFor(() => runnerFactory.runs.length === 1, 20);

  assert.equal(runnerFactory.runs[0].params.message, "compare these");
  assert.equal(runnerFactory.runs[0].params.imagePaths.length, 2);
  runnerFactory.runs[0].finish();
});

test("runtime rejects unsupported non-text messages", async () => {
  const { runtime, fakeBotApi } = await createRuntime();

  await runtime.handleMessage({
    chat: { id: 1001, type: "private" },
    from: { id: 42, username: "AllowedUser" },
    sticker: { file_id: "sticker-1" }
  });

  assert.equal(
    fakeBotApi.messages.at(-1).text,
    "Unsupported message type\\. Supported attachments: photo, document, video, audio, voice, animation\\."
  );
});

test("runtime clears only the current bot cache", async () => {
  const { runtime, fakeBotApi, cacheRootDir } = await createRuntime();
  const primaryCacheDir = path.join(cacheRootDir, "primary");
  const secondaryCacheDir = path.join(cacheRootDir, "secondary");
  await fs.mkdir(primaryCacheDir, { recursive: true });
  await fs.mkdir(secondaryCacheDir, { recursive: true });
  await fs.writeFile(path.join(primaryCacheDir, "one.txt"), "primary", "utf8");
  await fs.writeFile(path.join(secondaryCacheDir, "two.txt"), "secondary", "utf8");

  await runtime.handleMessage({
    chat: { id: 1001, type: "private" },
    from: { id: 42, username: "AllowedUser" },
    text: "/clear_cache"
  });

  await assert.rejects(() => fs.stat(primaryCacheDir));
  assert.equal(await fs.readFile(path.join(secondaryCacheDir, "two.txt"), "utf8"), "secondary");
  assert.equal(fakeBotApi.messages.at(-1).text, "Cleared cache for primary\\.");
});

test("runtime refuses to clear cache while bot work is pending", async () => {
  const { runtime, fakeBotApi } = await createRuntime();
  const session = runtime.sessionFor(1001);
  session.queue.push({ promptText: "pending", attachments: [] });

  await runtime.handleMessage({
    chat: { id: 1001, type: "private" },
    from: { id: 42, username: "AllowedUser" },
    text: "/clear_cache"
  });

  assert.equal(
    fakeBotApi.messages.at(-1).text,
    "Cannot clear cache while runs, queued turns, or media albums are pending\\."
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
      yolo: true,
      model: "default",
      reasoningEffort: "default"
    },
    botApi: fakeBotApi,
    stateStore
  });

  await runtime.handleMessage({
    chat: { id: 1001, type: "private" },
    from: { id: 42, username: "AllowedUser" },
    text: "/yolo"
  });

  assert.equal(stateStore.getChatState("primary", 1001).yolo, false);
  assert.equal(fakeBotApi.messages.at(-1).text, "Yolo set to off\\.");
});

test("runtime routes /model and /reasoning to the session", async () => {
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
      yolo: true,
      model: "default",
      reasoningEffort: "default"
    },
    botApi: fakeBotApi,
    stateStore
  });

  await runtime.handleMessage({
    chat: { id: 1001, type: "private" },
    from: { id: 42, username: "AllowedUser" },
    text: "/model gpt-5.4"
  });

  await runtime.handleMessage({
    chat: { id: 1001, type: "private" },
    from: { id: 42, username: "AllowedUser" },
    text: "/reasoning high"
  });

  assert.equal(stateStore.getChatState("primary", 1001).model, "gpt-5.4");
  assert.equal(stateStore.getChatState("primary", 1001).reasoningEffort, "high");
  assert.equal(fakeBotApi.messages.at(-2).text, "Model set to gpt\\-5\\.4\\.");
  assert.equal(fakeBotApi.messages.at(-1).text, "Reasoning effort set to high\\.");
});

test("runtime routes /workdir to the session", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-telegram-relay-"));
  const nextWorkdir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-telegram-relay-workdir-"));
  const stateStore = new StateStore(path.join(tempDir, "state.json"));
  await stateStore.load();

  const fakeBotApi = new FakeBotApi();
  const configStore = new FakeConfigStore();
  const runtime = new BotRuntime({
    botConfig: {
      name: "primary",
      token: "token",
      workdir: "/tmp/project",
      allowedUsernames: ["alloweduser"],
      yolo: true,
      model: "default",
      reasoningEffort: "default"
    },
    botApi: fakeBotApi,
    stateStore,
    configStore
  });

  await runtime.handleMessage({
    chat: { id: 1001, type: "private" },
    from: { id: 42, username: "AllowedUser" },
    text: `/workdir ${nextWorkdir}`
  });

  assert.equal(configStore.patches.at(-1).patch.workdir, nextWorkdir);
  assert.match(fakeBotApi.messages.at(-1).text, /Started a new session/);
});
