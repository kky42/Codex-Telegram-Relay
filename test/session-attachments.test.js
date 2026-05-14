import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { buildChatCacheDirName } from "../src/utils.js";
import { createSession } from "./support/builders.js";

test("session stages photo attachments and passes path references to Codex", async () => {
  const { session, fakeBotApi, runnerFactory, cacheRootDir } = await createSession();
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
  assert.match(
    runnerFactory.runs[0].params.message,
    new RegExp(
      `path="${path.join(cacheRootDir, "telegram", "relaybot", buildChatCacheDirName(1001)).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`
    )
  );
  assert.match(runnerFactory.runs[0].params.message, /msg11\.jpg" kind="photo"/);
  assert.equal(
    await fs.readFile(path.join(cacheRootDir, "telegram", "relaybot", buildChatCacheDirName(1001), "msg11.jpg"), "utf8"),
    "jpg"
  );
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
  assert.match(runnerFactory.runs[0].params.message, /<attachment path=".*msg12\.jpg" kind="photo" \/>/);
});

test("session builds attachment prompts for path-based files", async () => {
  const { session, fakeBotApi, runnerFactory } = await createSession();
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
  assert.match(runnerFactory.runs[0].params.message, /<attachment path=".*msg21\.pdf" kind="document" \/>/);
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
