import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { BotRuntime, ChatSession } from "../../src/bot-runtime.js";
import { StateStore } from "../../src/state-store.js";
import { createControlledRunnerFactory, FakeBotApi, FakeConfigStore } from "./fakes.js";

export async function createSession(options = {}) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-telegram-relay-"));
  const statePath = path.join(tempDir, "state.json");
  const cacheRootDir = path.join(tempDir, "cache");
  const stateStore = new StateStore(statePath);
  await stateStore.load();

  const fakeBotApi = options.fakeBotApi ?? new FakeBotApi();
  const runnerFactory = options.runnerFactory ?? createControlledRunnerFactory();
  const botConfig = {
    name: "primary",
    token: "token",
    workdir: "/tmp/project",
    allowedUsernames: ["alloweduser"],
    auto: "medium",
    model: "default",
    reasoningEffort: "default",
    ...options.botConfig
  };
  const configStore = options.configStore ?? new FakeConfigStore({ loadedBotConfig: botConfig });

  const session = new ChatSession({
    botConfig,
    botApi: fakeBotApi,
    stateStore,
    configStore,
    logger: () => {},
    chatId: 1001,
    cacheRootDir,
    createCodexRun: options.createCodexRun ?? ((params) => runnerFactory.createRun(params)),
    resolveContextLength: options.resolveContextLength ?? (async () => 21300),
    resolveHomeDir: options.resolveHomeDir
  });
  session.startTyping = () => {};
  session.stopTyping = () => {};

  return { session, fakeBotApi, runnerFactory, stateStore, statePath, configStore, cacheRootDir };
}

export async function createRuntime(options = {}) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-telegram-relay-runtime-"));
  const stateStore = new StateStore(path.join(tempDir, "state.json"));
  await stateStore.load();

  const fakeBotApi = options.fakeBotApi ?? new FakeBotApi();
  const runnerFactory = options.runnerFactory ?? createControlledRunnerFactory();
  const cacheRootDir = path.join(tempDir, "cache");
  const botConfig = {
    name: "primary",
    token: "token",
    workdir: "/tmp/project",
    allowedUsernames: ["alloweduser"],
    auto: "medium",
    model: "default",
    reasoningEffort: "default",
    ...options.botConfig
  };
  const configStore = options.configStore ?? new FakeConfigStore({ loadedBotConfig: botConfig });

  const runtime = new BotRuntime({
    botConfig,
    botApi: fakeBotApi,
    stateStore,
    configStore,
    createCodexRun: options.createCodexRun ?? ((params) => runnerFactory.createRun(params)),
    cacheRootDir,
    albumQuietPeriodMs: options.albumQuietPeriodMs
  });

  return { runtime, fakeBotApi, stateStore, tempDir, cacheRootDir, configStore, runnerFactory };
}
