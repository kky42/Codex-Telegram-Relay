import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { createSession } from "./support/builders.js";
import { flush } from "./support/async.js";
import { FakeBotApi } from "./support/fakes.js";

test("sendText falls back to MarkdownV2 when Telegram HTML parsing fails", async () => {
  const fakeBotApi = new FakeBotApi({ failHtmlOnce: true });
  const { session } = await createSession({ fakeBotApi });

  await session.sendText("a_b");

  assert.deepEqual(fakeBotApi.messages, [
    {
      chatId: 1001,
      text: "a\\_b",
      parseMode: "MarkdownV2"
    }
  ]);
});

test("sendText falls back to plain text when Telegram HTML and Markdown parsing fail", async () => {
  const fakeBotApi = new FakeBotApi({ failHtmlOnce: true, failMarkdownOnce: true });
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
      parseMode: "HTML"
    }
  ]);
  assert.deepEqual(fakeBotApi.edits, [
    {
      chatId: 1001,
      messageId: 1,
      text: "🟢 command_execution",
      parseMode: "HTML"
    },
    {
      chatId: 1001,
      messageId: 1,
      text: "done",
      parseMode: "HTML"
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
      parseMode: "HTML"
    },
    {
      chatId: 1001,
      text: "🟢 command_execution",
      parseMode: "HTML"
    }
  ]);
  assert.deepEqual(fakeBotApi.edits, [
    {
      chatId: 1001,
      messageId: 1,
      text: "working",
      parseMode: "HTML"
    },
    {
      chatId: 1001,
      messageId: 2,
      text: "done",
      parseMode: "HTML"
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
      parseMode: "HTML"
    },
    {
      chatId: 1001,
      text: "B".repeat(250),
      parseMode: "HTML"
    }
  ]);
  assert.deepEqual(fakeBotApi.edits, [
    {
      chatId: 1001,
      messageId: 1,
      text: "A".repeat(3500),
      parseMode: "HTML"
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
      parseMode: "HTML"
    }
  ]);
  assert.deepEqual(fakeBotApi.edits, [
    {
      chatId: 1001,
      messageId: 1,
      text: "Codex failed: boom",
      parseMode: "HTML"
    }
  ]);
});

test("progress message edits fall back to MarkdownV2 when Telegram HTML parsing fails", async () => {
  const fakeBotApi = new FakeBotApi({ failHtmlEditOnce: true });
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
      parseMode: "HTML"
    }
  ]);
  assert.deepEqual(fakeBotApi.edits, [
    {
      chatId: 1001,
      messageId: 1,
      text: "a\\_b",
      parseMode: "MarkdownV2"
    }
  ]);
});

test("progress message edits fall back to plain text when Telegram HTML and Markdown parsing fail", async () => {
  const fakeBotApi = new FakeBotApi({ failHtmlEditOnce: true, failMarkdownEditOnce: true });
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
      parseMode: "HTML"
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

test("final agent_message can send attachments declared in the stripped output block", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-telegram-relay-output-"));
  const artifactDir = path.join(tempDir, "artifacts");
  await fs.mkdir(artifactDir, { recursive: true });
  await fs.writeFile(path.join(artifactDir, "chart.png"), "png", "utf8");

  const { session, fakeBotApi, runnerFactory } = await createSession({
    botConfig: {
      workdir: tempDir
    }
  });

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
      text: [
        "<telegram-attachments>",
        '[{"path":"./artifacts/chart.png"}]',
        "</telegram-attachments>",
        "",
        "Here is the chart."
      ].join("\n")
    }
  });
  run.finish();

  await flush();
  await flush();

  assert.deepEqual(fakeBotApi.edits, []);
  assert.deepEqual(fakeBotApi.messages, [
    {
      chatId: 1001,
      text: "🟢 reasoning",
      parseMode: "HTML"
    },
    {
      chatId: 1001,
      text: "\n\nHere is the chart.",
      parseMode: "HTML"
    }
  ]);
  assert.deepEqual(fakeBotApi.attachments, [
    {
      chatId: 1001,
      kind: "photo",
      filePath: path.join(artifactDir, "chart.png"),
      fileName: "chart.png"
    }
  ]);
  assert.deepEqual(fakeBotApi.deletions, [
    {
      chatId: 1001,
      messageId: 1
    }
  ]);
});

test("attachment-only final agent_message deletes the transient progress message", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-telegram-relay-output-"));
  const reportPath = path.join(tempDir, "report.pdf");
  await fs.writeFile(reportPath, "pdf", "utf8");

  const { session, fakeBotApi, runnerFactory } = await createSession({
    botConfig: {
      workdir: tempDir
    }
  });

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
      text: [
        "<telegram-attachments>",
        '[{"path":"./report.pdf","kind":"document"}]',
        "</telegram-attachments>"
      ].join("\n")
    }
  });
  run.finish();

  await flush();
  await flush();

  assert.deepEqual(fakeBotApi.deletions, [
    {
      chatId: 1001,
      messageId: 1
    }
  ]);
  assert.deepEqual(fakeBotApi.attachments, [
    {
      chatId: 1001,
      kind: "document",
      filePath: reportPath,
      fileName: "report.pdf"
    }
  ]);
});

test("multiple control blocks preserve text, attachment, and error order", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-telegram-relay-output-"));
  const chartPath = path.join(tempDir, "chart.png");
  const reportPath = path.join(tempDir, "report.pdf");
  await fs.writeFile(chartPath, "png", "utf8");
  await fs.writeFile(reportPath, "pdf", "utf8");

  const attachmentFailures = new Map([[reportPath, "telegram rejected file"]]);
  const fakeBotApi = new FakeBotApi({ attachmentFailures });
  const { session, runnerFactory } = await createSession({
    fakeBotApi,
    botConfig: {
      workdir: tempDir
    }
  });

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
      text: [
        "Before",
        "<telegram-attachments>",
        '[{"path":"./chart.png"}]',
        "</telegram-attachments>",
        "Between",
        "<telegram-attachments>",
        '[{"path":"./missing.pdf","kind":"document"},{"path":"./report.pdf","kind":"document"}]',
        "</telegram-attachments>",
        "After"
      ].join("\n")
    }
  });
  run.finish();

  await flush();
  await flush();

  assert.deepEqual(fakeBotApi.messages, [
    {
      chatId: 1001,
      text: "🟢 reasoning",
      parseMode: "HTML"
    },
    {
      chatId: 1001,
      text: "\nBetween\n",
      parseMode: "HTML"
    },
    {
      chatId: 1001,
      text: "Attachment error: path=./missing.pdf; kind=document; reason=file not found",
      parseMode: "HTML"
    },
    {
      chatId: 1001,
      text: "Attachment error: path=./report.pdf; kind=document; reason=telegram rejected file",
      parseMode: "HTML"
    },
    {
      chatId: 1001,
      text: "\nAfter",
      parseMode: "HTML"
    }
  ]);
  assert.deepEqual(fakeBotApi.edits, [
    {
      chatId: 1001,
      messageId: 1,
      text: "Before\n",
      parseMode: "HTML"
    }
  ]);
  assert.deepEqual(fakeBotApi.attachments, [
    {
      chatId: 1001,
      kind: "photo",
      filePath: chartPath,
      fileName: "chart.png"
    }
  ]);
  assert.deepEqual(fakeBotApi.deletions, []);
});

test("oversized outbound attachments become inline errors without sending", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-telegram-relay-output-"));
  const largePath = path.join(tempDir, "large.bin");
  await fs.writeFile(largePath, "", "utf8");
  await fs.truncate(largePath, 50 * 1024 * 1024 + 1);

  const { session, fakeBotApi, runnerFactory } = await createSession({
    botConfig: {
      workdir: tempDir
    }
  });

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
      text: [
        "<telegram-attachments>",
        '[{"path":"./large.bin","kind":"document"}]',
        "</telegram-attachments>"
      ].join("\n")
    }
  });
  run.finish();

  await flush();
  await flush();

  assert.deepEqual(fakeBotApi.attachments, []);
  assert.deepEqual(fakeBotApi.edits, [
    {
      chatId: 1001,
      messageId: 1,
      text: "Attachment error: path=./large.bin; kind=document; reason=file exceeds the 50 MB limit",
      parseMode: "HTML"
    }
  ]);
});
