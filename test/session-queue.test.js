import test from "node:test";
import assert from "node:assert/strict";

import { createSession } from "./support/builders.js";
import { waitFor } from "./support/async.js";

test("session queues incoming messages and resumes with the current session id", async () => {
  const { session, fakeBotApi, runnerFactory } = await createSession();

  await session.enqueueMessage("first");
  assert.equal(runnerFactory.runs.length, 1);
  assert.equal(runnerFactory.runs[0].params.sessionId, null);
  assert.equal(runnerFactory.runs[0].params.autoMode, "medium");
  assert.equal(runnerFactory.runs[0].params.model, "default");
  assert.equal(runnerFactory.runs[0].params.reasoningEffort, "default");

  await session.enqueueMessage("second");
  assert.equal(session.queue.length, 1);
  assert.equal(fakeBotApi.messages.at(-1).text, "Queued message 1.");

  await runnerFactory.runs[0].emit({
    type: "thread.started",
    thread_id: "session-abc"
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
  assert.equal(runnerFactory.runs[1].params.sessionId, "session-abc");
  assert.equal(runnerFactory.runs[1].params.autoMode, "medium");
  assert.equal(session.sessionId, "session-abc");
  assert.equal(session.contextLength, 21300);
  assert.equal(session.auto, "medium");
});

test("Claude session events update session id, context length, and resume", async () => {
  const { session, runnerFactory } = await createSession({
    agent: {
      cli: "claude"
    },
    resolveContextLength: async () => null
  });

  await session.enqueueMessage("first");
  assert.equal(runnerFactory.runs.length, 1);
  assert.equal(runnerFactory.runs[0].params.sessionId, null);

  await runnerFactory.runs[0].emit({
    type: "system",
    subtype: "init",
    session_id: "9f4026da-cb03-4e1e-a75c-b3fa94f42156"
  });
  await runnerFactory.runs[0].emit({
    type: "assistant",
    message: {
      content: [
        {
          type: "text",
          text: "done"
        }
      ],
      usage: {
        input_tokens: 1000,
        cache_creation_input_tokens: 5000,
        cache_read_input_tokens: 200,
        output_tokens: 50
      }
    }
  });
  await runnerFactory.runs[0].emit({
    type: "result",
    subtype: "success",
    is_error: false
  });
  runnerFactory.runs[0].finish();

  await waitFor(() => session.isRunning === false);
  assert.equal(session.sessionId, "9f4026da-cb03-4e1e-a75c-b3fa94f42156");
  assert.equal(session.contextLength, 1250);

  await session.enqueueMessage("second");
  assert.equal(runnerFactory.runs.at(-1).params.sessionId, "9f4026da-cb03-4e1e-a75c-b3fa94f42156");
});

test("Pi session events update session id, context length, and resume from final message_end", async () => {
  const { session, runnerFactory, fakeBotApi } = await createSession({
    agent: {
      cli: "pi"
    },
    resolveContextLength: async () => null
  });

  await session.enqueueMessage("first");
  assert.equal(runnerFactory.runs.length, 1);
  assert.equal(runnerFactory.runs[0].params.sessionId, null);

  await runnerFactory.runs[0].emit({
    type: "session",
    id: "019e227d-4508-74ed-acd1-9d990c98b99d"
  });
  await runnerFactory.runs[0].emit({
    type: "message_update",
    assistantMessageEvent: {
      type: "text_delta",
      delta: "ignored"
    },
    message: {
      role: "assistant",
      content: [{ type: "text", text: "ignored" }]
    }
  });
  await runnerFactory.runs[0].emit({
    type: "message_end",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "skip" },
        { type: "text", text: "done" }
      ],
      usage: {
        input: 1000,
        output: 50,
        cacheRead: 200,
        cacheWrite: 0,
        totalTokens: 1250
      },
      stopReason: "stop"
    }
  });
  await runnerFactory.runs[0].emit({
    type: "turn_end",
    message: {
      role: "assistant",
      usage: {
        input: 1000,
        output: 50,
        cacheRead: 200,
        cacheWrite: 0,
        totalTokens: 1250
      }
    }
  });
  runnerFactory.runs[0].finish();

  await waitFor(() => session.isRunning === false);
  assert.equal(session.sessionId, "019e227d-4508-74ed-acd1-9d990c98b99d");
  assert.equal(session.contextLength, 1250);
  assert.deepEqual(fakeBotApi.messages, [
    {
      chatId: 1001,
      text: "done",
      parseMode: "HTML"
    }
  ]);

  await session.enqueueMessage("second");
  assert.equal(runnerFactory.runs.at(-1).params.sessionId, "019e227d-4508-74ed-acd1-9d990c98b99d");
});

test("abort clears queue but keeps the existing session id", async () => {
  const { session, fakeBotApi, runnerFactory } = await createSession();
  session.sessionId = "session-keep";

  await session.enqueueMessage("first");
  await session.enqueueMessage("second");
  assert.equal(session.queue.length, 1);

  await session.handleAbort();

  assert.equal(runnerFactory.runs[0].aborted, true);
  assert.equal(session.queue.length, 0);
  assert.equal(session.sessionId, "session-keep");
  assert.equal(fakeBotApi.messages.at(-1).text, "Aborted current run and cleared the queue.");
});

test("new session clears session id and context length without changing runtime defaults", async () => {
  const { session, fakeBotApi } = await createSession();
  await session.updateSessionId("session-old");
  await session.updateContextLength(1200);
  await session.handleAuto("high");
  await session.handleModel("gpt-5.4");

  await session.handleNewSession();

  assert.equal(session.sessionId, null);
  assert.equal(session.contextLength, null);
  assert.equal(session.auto, "high");
  assert.equal(session.model, "gpt-5.4");
  assert.equal(
    fakeBotApi.messages.at(-1).text,
    "Started a new session. The next message will open a fresh Codex session."
  );
});

test("resumed sessions keep the latest context length in memory", async () => {
  const { session, runnerFactory } = await createSession();
  session.sessionId = "session-existing";

  await session.enqueueMessage("resume");
  assert.equal(runnerFactory.runs.length, 1);
  assert.equal(runnerFactory.runs[0].params.sessionId, "session-existing");

  await runnerFactory.runs[0].emit({
    type: "turn.completed",
    usage: {
      input_tokens: 25000,
      cached_input_tokens: 18000,
      output_tokens: 420
    }
  });
  runnerFactory.runs[0].finish();

  await waitFor(() => session.contextLength !== null);

  assert.equal(session.contextLength, 21300);
  assert.equal(session.auto, "medium");
  assert.equal(session.model, "default");
  assert.equal(session.reasoningEffort, "default");
});
