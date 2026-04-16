import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { StateStore } from "../src/state-store.js";
import { createSession } from "./support/builders.js";
import { FakeConfigStore } from "./support/fakes.js";

test("/workdir without args returns the current workdir", async () => {
  const { session, fakeBotApi } = await createSession();

  await session.handleWorkdir("");

  assert.equal(fakeBotApi.messages.at(-1).text, "Current workdir: /tmp/project.");
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
  assert.equal(fakeBotApi.messages.at(-1).text, "Workdir is already set to /tmp/project.");
});

test("/workdir updates config, clears persisted session state, and affects the next run while idle", async () => {
  const nextWorkdir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-telegram-relay-workdir-"));
  const { session, stateStore, fakeBotApi, runnerFactory, configStore } = await createSession();
  await session.updateThreadId("thread-old");
  await session.updateContextLength(1200);

  await session.handleWorkdir(nextWorkdir);

  assert.equal(session.botConfig.workdir, nextWorkdir);
  assert.equal(session.threadId, null);
  assert.equal(session.contextLength, null);
  assert.equal(configStore.patches.at(-1).patch.workdir, nextWorkdir);
  assert.deepEqual(stateStore.getChatState("primary", 1001), {
    threadId: null,
    contextLength: null,
    auto: null,
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
  await session.updateContextLength(1200);

  await session.handleWorkdir(nextWorkdir);

  assert.equal(session.botConfig.workdir, "/tmp/project");
  assert.equal(session.threadId, "thread-old");
  assert.equal(stateStore.getChatState("primary", 1001).contextLength, 1200);
  assert.equal(fakeBotApi.messages.at(-1).text, "Failed to persist workdir setting: disk full");
});

test("/workdir rolls back config and in-memory workdir if clearing the session state fails", async () => {
  const nextWorkdir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-telegram-relay-workdir-"));
  const { session, stateStore, configStore, fakeBotApi } = await createSession();
  await session.updateThreadId("thread-old");
  await session.updateContextLength(1200);

  const originalPatchChatState = stateStore.patchChatState.bind(stateStore);
  stateStore.patchChatState = async (botName, chatId, patch) => {
    if (patch.threadId === null && patch.contextLength === null) {
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
  assert.equal(stateStore.getChatState("primary", 1001).contextLength, 1200);
  assert.equal(
    fakeBotApi.messages.at(-1).text,
    "Failed to reset session after changing workdir: state write failed"
  );
});

test("status shows the latest context length", async () => {
  const { session } = await createSession();
  session.contextLength = 18321;

  assert.equal(
    session.statusText(),
    [
      "running: no",
      "workdir: /tmp/project",
      "auto: high",
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
      "auto: high",
      "model: default",
      "reasoning_effort: default",
      "context_length: n/a",
      "queue:",
      "1. [1 attachment] Review the attached PDF"
    ].join("\n")
  );
});

test("/auto updates future runs and persists the override", async () => {
  const { session, runnerFactory, stateStore, fakeBotApi, configStore } = await createSession();

  await session.handleAuto("low");

  assert.equal(session.auto, "low");
  assert.equal(stateStore.getChatState("primary", 1001).auto, "low");
  assert.equal(configStore.patches.at(-1).patch.auto, "low");
  assert.equal(fakeBotApi.messages.at(-1).text, "Auto level set to low.");

  await session.enqueueMessage("hello");
  assert.equal(runnerFactory.runs[0].params.autoMode, "low");
});

test("/auto accepts explicit low, medium, and high values", async () => {
  const { session, fakeBotApi } = await createSession();

  await session.handleAuto("medium");
  assert.equal(session.auto, "medium");
  assert.equal(fakeBotApi.messages.at(-1).text, "Auto level set to medium.");

  await session.handleAuto("high");
  assert.equal(session.auto, "high");
  assert.equal(fakeBotApi.messages.at(-1).text, "Auto level set to high.");
});

test("/auto without args returns the current value", async () => {
  const { session, fakeBotApi } = await createSession();

  await session.handleAuto("");

  assert.equal(fakeBotApi.messages.at(-1).text, "Current auto level: high.");
});

test("/model without args returns the current model", async () => {
  const { session, fakeBotApi } = await createSession();

  await session.handleModel("");

  assert.equal(fakeBotApi.messages.at(-1).text, "Current model: default.");
});

test("/model with a value persists to state/config and affects next run", async () => {
  const { session, fakeBotApi, runnerFactory, stateStore, configStore } = await createSession();

  await session.handleModel("gpt-5.4");

  assert.equal(session.model, "gpt-5.4");
  assert.equal(stateStore.getChatState("primary", 1001).model, "gpt-5.4");
  assert.equal(configStore.patches.at(-1).patch.model, "gpt-5.4");
  assert.equal(fakeBotApi.messages.at(-1).text, "Model set to gpt-5.4.");

  await session.enqueueMessage("hello");
  assert.equal(runnerFactory.runs[0].params.model, "gpt-5.4");
});

test("/reasoning without args returns the current value", async () => {
  const { session, fakeBotApi } = await createSession();

  await session.handleReasoningEffort("");

  assert.equal(fakeBotApi.messages.at(-1).text, "Current reasoning effort: default.");
});

test("/reasoning with a value persists to state/config and affects next run", async () => {
  const { session, fakeBotApi, runnerFactory, stateStore, configStore } = await createSession();

  await session.handleReasoningEffort("high");

  assert.equal(session.reasoningEffort, "high");
  assert.equal(stateStore.getChatState("primary", 1001).reasoningEffort, "high");
  assert.equal(configStore.patches.at(-1).patch.reasoningEffort, "high");
  assert.equal(fakeBotApi.messages.at(-1).text, "Reasoning effort set to high.");

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

test("state store reads only the current context length schema", async () => {
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
              contextLength: 21300
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
    contextLength: 21300,
    auto: null,
    model: null,
    reasoningEffort: null
  });
});
