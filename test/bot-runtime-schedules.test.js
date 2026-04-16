import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { BotRuntime } from "../src/bot-runtime.js";
import { StateStore } from "../src/state-store.js";

async function waitFor(predicate, attempts = 20) {
  for (let index = 0; index < attempts; index += 1) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  assert.equal(predicate(), true);
}

class FakeBotApi {
  constructor() {
    this.messages = [];
    this.edits = [];
  }

  async sendMessage(payload) {
    this.messages.push(payload);
    return { message_id: this.messages.length };
  }

  async editMessageText(payload) {
    this.edits.push(payload);
    return { message_id: payload.messageId };
  }

  async sendChatAction() {
    return true;
  }

  async getMe() {
    return { username: "relaybot" };
  }

  async setMyCommands() {
    return true;
  }
}

class FakeConfigStore {
  constructor() {
    this.patches = [];
  }

  async patchBotConfig(botName, patch) {
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
        done: new Promise((resolve) => {
          resolveDone = resolve;
        }),
        finish(result = { code: 0, signal: null, aborted: false, sawTerminalEvent: true }) {
          resolveDone(result);
        },
        abort() {
          resolveDone({ code: null, signal: "SIGTERM", aborted: true, sawTerminalEvent: false });
        }
      };
      runs.push(run);
      return run;
    }
  };
}

async function createRuntime(options = {}) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-telegram-relay-runtime-"));
  const stateStore = new StateStore(path.join(tempDir, "state.json"));
  await stateStore.load();

  const fakeBotApi = options.fakeBotApi ?? new FakeBotApi();
  const configStore = options.configStore ?? new FakeConfigStore();
  const runnerFactory = options.runnerFactory ?? createControlledRunnerFactory();

  const runtime = new BotRuntime({
    botConfig: {
      name: "primary",
      token: "token",
      workdir: "/tmp/project",
      allowedUsernames: ["alloweduser"],
      schedules: [],
      auto: "high",
      model: "default",
      reasoningEffort: "default",
      ...options.botConfig
    },
    botApi: fakeBotApi,
    stateStore,
    configStore,
    createCodexRun: (params) => runnerFactory.createRun(params),
    cacheRootDir: path.join(tempDir, "cache")
  });

  return { runtime, fakeBotApi, configStore, runnerFactory };
}

function buildMessage(text) {
  return {
    chat: {
      id: 1001,
      type: "private"
    },
    from: {
      username: "alloweduser"
    },
    text
  };
}

test("/schedule add, list, pause, resume, and delete manage schedules for the current chat", async () => {
  const { runtime, fakeBotApi, configStore } = await createRuntime();

  await runtime.handleMessage(
    buildMessage("/schedule add daily-report medium\n0 9 * * 1-5\n\nsummarize repo changes")
  );

  assert.deepEqual(runtime.botConfig.schedules, [
    {
      name: "daily-report",
      auto: "medium",
      cron: "0 9 * * 1-5",
      prompt: "summarize repo changes",
      chatId: 1001,
      enabled: true
    }
  ]);
  assert.deepEqual(configStore.patches.at(-1), {
    botName: "primary",
    patch: {
      schedules: runtime.botConfig.schedules
    }
  });

  await runtime.handleMessage(buildMessage("/schedule list"));
  assert.match(fakeBotApi.messages.at(-1).text, /daily/);

  await runtime.handleMessage(buildMessage("/schedule pause daily-report"));
  assert.equal(runtime.botConfig.schedules[0].enabled, false);

  await runtime.handleMessage(buildMessage("/schedule resume daily-report"));
  assert.equal(runtime.botConfig.schedules[0].enabled, true);

  await runtime.handleMessage(buildMessage("/schedule delete daily-report"));
  assert.deepEqual(runtime.botConfig.schedules, []);
});

test("/schedule run uses an ephemeral codex run and sends only the last agent message", async () => {
  const { runtime, fakeBotApi, runnerFactory } = await createRuntime({
    botConfig: {
      schedules: [
        {
          name: "daily-report",
          auto: "low",
          cron: "0 9 * * 1-5",
          prompt: "summarize repo changes",
          chatId: 1001,
          enabled: true
        }
      ]
    }
  });

  await runtime.handleMessage(buildMessage("/schedule run daily-report"));
  await waitFor(() => runnerFactory.runs.length === 1);
  assert.equal(runnerFactory.runs[0].params.threadId, null);
  assert.equal(runnerFactory.runs[0].params.ephemeral, true);
  assert.equal(runnerFactory.runs[0].params.autoMode, "low");
  assert.match(runnerFactory.runs[0].params.outputLastMessagePath, /last-message\.txt$/);

  await fs.writeFile(runnerFactory.runs[0].params.outputLastMessagePath, "final scheduled answer", "utf8");
  runnerFactory.runs[0].finish();

  await waitFor(() => fakeBotApi.messages.length >= 2);
  assert.equal(fakeBotApi.edits.length, 0);
  assert.match(fakeBotApi.messages.at(-1).text, /schedule/);
  assert.match(fakeBotApi.messages.at(-1).text, /final scheduled answer/);
});

test("tickSchedules triggers matching schedules only once per minute", async () => {
  const { runtime, fakeBotApi, runnerFactory } = await createRuntime({
    botConfig: {
      schedules: [
        {
          name: "hourly-report",
          auto: "high",
          cron: "0 9 * * 1-5",
          prompt: "hourly summary",
          chatId: 1001,
          enabled: true
        }
      ]
    }
  });

  const scheduledAt = new Date("2026-04-13T09:00:00");
  await runtime.tickSchedules(scheduledAt);
  await runtime.tickSchedules(scheduledAt);

  await waitFor(() => runnerFactory.runs.length === 1);
  await fs.writeFile(runnerFactory.runs[0].params.outputLastMessagePath, "tick output", "utf8");
  runnerFactory.runs[0].finish();

  await waitFor(() => fakeBotApi.messages.length >= 1);
  assert.match(fakeBotApi.messages.at(-1).text, /tick output/);
});
