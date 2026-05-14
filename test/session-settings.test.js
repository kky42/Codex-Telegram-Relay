import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { createSession } from "./support/builders.js";
import { FakeConfigStore } from "./support/fakes.js";

test("/workdir without args returns the current workdir", async () => {
  const { session, fakeBotApi } = await createSession();

  await session.handleWorkdir("");

  assert.equal(fakeBotApi.messages.at(-1).text, "Current workdir: /tmp/project.");
});

test("/workdir expands ~/ paths and updates the current session only", async () => {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "anyagent-home-"));
  const desktopDir = path.join(homeDir, "Desktop");
  await fs.mkdir(desktopDir);
  const { session, configStore, fakeBotApi } = await createSession({
    resolveHomeDir: () => homeDir
  });

  await session.handleWorkdir("~/Desktop");

  assert.equal(session.workdir, desktopDir);
  assert.equal(session.sessionId, null);
  assert.equal(session.contextLength, null);
  assert.equal(configStore.patches.length, 0);
  assert.match(fakeBotApi.messages.at(-1).text, /Started a new session/);
});

test("/workdir rejects invalid paths", async () => {
  const { session, fakeBotApi } = await createSession();

  await session.handleWorkdir("/definitely/not/a/real/path");
  assert.match(fakeBotApi.messages.at(-1).text, /Invalid workdir/);

  await session.handleWorkdir("subdir");
  assert.match(fakeBotApi.messages.at(-1).text, /Invalid workdir/);
});

test("/workdir is a no-op when the normalized path matches the current workdir", async () => {
  const { session, fakeBotApi, configStore } = await createSession();
  await session.updateSessionId("session-old");

  await session.handleWorkdir("/tmp/project");

  assert.equal(session.sessionId, "session-old");
  assert.equal(session.workdir, "/tmp/project");
  assert.equal(configStore.patches.length, 0);
  assert.equal(fakeBotApi.messages.at(-1).text, "Workdir is already set to /tmp/project.");
});

test("/workdir aborts the active run, clears the queue, and uses the new workdir on the next run", async () => {
  const nextWorkdir = await fs.mkdtemp(path.join(os.tmpdir(), "anyagent-workdir-"));
  const { session, runnerFactory } = await createSession();
  await session.updateSessionId("session-old");

  await session.enqueueMessage("first");
  await session.enqueueMessage("second");
  assert.equal(session.queue.length, 1);

  await session.handleWorkdir(nextWorkdir);

  assert.equal(runnerFactory.runs[0].aborted, true);
  assert.equal(session.queue.length, 0);
  assert.equal(session.sessionId, null);
  assert.equal(session.workdir, nextWorkdir);

  await session.enqueueMessage("after switch");
  assert.equal(runnerFactory.runs.at(-1).params.workdir, nextWorkdir);
  assert.equal(runnerFactory.runs.at(-1).params.sessionId, null);
});

test("status shows the latest context length", async () => {
  const { session } = await createSession();
  session.contextLength = 18321;

  assert.equal(
    session.statusText(),
    [
      "running: no",
      "cli: codex",
      "workdir: /tmp/project",
      "auto: medium",
      "model: default",
      "reasoning_effort: default",
      "context_length: 18.3k",
      "queue:",
      "empty"
    ].join("\n")
  );
});

test("status shows the configured CLI", async () => {
  const { session } = await createSession({
    agent: {
      cli: "pi"
    }
  });

  assert.match(session.statusText(), /^cli: pi$/m);
});

test("/auto updates future runs and stays in memory", async () => {
  const { session, runnerFactory, configStore, fakeBotApi } = await createSession();

  await session.handleAuto("low");

  assert.equal(session.auto, "low");
  assert.equal(configStore.patches.length, 0);
  assert.equal(fakeBotApi.messages.at(-1).text, "Auto level set to low.");

  await session.enqueueMessage("hello");
  assert.equal(runnerFactory.runs[0].params.autoMode, "low");
});

test("/model and /reasoning update the current chat only", async () => {
  const { session, runnerFactory, configStore, fakeBotApi } = await createSession();

  await session.handleModel("gpt-5.4");
  await session.handleReasoningEffort("high");

  assert.equal(session.model, "gpt-5.4");
  assert.equal(session.reasoningEffort, "high");
  assert.equal(configStore.patches.length, 0);
  assert.equal(fakeBotApi.messages.at(-2).text, "Model set to gpt-5.4.");
  assert.equal(fakeBotApi.messages.at(-1).text, "Reasoning effort set to high.");

  await session.enqueueMessage("hello");
  assert.equal(runnerFactory.runs[0].params.model, "gpt-5.4");
  assert.equal(runnerFactory.runs[0].params.reasoningEffort, "high");
});

test("/reset reloads config defaults, clears chat overrides, and starts a new session", async () => {
  const nextWorkdir = await fs.mkdtemp(path.join(os.tmpdir(), "anyagent-reset-"));
  const { session, fakeBotApi, configStore } = await createSession({
    botConfig: {
      agent: {
        id: "primary-agent",
        cli: "codex",
        workdir: "/tmp/project-old",
        auto: "low",
        model: "gpt-5.4",
        reasoningEffort: "low"
      }
    }
  });

  await session.handleAuto("medium");
  await session.handleModel("default");
  await session.handleReasoningEffort("xhigh");
  await session.updateSessionId("session-old");
  await session.updateContextLength(1200);

  configStore.loadedBotConfig = {
    username: "relaybot",
    allowedUsernames: ["alloweduser"],
    agent: {
      id: "primary-agent",
      cli: "codex",
      workdir: nextWorkdir,
      auto: "high",
      model: "gpt-5.4-mini",
      reasoningEffort: "high"
    }
  };

  await session.handleReset();

  assert.equal(session.botConfig.agent.workdir, nextWorkdir);
  assert.equal(session.workdir, nextWorkdir);
  assert.equal(session.auto, "high");
  assert.equal(session.model, "gpt-5.4-mini");
  assert.equal(session.reasoningEffort, "high");
  assert.equal(session.sessionId, null);
  assert.equal(session.contextLength, null);
  assert.equal(configStore.loads.length, 1);
  assert.equal(
    fakeBotApi.messages.at(-1).text,
    `Reset current chat to config defaults. Started a new session with workdir ${nextWorkdir}, auto high, model gpt-5.4-mini, reasoning effort high.`
  );
});

test("/reset leaves the session untouched when config reload fails", async () => {
  const configStore = new FakeConfigStore();
  configStore.loadFailure = new Error("config parse failed");
  const { session, fakeBotApi } = await createSession({ configStore });
  await session.updateSessionId("session-old");
  await session.updateContextLength(1200);

  await session.handleReset();

  assert.equal(session.sessionId, "session-old");
  assert.equal(session.contextLength, 1200);
  assert.equal(fakeBotApi.messages.at(-1).text, "Failed to reload bot config: config parse failed");
});
