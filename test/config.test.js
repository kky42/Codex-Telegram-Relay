import test from "node:test";
import assert from "node:assert/strict";

import { normalizeConfig } from "../src/config.js";

test("normalizeConfig applies top-level allowed usernames and normalizes usernames", () => {
  const config = normalizeConfig({
    allowedUsernames: ["@OwnerUser"],
    bots: [
      {
        name: "primary",
        token: "token-1",
        allowedUsernames: ["@AllowedUser"],
        yolo: true
      }
    ]
  });

  assert.equal(config.bots[0].name, "primary");
  assert.deepEqual(config.bots[0].allowedUsernames, ["owneruser", "alloweduser"]);
  assert.equal(config.bots[0].yolo, true);
  assert.equal(config.bots[0].model, "default");
  assert.equal(config.bots[0].reasoningEffort, "default");
  assert.deepEqual(config.bots[0].schedules, []);
});

test("normalizeConfig defaults yolo/model/reasoningEffort", () => {
  const config = normalizeConfig({
    bots: [
      {
        name: "primary",
        token: "token-1"
      }
    ]
  });

  assert.deepEqual(config.bots[0].allowedUsernames, []);
  assert.equal(config.bots[0].yolo, true);
  assert.equal(config.bots[0].model, "default");
  assert.equal(config.bots[0].reasoningEffort, "default");
});

test("normalizeConfig rejects invalid bot names", () => {
  assert.throws(
    () =>
      normalizeConfig({
        bots: [
          {
            name: "primary bot",
            token: "token-1"
          }
        ]
      }),
    /name must contain only letters, numbers, "_" or "-"/
  );
});

test("normalizeConfig rejects missing workdir paths", () => {
  assert.throws(
    () =>
      normalizeConfig({
        bots: [
          {
            name: "primary",
            token: "token-1",
            workdir: "/definitely/not/a/real/path"
          }
        ]
      }),
    /workdir must point to an existing path/
  );
});

test("normalizeConfig rejects non-boolean yolo values", () => {
  assert.throws(
    () =>
      normalizeConfig({
        bots: [
          {
            name: "primary",
            token: "token-1",
            yolo: "interactive"
          }
        ]
    }),
    /yolo must be a boolean/
  );
});

test("normalizeConfig accepts arbitrary model/reasoningEffort strings", () => {
  const config = normalizeConfig({
    bots: [
      {
        name: "primary",
        token: "token-1",
        model: "my-model-v0",
        reasoningEffort: "ultra-custom"
      }
    ]
  });

  assert.equal(config.bots[0].model, "my-model-v0");
  assert.equal(config.bots[0].reasoningEffort, "ultra-custom");
});

test("normalizeConfig includes normalized schedules", () => {
  const config = normalizeConfig({
    bots: [
      {
        name: "primary",
        token: "token-1",
        schedules: [
          {
            name: "daily-report",
            cron: "0 9 * * 1-5",
            prompt: "summarize",
            chatId: 1001
          }
        ]
      }
    ]
  });

  assert.deepEqual(config.bots[0].schedules, [
    {
      name: "daily-report",
      cron: "0 9 * * 1-5",
      prompt: "summarize",
      chatId: 1001,
      enabled: true
    }
  ]);
});
