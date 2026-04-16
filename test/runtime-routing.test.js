import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { createRuntime } from "./support/builders.js";
import { waitFor } from "./support/async.js";

function buildTextMessage(text, username = "AllowedUser") {
  return {
    chat: { id: 1001, type: "private" },
    from: { id: 42, username },
    text
  };
}

test("unauthorized users are told which Telegram username to allow", async () => {
  const { runtime, fakeBotApi } = await createRuntime();

  await runtime.handleMessage({
    chat: { id: 1001, type: "private" },
    from: { id: 42, username: "OtherUser" },
    text: "hello"
  });

  assert.equal(
    fakeBotApi.messages.at(-1).text,
    'You are not authorized to use this bot\\. Your Telegram username is @otheruser\\. Add "otheruser" to allowedUsernames in the relay config\\.'
  );
});

test("runtime aggregates media groups into one attachment turn", async () => {
  const { runtime, fakeBotApi, runnerFactory } = await createRuntime({
    albumQuietPeriodMs: 5
  });
  fakeBotApi.registerFile("photo-1", {
    filePath: "photos/one.jpg",
    body: Buffer.from("one")
  });
  fakeBotApi.registerFile("photo-2", {
    filePath: "photos/two.jpg",
    body: Buffer.from("two")
  });

  await runtime.handleMessage({
    message_id: 101,
    media_group_id: "album-1",
    chat: { id: 1001, type: "private" },
    from: { id: 42, username: "AllowedUser" },
    caption: "compare these",
    photo: [{ file_id: "photo-1", file_unique_id: "photo-1", file_size: 3, width: 100, height: 100 }]
  });
  await runtime.handleMessage({
    message_id: 102,
    media_group_id: "album-1",
    chat: { id: 1001, type: "private" },
    from: { id: 42, username: "AllowedUser" },
    photo: [{ file_id: "photo-2", file_unique_id: "photo-2", file_size: 3, width: 100, height: 100 }]
  });

  await waitFor(() => runnerFactory.runs.length === 1, 20);

  assert.equal(runnerFactory.runs[0].params.message, "compare these");
  assert.equal(runnerFactory.runs[0].params.imagePaths.length, 2);
  runnerFactory.runs[0].finish();
});

test("runtime rejects unsupported non-text messages", async () => {
  const { runtime, fakeBotApi } = await createRuntime();

  await runtime.handleMessage({
    chat: { id: 1001, type: "private" },
    from: { id: 42, username: "AllowedUser" },
    sticker: { file_id: "sticker-1" }
  });

  assert.equal(
    fakeBotApi.messages.at(-1).text,
    "Unsupported message type\\. Supported attachments: photo, document, video, audio, voice, animation\\."
  );
});

test("runtime clears only the current bot cache", async () => {
  const { runtime, fakeBotApi, cacheRootDir } = await createRuntime();
  const primaryCacheDir = path.join(cacheRootDir, "primary");
  const secondaryCacheDir = path.join(cacheRootDir, "secondary");
  await fs.mkdir(primaryCacheDir, { recursive: true });
  await fs.mkdir(secondaryCacheDir, { recursive: true });
  await fs.writeFile(path.join(primaryCacheDir, "one.txt"), "primary", "utf8");
  await fs.writeFile(path.join(secondaryCacheDir, "two.txt"), "secondary", "utf8");

  await runtime.handleMessage(buildTextMessage("/clear_cache"));

  await assert.rejects(() => fs.stat(primaryCacheDir));
  assert.equal(await fs.readFile(path.join(secondaryCacheDir, "two.txt"), "utf8"), "secondary");
  assert.equal(fakeBotApi.messages.at(-1).text, "Cleared cache for primary\\.");
});

test("runtime refuses to clear cache while bot work is pending", async () => {
  const { runtime, fakeBotApi } = await createRuntime();
  const session = runtime.sessionFor(1001);
  session.queue.push({ promptText: "pending", attachments: [] });

  await runtime.handleMessage(buildTextMessage("/clear_cache"));

  assert.equal(
    fakeBotApi.messages.at(-1).text,
    "Cannot clear cache while runs, queued turns, or media albums are pending\\."
  );
});

test("runtime routes /auto to the session", async () => {
  const { runtime, fakeBotApi, stateStore } = await createRuntime();

  await runtime.handleMessage(buildTextMessage("/auto low"));

  assert.equal(stateStore.getChatState("primary", 1001).auto, "low");
  assert.equal(fakeBotApi.messages.at(-1).text, "Auto level set to low\\.");
});

test("runtime routes /model and /reasoning to the session", async () => {
  const { runtime, fakeBotApi, stateStore } = await createRuntime();

  await runtime.handleMessage(buildTextMessage("/model gpt-5.4"));
  await runtime.handleMessage(buildTextMessage("/reasoning high"));

  assert.equal(stateStore.getChatState("primary", 1001).model, "gpt-5.4");
  assert.equal(stateStore.getChatState("primary", 1001).reasoningEffort, "high");
  assert.equal(fakeBotApi.messages.at(-2).text, "Model set to gpt\\-5\\.4\\.");
  assert.equal(fakeBotApi.messages.at(-1).text, "Reasoning effort set to high\\.");
});

test("runtime routes /workdir to the session", async () => {
  const nextWorkdir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-telegram-relay-workdir-"));
  const { runtime, fakeBotApi, configStore } = await createRuntime();

  await runtime.handleMessage(buildTextMessage(`/workdir ${nextWorkdir}`));

  assert.equal(configStore.patches.at(-1).patch.workdir, nextWorkdir);
  assert.match(fakeBotApi.messages.at(-1).text, /Started a new session/);
});
