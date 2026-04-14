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
        allowedUsernames: ["@AllowedUser"]
      }
    ]
  });

  assert.equal(config.bots[0].name, "primary");
  assert.deepEqual(config.bots[0].allowedUsernames, ["owneruser", "alloweduser"]);
});

test("normalizeConfig allows empty allowed usernames by default", () => {
  const config = normalizeConfig({
    bots: [
      {
        name: "primary",
        token: "token-1"
      }
    ]
  });

  assert.deepEqual(config.bots[0].allowedUsernames, []);
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
