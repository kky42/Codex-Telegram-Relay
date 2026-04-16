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
