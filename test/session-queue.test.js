import test from "node:test";
import assert from "node:assert/strict";

import { createSession } from "./support/builders.js";
import { waitFor } from "./support/async.js";

test("session queues incoming messages and resumes with persisted thread id", async () => {
  const { session, fakeBotApi, runnerFactory, stateStore } = await createSession();

  await session.enqueueMessage("first");
  assert.equal(runnerFactory.runs.length, 1);
  assert.equal(runnerFactory.runs[0].params.threadId, null);
  assert.equal(runnerFactory.runs[0].params.autoMode, "high");
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
  assert.equal(runnerFactory.runs[1].params.autoMode, "high");
  assert.equal(stateStore.getChatState("primary", 1001).threadId, "thread-abc");
  assert.equal(stateStore.getChatState("primary", 1001).contextLength, 21300);
  assert.equal(stateStore.getChatState("primary", 1001).auto, null);
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

test("new session clears persisted thread id and context length", async () => {
  const { session, stateStore, fakeBotApi } = await createSession();
  await session.updateThreadId("thread-old");
  await session.updateContextLength(1200);

  await session.handleNewSession();

  assert.equal(session.threadId, null);
  assert.equal(session.contextLength, null);
  assert.deepEqual(stateStore.getChatState("primary", 1001), {
    threadId: null,
    contextLength: null,
    auto: null,
    model: null,
    reasoningEffort: null
  });
  assert.equal(
    fakeBotApi.messages.at(-1).text,
    "Started a new session\\. The next message will open a fresh Codex thread\\."
  );
});

test("resumed sessions keep the latest context length", async () => {
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

  await waitFor(() => stateStore.getChatState("primary", 1001).contextLength !== null);

  assert.equal(stateStore.getChatState("primary", 1001).contextLength, 21300);
  assert.equal(stateStore.getChatState("primary", 1001).auto, null);
  assert.equal(stateStore.getChatState("primary", 1001).model, null);
  assert.equal(stateStore.getChatState("primary", 1001).reasoningEffort, null);
});
