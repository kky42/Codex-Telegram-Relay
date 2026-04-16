import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { TelegramBotApi, TelegramApiError } from "../src/telegram-api.js";

test("editMessageText sends the Telegram edit payload", async () => {
  const calls = [];
  const api = new TelegramBotApi("token", async (url, options) => {
    calls.push({
      url,
      payload: JSON.parse(options.body)
    });

    return {
      ok: true,
      async json() {
        return {
          ok: true,
          result: { message_id: 7 }
        };
      }
    };
  });

  const result = await api.editMessageText({
    chatId: 1001,
    messageId: 7,
    text: "hello",
    parseMode: "MarkdownV2"
  });

  assert.deepEqual(calls, [
    {
      url: "https://api.telegram.org/bottoken/editMessageText",
      payload: {
        chat_id: 1001,
        message_id: 7,
        text: "hello",
        disable_web_page_preview: true,
        parse_mode: "MarkdownV2"
      }
    }
  ]);
  assert.deepEqual(result, { message_id: 7 });
});

test("getFile sends the Telegram getFile payload", async () => {
  const calls = [];
  const api = new TelegramBotApi("token", async (url, options) => {
    calls.push({
      url,
      payload: JSON.parse(options.body)
    });

    return {
      ok: true,
      async json() {
        return {
          ok: true,
          result: { file_id: "file-1", file_path: "documents/test.pdf" }
        };
      }
    };
  });

  const result = await api.getFile("file-1");

  assert.deepEqual(calls, [
    {
      url: "https://api.telegram.org/bottoken/getFile",
      payload: {
        file_id: "file-1"
      }
    }
  ]);
  assert.deepEqual(result, { file_id: "file-1", file_path: "documents/test.pdf" });
});

test("downloadFile streams binary responses", async () => {
  const api = new TelegramBotApi("token", async (url) => {
    assert.equal(url, "https://api.telegram.org/file/bottoken/documents/test.pdf");

    return {
      ok: true,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(Buffer.from("hello ")));
          controller.enqueue(new Uint8Array(Buffer.from("world")));
          controller.close();
        }
      })
    };
  });

  const buffer = await api.downloadFile("documents/test.pdf");

  assert.equal(buffer.toString("utf8"), "hello world");
});

test("downloadFile rejects files that exceed the configured byte limit", async () => {
  const api = new TelegramBotApi("token", async () => ({
    ok: true,
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(Buffer.from("toolarge")));
        controller.close();
      }
    })
  }));

  await assert.rejects(
    () => api.downloadFile("documents/test.pdf", { maxBytes: 4 }),
    (error) => error instanceof TelegramApiError && error.errorCode === 413
  );
});

test("deleteMessage sends the Telegram delete payload", async () => {
  const calls = [];
  const api = new TelegramBotApi("token", async (url, options) => {
    calls.push({
      url,
      payload: JSON.parse(options.body)
    });

    return {
      ok: true,
      async json() {
        return {
          ok: true,
          result: true
        };
      }
    };
  });

  const result = await api.deleteMessage({
    chatId: 1001,
    messageId: 7
  });

  assert.deepEqual(calls, [
    {
      url: "https://api.telegram.org/bottoken/deleteMessage",
      payload: {
        chat_id: 1001,
        message_id: 7
      }
    }
  ]);
  assert.equal(result, true);
});

test("sendLocalAttachment uploads a multipart Telegram payload", async () => {
  const workdir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-telegram-relay-telegram-api-"));
  const filePath = path.join(workdir, "report.pdf");
  await fs.writeFile(filePath, "pdf", "utf8");

  const calls = [];
  const api = new TelegramBotApi("token", async (url, options) => {
    calls.push({
      url,
      body: options.body
    });

    return {
      ok: true,
      async json() {
        return {
          ok: true,
          result: { message_id: 9 }
        };
      }
    };
  });

  const result = await api.sendLocalAttachment({
    chatId: 1001,
    kind: "document",
    filePath,
    fileName: "daily-report.pdf"
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.telegram.org/bottoken/sendDocument");
  assert.equal(calls[0].body.get("chat_id"), "1001");
  const uploaded = calls[0].body.get("document");
  assert.equal(uploaded.name, "daily-report.pdf");
  assert.equal(Buffer.from(await uploaded.arrayBuffer()).toString("utf8"), "pdf");
  assert.deepEqual(result, { message_id: 9 });
});
