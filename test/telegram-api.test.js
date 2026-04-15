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
