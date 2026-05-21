import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import {
  addAgentConfig,
  buildCanonicalAgentConfig
} from "../src/config-scaffold.js";
import { main } from "../src/cli.js";

test("buildCanonicalAgentConfig includes required profile defaults", () => {
  const workdir = path.resolve("/Users/example");

  assert.deepEqual(
    buildCanonicalAgentConfig({
      cli: "codex",
      workdir: "/Users/example"
    }),
    {
      profile: {
        cli: "codex",
        workdir,
        auto: "medium",
        model: "default",
        reasoningEffort: "default"
      },
      bindings: {
        telegram: {
          allowedUsernames: ["your-telegram-username"],
          groupHistory: {
            hours: 24,
            messages: 1000
          },
          bots: []
        },
        mattermost: {
          allowedUsernames: ["your-mattermost-username"],
          groupHistory: {
            hours: 24,
            messages: 1000
          },
          bots: []
        },
      }
    }
  );
});

test("addAgentConfig creates an agent directory with canonical config", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "anyagent-add-"));
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "anyagent-home-"));

  const result = await addAgentConfig({
    agentId: "primary",
    cli: "claude",
    configPath: tempDir,
    homeDir
  });

  assert.equal(result.agentId, "primary");
  assert.equal(result.cli, "claude");
  assert.equal(result.agentDir, path.join(tempDir, "primary"));
  assert.equal(result.configFilePath, path.join(tempDir, "primary", "config.json"));

  const config = JSON.parse(await fs.readFile(result.configFilePath, "utf8"));
  assert.equal(config.profile.cli, "claude");
  assert.equal(config.profile.workdir, homeDir);
  assert.equal(config.profile.auto, "medium");
  assert.equal(config.profile.model, "default");
  assert.equal(config.profile.reasoningEffort, "default");
  assert.deepEqual(config.bindings.telegram.bots, []);
  assert.deepEqual(config.bindings.mattermost.bots, []);
});

test("addAgentConfig refuses duplicate agent directories", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "anyagent-add-"));
  await addAgentConfig({
    agentId: "primary",
    cli: "codex",
    configPath: tempDir
  });

  await assert.rejects(
    () =>
      addAgentConfig({
        agentId: "primary",
        cli: "codex",
        configPath: tempDir
      }),
    /Agent directory already exists/
  );
});

test("anyagent add creates an agent config through the CLI", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "anyagent-cli-add-"));
  const writes = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = function write(chunk, ...args) {
    writes.push(String(chunk));
    if (typeof args.at(-1) === "function") {
      args.at(-1)();
    }
    return true;
  };

  try {
    await main(["--config", tempDir, "add", "main", "pi"]);
  } finally {
    process.stdout.write = originalWrite;
  }

  const configPath = path.join(tempDir, "main", "config.json");
  const config = JSON.parse(await fs.readFile(configPath, "utf8"));
  assert.equal(config.profile.cli, "pi");
  assert.equal(config.profile.workdir, os.homedir());
  assert.match(writes.join(""), /Created agent "main"/);
});
