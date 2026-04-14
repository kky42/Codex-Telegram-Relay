import test from "node:test";
import assert from "node:assert/strict";

import { normalizeConfig } from "../src/config.js";

test("normalizeConfig applies defaults and normalizes usernames", () => {
  const config = normalizeConfig({
    bots: [
      {
        name: "primary",
        token: "token-1",
        allowedUsernames: ["@AllowedUser"],
        codexArgs: ["--search"]
      }
    ]
  });

  assert.equal(config.bots[0].name, "primary");
  assert.equal(config.bots[0].runningIndicator, "typing");
  assert.equal(config.bots[0].allowedUsernames[0], "alloweduser");
  assert.deepEqual(config.bots[0].allowedUserIds, []);
  assert.deepEqual(config.bots[0].codexArgs, ["--search"]);
});

test("normalizeConfig rejects bots without authorization rules", () => {
  assert.throws(
    () =>
      normalizeConfig({
        bots: [
          {
            name: "primary",
            token: "token-1"
          }
        ]
      }),
    /at least one allowed username or allowed user id/
  );
});
