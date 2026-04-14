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
});

test("normalizeConfig defaults yolo to false", () => {
  const config = normalizeConfig({
    bots: [
      {
        name: "primary",
        token: "token-1"
      }
    ]
  });

  assert.deepEqual(config.bots[0].allowedUsernames, []);
  assert.equal(config.bots[0].yolo, false);
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
