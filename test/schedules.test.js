import test from "node:test";
import assert from "node:assert/strict";

import {
  cronMatchesDate,
  normalizeBotSchedules,
  parseCronExpression
} from "../src/schedules.js";

test("parseCronExpression accepts standard five-field cron syntax", () => {
  assert.ok(parseCronExpression("*/15 9-17 * * 1-5"));
});

test("cronMatchesDate matches weekday schedules", () => {
  assert.equal(
    cronMatchesDate("0 9 * * 1-5", new Date("2026-04-13T09:00:00")),
    true
  );
  assert.equal(
    cronMatchesDate("0 9 * * 1-5", new Date("2026-04-12T09:00:00")),
    false
  );
});

test("normalizeBotSchedules normalizes configured schedules", () => {
  const schedules = normalizeBotSchedules(
    [
      {
        name: "daily-report",
        auto: "medium",
        cron: "0 9 * * 1-5",
        prompt: "summarize repo changes",
        chatId: 123,
        enabled: false
      }
    ],
    "bots[0].schedules"
  );

  assert.deepEqual(schedules, [
    {
      name: "daily-report",
      auto: "medium",
      cron: "0 9 * * 1-5",
      prompt: "summarize repo changes",
      chatId: 123,
      enabled: false
    }
  ]);
});

test("normalizeBotSchedules rejects duplicate names in the same chat", () => {
  assert.throws(
    () =>
      normalizeBotSchedules(
        [
          {
            name: "daily-report",
            auto: "high",
            cron: "0 9 * * 1-5",
            prompt: "one",
            chatId: 123
          },
          {
            name: "Daily-Report",
            auto: "low",
            cron: "0 10 * * 1-5",
            prompt: "two",
            chatId: 123
          }
        ],
        "bots[0].schedules"
      ),
    /Duplicate schedule name/
  );
});
