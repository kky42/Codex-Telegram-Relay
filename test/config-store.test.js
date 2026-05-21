import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { ConfigStore } from "../src/config-store.js";

test("ConfigStore reloads a telegram bot binding from config.json", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "anyagent-config-store-"));
  const agentsDir = path.join(tempDir, "agents");
  const workdir = await fs.mkdtemp(path.join(os.tmpdir(), "anyagent-workdir-"));
  await fs.mkdir(path.join(agentsDir, "primary"), { recursive: true });
  await fs.writeFile(
    path.join(agentsDir, "primary", "config.json"),
    JSON.stringify(
      {
        profile: {
          cli: "codex",
          workdir,
          auto: "high",
          model: "default",
          reasoningEffort: "default"
        },
        bindings: {
          telegram: {
            allowedUsernames: ["@OwnerUser"],
            bots: [
              {
                username: "RelayBot",
                token: "token-1",
                allowedUsernames: ["@AllowedUser"]
              }
            ]
          }
        }
      },
      null,
      2
    ),
    "utf8"
  );

  const configStore = new ConfigStore(agentsDir);
  const botConfig = await configStore.loadTelegramBotConfig({
    agentId: "primary",
    username: "relaybot"
  });

  assert.equal(botConfig.username, "relaybot");
  assert.equal(botConfig.agent.id, "primary");
  assert.equal(botConfig.agent.workdir, workdir);
  assert.deepEqual(botConfig.allowedUsernames, ["owneruser", "alloweduser"]);

  const bindingConfig = await configStore.loadChatBindingConfig({
    platform: "telegram",
    agentId: "primary",
    bindingId: "@RelayBot"
  });

  assert.equal(bindingConfig.platform, "telegram");
  assert.equal(bindingConfig.bindingId, "relaybot");
  assert.equal(bindingConfig.agent.id, "primary");
});

test("ConfigStore reloads a mattermost bot binding from config.json", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "anyagent-config-store-"));
  const agentsDir = path.join(tempDir, "agents");
  const workdir = await fs.mkdtemp(path.join(os.tmpdir(), "anyagent-workdir-"));
  await fs.mkdir(path.join(agentsDir, "primary"), { recursive: true });
  await fs.writeFile(
    path.join(agentsDir, "primary", "config.json"),
    JSON.stringify(
      {
        profile: {
          cli: "codex",
          workdir
        },
        bindings: {
          mattermost: {
            allowedUsernames: ["@OwnerUser"],
            bots: [
              {
                serverUrl: "http://localhost:8065",
                username: "RelayBot",
                token: "token-1",
                allowedUsernames: ["@AllowedUser"]
              }
            ]
          }
        }
      },
      null,
      2
    ),
    "utf8"
  );

  const configStore = new ConfigStore(agentsDir);
  const bindingConfig = await configStore.loadChatBindingConfig({
    platform: "mattermost",
    agentId: "primary",
    bindingId: "localhost:8065:relaybot"
  });

  assert.equal(bindingConfig.platform, "mattermost");
  assert.equal(bindingConfig.bindingId, "localhost:8065:relaybot");
  assert.equal(bindingConfig.serverUrl, "http://localhost:8065");
  assert.equal(bindingConfig.agent.id, "primary");
  assert.deepEqual(bindingConfig.allowedUsernames, ["owneruser", "alloweduser"]);
});
