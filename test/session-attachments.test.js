import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { buildCacheScope } from "../src/chat_adapter/common/cache-scope.js";
import { createSession } from "./support/builders.js";

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function telegramScope(cacheRootDir, { agentId = "primary-agent", botUsername = "relaybot", chatId = 1001 } = {}) {
  return buildCacheScope({
    cacheRootDir,
    agentId,
    platform: "telegram",
    bindingId: botUsername,
    conversationId: chatId
  });
}

test("session stages photo attachments and passes path references to Codex", async () => {
  const { session, fakeBotApi, runnerFactory, cacheRootDir } = await createSession();
  const scope = telegramScope(cacheRootDir);
  fakeBotApi.registerFile("photo-1", {
    filePath: "photos/input.jpg",
    body: Buffer.from("jpg")
  });

  await session.handleAttachmentMessages([
    {
      message_id: 11,
      photo: [
        { file_id: "photo-small", file_unique_id: "small", file_size: 1, width: 10, height: 10 },
        { file_id: "photo-1", file_unique_id: "large", file_size: 3, width: 100, height: 100 }
      ]
    }
  ]);

  assert.equal(runnerFactory.runs.length, 1);
  assert.deepEqual(fakeBotApi.getFileCalls, ["photo-1"]);
  assert.equal("imagePaths" in runnerFactory.runs[0].params, false);
  assert.match(runnerFactory.runs[0].params.message, /<attachments>/);
  assert.match(scope.scopeHash, /^[a-f0-9]{8}$/);
  assert.match(
    runnerFactory.runs[0].params.message,
    new RegExp(`path="${escapeRegExp(scope.scopeDir)}`)
  );
  assert.match(runnerFactory.runs[0].params.message, /photo--m11\.jpg" kind="photo"/);
  assert.equal(
    await fs.readFile(path.join(scope.scopeDir, "photo--m11.jpg"), "utf8"),
    "jpg"
  );
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(scope.scopeDir, "scope.json"), "utf8")), {
    agentId: "primary-agent",
    platform: "telegram",
    bindingId: "relaybot",
    conversationId: "1001",
    scopeKey: "primary-agent:telegram:relaybot:1001"
  });
});

test("Claude sessions pass photo attachments as prompt path references", async () => {
  const { session, fakeBotApi, runnerFactory } = await createSession({
    agent: {
      cli: "claude"
    }
  });
  fakeBotApi.registerFile("photo-1", {
    filePath: "photos/input.jpg",
    body: Buffer.from("jpg")
  });

  await session.handleAttachmentMessages([
    {
      message_id: 12,
      caption: "inspect",
      photo: [
        { file_id: "photo-1", file_unique_id: "large", file_size: 3, width: 100, height: 100 }
      ]
    }
  ]);

  assert.equal(runnerFactory.runs.length, 1);
  assert.equal("imagePaths" in runnerFactory.runs[0].params, false);
  assert.match(runnerFactory.runs[0].params.message, /inspect/);
  assert.match(runnerFactory.runs[0].params.message, /<attachments>/);
  assert.match(runnerFactory.runs[0].params.message, /<attachment path=".*photo--m12\.jpg" kind="photo" \/>/);
});

test("session builds attachment prompts for path-based files", async () => {
  const { session, fakeBotApi, runnerFactory, cacheRootDir } = await createSession();
  const scope = telegramScope(cacheRootDir);
  fakeBotApi.registerFile("doc-1", {
    filePath: "documents/spec.pdf",
    body: Buffer.from("pdf-bytes")
  });

  await session.handleAttachmentMessages([
    {
      message_id: 21,
      caption: "review this",
      document: {
        file_id: "doc-1",
        file_unique_id: "doc-unique-1",
        file_name: "spec.pdf",
        mime_type: "application/pdf",
        file_size: 9
      }
    }
  ]);

  assert.equal(runnerFactory.runs.length, 1);
  assert.equal("imagePaths" in runnerFactory.runs[0].params, false);
  assert.match(runnerFactory.runs[0].params.message, /review this/);
  assert.match(runnerFactory.runs[0].params.message, /<attachments>/);
  assert.match(runnerFactory.runs[0].params.message, /<attachment path=".*spec--m21\.pdf" kind="document" \/>/);
  assert.equal(await fs.readFile(path.join(scope.scopeDir, "spec--m21.pdf"), "utf8"), "pdf-bytes");
});

test("session appends a suffix when a scoped attachment filename already exists", async () => {
  const { session, fakeBotApi, cacheRootDir } = await createSession();
  const scope = telegramScope(cacheRootDir);
  fakeBotApi.registerFile("doc-1", {
    filePath: "documents/spec.pdf",
    body: Buffer.from("first")
  });
  fakeBotApi.registerFile("doc-2", {
    filePath: "documents/spec-again.pdf",
    body: Buffer.from("second")
  });

  await session.handleAttachmentMessages([
    {
      message_id: 21,
      document: {
        file_id: "doc-1",
        file_unique_id: "doc-unique-1",
        file_name: "spec.pdf",
        file_size: 5
      }
    }
  ]);
  await session.handleAttachmentMessages([
    {
      message_id: 21,
      document: {
        file_id: "doc-2",
        file_unique_id: "doc-unique-2",
        file_name: "spec.pdf",
        file_size: 6
      }
    }
  ]);

  assert.equal(await fs.readFile(path.join(scope.scopeDir, "spec--m21.pdf"), "utf8"), "first");
  assert.equal(await fs.readFile(path.join(scope.scopeDir, "spec--m21-2.pdf"), "utf8"), "second");
});

test("session sanitizes original attachment filenames before caching", async () => {
  const { session, fakeBotApi, runnerFactory, cacheRootDir } = await createSession();
  const scope = telegramScope(cacheRootDir);
  fakeBotApi.registerFile("doc-unsafe", {
    filePath: "documents/source.pdf",
    body: Buffer.from("safe")
  });

  await session.handleAttachmentMessages([
    {
      message_id: 41,
      document: {
        file_id: "doc-unsafe",
        file_unique_id: "doc-unsafe-unique",
        file_name: "../../Quarterly Report (final)!#.PDF",
        file_size: 4
      }
    }
  ]);

  assert.match(
    runnerFactory.runs[0].params.message,
    /<attachment path=".*Quarterly-Report-final--m41\.pdf" kind="document" \/>/
  );
  assert.equal(
    await fs.readFile(path.join(scope.scopeDir, "Quarterly-Report-final--m41.pdf"), "utf8"),
    "safe"
  );
});

test("session rejects oversized attachments before starting Codex", async () => {
  const { session, fakeBotApi, runnerFactory } = await createSession();
  fakeBotApi.registerFile("video-1", {
    filePath: "videos/demo.mp4",
    body: Buffer.from("small")
  });

  await session.handleAttachmentMessages([
    {
      message_id: 31,
      video: {
        file_id: "video-1",
        file_unique_id: "video-unique-1",
        file_name: "demo.mp4",
        file_size: 21 * 1024 * 1024
      }
    }
  ]);

  assert.equal(runnerFactory.runs.length, 0);
  assert.match(fakeBotApi.messages.at(-1).text, /20 MB limit/);
});
