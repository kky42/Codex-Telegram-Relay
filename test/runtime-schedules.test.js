import fs from "node:fs/promises";
import test from "node:test";
import assert from "node:assert/strict";

import { createRuntime } from "./support/builders.js";
import { waitFor } from "./support/async.js";

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
  assert.match(runnerFactory.runs[0].params.developerInstructions, /Telegram Bot API HTML parse mode/);
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
