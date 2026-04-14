import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { ConfigStore } from "../src/config-store.js";

test("ConfigStore patches target bot defaults in config.json", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-telegram-relay-config-store-"));
  const configPath = path.join(tempDir, "config.json");
  await fs.writeFile(
    configPath,
    JSON.stringify(
      {
        bots: [
          {
            name: "primary",
            token: "token-1",
            yolo: true,
            model: "default",
            reasoningEffort: "default"
          },
          {
            name: "secondary",
            token: "token-2",
            yolo: true,
            model: "default",
            reasoningEffort: "default"
          }
        ]
      },
      null,
      2
    ),
    "utf8"
  );

  const configStore = new ConfigStore(configPath);
  await configStore.patchBotConfig("primary", {
    yolo: false,
    model: "gpt-5.4",
    reasoningEffort: "high"
  });

  const updated = JSON.parse(await fs.readFile(configPath, "utf8"));
  assert.deepEqual(updated.bots[0], {
    name: "primary",
    token: "token-1",
    yolo: false,
    model: "gpt-5.4",
    reasoningEffort: "high"
  });
  assert.deepEqual(updated.bots[1], {
    name: "secondary",
    token: "token-2",
    yolo: true,
    model: "default",
    reasoningEffort: "default"
  });
});
