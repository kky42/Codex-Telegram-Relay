import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { createRuntime } from "./support/builders.js";
import { waitFor } from "./support/async.js";
import { FakeBotApi } from "./support/fakes.js";

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

test("/schedule add rejects auto aliases and requires low, medium, or high", async () => {
  const { runtime, fakeBotApi } = await createRuntime();

  await runtime.handleMessage(
    buildMessage("/schedule add daily-report workspace-write\n0 9 * * 1-5\n\nsummarize repo changes")
  );

  assert.deepEqual(runtime.botConfig.schedules ?? [], []);
  assert.equal(fakeBotApi.messages.at(-1).text, "Unknown auto level. Use low, medium, or high.");
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

test("scheduled outputs can send attachments through the stripped output block", async () => {
  const workdir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-telegram-relay-schedule-workdir-"));
  await fs.writeFile(path.join(workdir, "report.pdf"), "pdf", "utf8");

  const { runtime, fakeBotApi, runnerFactory } = await createRuntime({
    botConfig: {
      workdir,
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

  await fs.writeFile(
    runnerFactory.runs[0].params.outputLastMessagePath,
    [
      "<telegram-attachments>",
      '[{"path":"./report.pdf","kind":"document"}]',
      "</telegram-attachments>",
      "",
      "Daily report is ready."
    ].join("\n"),
    "utf8"
  );
  runnerFactory.runs[0].finish();

  await waitFor(() => fakeBotApi.attachments.length === 1 && fakeBotApi.messages.length >= 3);

  assert.match(fakeBotApi.messages.at(-2).text, /^\[schedule: daily-report\]/);
  assert.match(fakeBotApi.messages.at(-1).text, /Daily report is ready/);
  assert.deepEqual(fakeBotApi.attachments, [
    {
      chatId: 1001,
      kind: "document",
      filePath: path.join(workdir, "report.pdf"),
      fileName: "report.pdf"
    }
  ]);
});

test("scheduled outputs preserve inline error order for failed attachments", async () => {
  const workdir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-telegram-relay-schedule-workdir-"));
  const goodPath = path.join(workdir, "good.pdf");
  await fs.writeFile(goodPath, "pdf", "utf8");

  const { runtime, fakeBotApi, runnerFactory } = await createRuntime({
    fakeBotApi: new FakeBotApi({
      attachmentFailures: new Map([[goodPath, "telegram rejected file"]])
    }),
    botConfig: {
      workdir,
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

  await fs.writeFile(
    runnerFactory.runs[0].params.outputLastMessagePath,
    [
      "Intro",
      "<telegram-attachments>",
      '[{"path":"./missing.pdf","kind":"document"},{"path":"./good.pdf","kind":"document"}]',
      "</telegram-attachments>",
      "Outro"
    ].join("\n"),
    "utf8"
  );
  runnerFactory.runs[0].finish();

  await waitFor(() => fakeBotApi.messages.length >= 5);

  assert.equal(fakeBotApi.attachments.length, 0);
  assert.match(fakeBotApi.messages.at(-4).text, /^\[schedule: daily-report\]/);
  assert.match(fakeBotApi.messages.at(-4).text, /Intro/);
  assert.equal(
    fakeBotApi.messages.at(-3).text,
    "Attachment error: path=./missing.pdf; kind=document; reason=file not found"
  );
  assert.equal(
    fakeBotApi.messages.at(-2).text,
    "Attachment error: path=./good.pdf; kind=document; reason=telegram rejected file"
  );
  assert.match(fakeBotApi.messages.at(-1).text, /Outro/);
});
