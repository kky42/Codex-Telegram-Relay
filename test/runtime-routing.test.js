import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { createRuntime } from "./support/builders.js";
import { FakeBotApi } from "./support/fakes.js";
import { waitFor } from "./support/async.js";

function buildTextMessage(text, username = "AllowedUser", chatId = 1001) {
  return {
    chat: { id: chatId, type: "private" },
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
    'You are not authorized to use this bot. Your Telegram username is @otheruser. Add "otheruser" to allowedUsernames in this Telegram binding.'
  );
});

test("runtime discards pending Telegram updates during startup", async () => {
  const fakeBotApi = new FakeBotApi({
    getUpdatesResult: [{ update_id: 77, message: { text: "old" } }]
  });
  const { runtime } = await createRuntime({ fakeBotApi });

  await runtime.initialize();

  assert.deepEqual(fakeBotApi.getUpdatesCalls[0], {
    offset: -1,
    limit: 1,
    timeout: 0
  });
  assert.equal(runtime.offset, 78);
  assert.equal(runtime.sessions.size, 0);
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

  assert.match(runnerFactory.runs[0].params.message, /^compare these\n\n<attachments>/);
  assert.equal("imagePaths" in runnerFactory.runs[0].params, false);
  assert.match(runnerFactory.runs[0].params.message, /msg101\.jpg" kind="photo"/);
  assert.match(runnerFactory.runs[0].params.message, /msg102\.jpg" kind="photo"/);
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
    "Unsupported message type. Supported attachments: photo, document, video, audio, voice, animation."
  );
});

test("runtime clears only the current bot cache", async () => {
  const { runtime, fakeBotApi, cacheRootDir } = await createRuntime();
  const primaryCacheDir = path.join(cacheRootDir, "telegram", "relaybot");
  const secondaryCacheDir = path.join(cacheRootDir, "telegram", "otherbot");
  await fs.mkdir(primaryCacheDir, { recursive: true });
  await fs.mkdir(secondaryCacheDir, { recursive: true });
  await fs.writeFile(path.join(primaryCacheDir, "one.txt"), "primary", "utf8");
  await fs.writeFile(path.join(secondaryCacheDir, "two.txt"), "secondary", "utf8");

  await runtime.handleMessage(buildTextMessage("/clear_cache"));

  await assert.rejects(() => fs.stat(primaryCacheDir));
  assert.equal(await fs.readFile(path.join(secondaryCacheDir, "two.txt"), "utf8"), "secondary");
  assert.equal(fakeBotApi.messages.at(-1).text, "Cleared cache for @relaybot.");
});

test("runtime routes /auto, /model, and /reasoning to the current chat session", async () => {
  const { runtime, fakeBotApi } = await createRuntime();

  await runtime.handleMessage(buildTextMessage("/auto low"));
  await runtime.handleMessage(buildTextMessage("/model gpt-5.4"));
  await runtime.handleMessage(buildTextMessage("/reasoning high"));

  const session = runtime.sessionFor(1001);
  assert.equal(session.auto, "low");
  assert.equal(session.model, "gpt-5.4");
  assert.equal(session.reasoningEffort, "high");
  assert.equal(fakeBotApi.messages.at(-3).text, "Auto level set to low.");
  assert.equal(fakeBotApi.messages.at(-2).text, "Model set to gpt-5.4.");
  assert.equal(fakeBotApi.messages.at(-1).text, "Reasoning effort set to high.");
});

test("runtime treats unknown slash commands as normal prompts", async () => {
  const { runtime, fakeBotApi, runnerFactory } = await createRuntime();

  await runtime.handleMessage(buildTextMessage("/unknown_command"));

  assert.equal(fakeBotApi.messages.length, 0);
  assert.equal(runnerFactory.runs.length, 1);
  assert.equal(runnerFactory.runs[0].params.message, "/unknown_command");
  runnerFactory.runs[0].finish();
});

test("runtime keeps separate sessions for different private chats", async () => {
  const { runtime } = await createRuntime({
    botConfig: {
      agent: {
        id: "primary-agent",
        cli: "codex",
        workdir: "/tmp/project",
        auto: "medium",
        model: "deepseek-v4-flash",
        reasoningEffort: "default"
      }
    }
  });

  await runtime.handleMessage(buildTextMessage("/model gpt-5.5", "AllowedUser", 1001));

  const sessionA = runtime.sessionFor(1001);
  const sessionB = runtime.sessionFor(2002);

  assert.equal(sessionA.model, "gpt-5.5");
  assert.equal(sessionB.model, "deepseek-v4-flash");
  assert.equal(sessionA.workdir, "/tmp/project");
  assert.equal(sessionB.workdir, "/tmp/project");
});

test("runtime creates Claude-backed chat sessions from agent profile", async () => {
  const { runtime, runnerFactory } = await createRuntime({
    botConfig: {
      agent: {
        id: "claude-agent",
        cli: "claude",
        workdir: "/tmp/project",
        auto: "medium",
        model: "default",
        reasoningEffort: "default"
      }
    }
  });

  await runtime.handleMessage(buildTextMessage("hello"));

  const session = runtime.sessionFor(1001);
  assert.equal(session.cliAdapter.id, "claude");
  assert.equal(runnerFactory.runs.length, 1);
  assert.equal(runnerFactory.runs[0].params.message, "hello");
  runnerFactory.runs[0].finish();
});

test("runtime creates Pi-backed chat sessions from agent profile", async () => {
  const { runtime, runnerFactory } = await createRuntime({
    botConfig: {
      agent: {
        id: "pi-agent",
        cli: "pi",
        workdir: "/tmp/project",
        auto: "medium",
        model: "default",
        reasoningEffort: "default"
      }
    }
  });

  await runtime.handleMessage(buildTextMessage("hello"));

  const session = runtime.sessionFor(1001);
  assert.equal(session.cliAdapter.id, "pi");
  assert.equal(runnerFactory.runs.length, 1);
  assert.equal(runnerFactory.runs[0].params.message, "hello");
  runnerFactory.runs[0].finish();
});

test("runtime routes /reset to the current chat session only", async () => {
  const nextWorkdir = await fs.mkdtemp(path.join(os.tmpdir(), "anyagent-reset-"));
  const { runtime, fakeBotApi, configStore } = await createRuntime({
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

  await runtime.handleMessage(buildTextMessage("/auto high"));
  await runtime.handleMessage(buildTextMessage("/reasoning xhigh"));
  configStore.loadedBotConfig = {
    username: "relaybot",
    allowedUsernames: ["alloweduser"],
    agent: {
      id: "primary-agent",
      cli: "codex",
      workdir: nextWorkdir,
      auto: "medium",
      model: "default",
      reasoningEffort: "high"
    }
  };
  await runtime.handleMessage(buildTextMessage("/reset"));

  const session = runtime.sessionFor(1001);
  assert.equal(session.sessionId, null);
  assert.equal(session.contextLength, null);
  assert.equal(session.workdir, nextWorkdir);
  assert.equal(session.auto, "medium");
  assert.equal(session.model, "default");
  assert.equal(session.reasoningEffort, "high");
  assert.equal(
    fakeBotApi.messages.at(-1).text,
    `Reset current chat to config defaults. Started a new session with workdir ${nextWorkdir}, auto medium, model default, reasoning effort high.`
  );
});
