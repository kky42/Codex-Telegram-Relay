import test from "node:test";
import assert from "node:assert/strict";

import { TelegramBotApi } from "../src/telegram-api.js";

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
