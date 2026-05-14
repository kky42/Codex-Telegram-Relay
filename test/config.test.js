import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { loadConfig, findTelegramBotConfig } from "../src/config.js";

async function writeAgentConfig(rootDir, agentId, config) {
  const agentDir = path.join(rootDir, agentId);
  await fs.mkdir(agentDir, { recursive: true });
  await fs.writeFile(path.join(agentDir, "config.json"), JSON.stringify(config, null, 2));
  return agentDir;
}

test("loadConfig loads agent profiles and telegram bindings", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "anyagent-config-"));
  const workdir = await fs.mkdtemp(path.join(os.tmpdir(), "anyagent-workdir-"));

  await writeAgentConfig(tempDir, "primary", {
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
            username: "@RelayBot",
            token: "token-1",
            allowedUsernames: ["@AllowedUser"]
          }
        ]
      }
    }
  });

  const config = await loadConfig(tempDir);
  assert.equal(config.agents.length, 1);
  assert.equal(config.agents[0].id, "primary");
  assert.equal(config.agents[0].cli, "codex");
  assert.equal(config.agents[0].workdir, workdir);
  assert.equal(config.agents[0].auto, "high");
  assert.equal(config.agents[0].model, "default");
  assert.equal(config.agents[0].reasoningEffort, "default");

  assert.equal(config.telegramBots.length, 1);
  assert.equal(config.telegramBots[0].username, "relaybot");
  assert.deepEqual(config.telegramBots[0].allowedUsernames, ["owneruser", "alloweduser"]);
  assert.equal(config.telegramBots[0].agent.id, "primary");
  assert.equal(config.telegramBots[0].agent.workdir, workdir);

  const botConfig = findTelegramBotConfig(config, { agentId: "primary", username: "@RelayBot" });
  assert.equal(botConfig?.username, "relaybot");
});

test("loadConfig accepts Claude agent profiles", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "anyagent-config-"));
  const workdir = await fs.mkdtemp(path.join(os.tmpdir(), "anyagent-workdir-"));

  await writeAgentConfig(tempDir, "primary", {
    profile: {
      cli: "claude",
      workdir
    },
    bindings: {
      telegram: {
        bots: [
          {
            username: "RelayBot",
            token: "token-1"
          }
        ]
      }
    }
  });

  const config = await loadConfig(tempDir);
  assert.equal(config.agents[0].cli, "claude");
  assert.equal(config.agents[0].workdir, workdir);
  assert.equal(config.telegramBots[0].agent.cli, "claude");
});

test("loadConfig accepts Pi agent profiles", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "anyagent-config-"));
  const workdir = await fs.mkdtemp(path.join(os.tmpdir(), "anyagent-workdir-"));

  await writeAgentConfig(tempDir, "primary", {
    profile: {
      cli: "pi",
      workdir
    },
    bindings: {
      telegram: {
        bots: [
          {
            username: "RelayBot",
            token: "token-1"
          }
        ]
      }
    }
  });

  const config = await loadConfig(tempDir);
  assert.equal(config.agents[0].cli, "pi");
  assert.equal(config.agents[0].workdir, workdir);
  assert.equal(config.telegramBots[0].agent.cli, "pi");
});

test("loadConfig defaults profile values", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "anyagent-config-"));
  const workdir = await fs.mkdtemp(path.join(os.tmpdir(), "anyagent-workdir-"));

  await writeAgentConfig(tempDir, "primary", {
    profile: {
      cli: "codex",
      workdir
    },
    bindings: {
      telegram: {
        bots: [
          {
            username: "RelayBot",
            token: "token-1"
          }
        ]
      }
    }
  });

  const config = await loadConfig(tempDir);
  assert.equal(config.agents[0].auto, "medium");
  assert.equal(config.agents[0].model, "default");
  assert.equal(config.agents[0].reasoningEffort, "default");
  assert.deepEqual(config.telegramBots[0].allowedUsernames, []);
});

test("loadConfig rejects missing workdir paths", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "anyagent-config-"));

  await writeAgentConfig(tempDir, "primary", {
    profile: {
      cli: "codex",
      workdir: "/definitely/not/a/real/path"
    },
    bindings: {
      telegram: {
        bots: [
          {
            username: "RelayBot",
            token: "token-1"
          }
        ]
      }
    }
  });

  await assert.rejects(() => loadConfig(tempDir), /profile.workdir must point to an existing path/);
});

test("loadConfig rejects unsupported agent cli values", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "anyagent-config-"));
  const workdir = await fs.mkdtemp(path.join(os.tmpdir(), "anyagent-workdir-"));

  await writeAgentConfig(tempDir, "primary", {
    profile: {
      cli: "unknown-cli",
      workdir
    },
    bindings: {
      telegram: {
        bots: [
          {
            username: "RelayBot",
            token: "token-1"
          }
        ]
      }
    }
  });

  await assert.rejects(() => loadConfig(tempDir), /profile\.cli must be one of: codex, claude, pi/);
});

test("loadConfig rejects duplicate Telegram bot usernames", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "anyagent-config-"));
  const workdirA = await fs.mkdtemp(path.join(os.tmpdir(), "anyagent-workdir-a-"));
  const workdirB = await fs.mkdtemp(path.join(os.tmpdir(), "anyagent-workdir-b-"));

  await writeAgentConfig(tempDir, "primary", {
    profile: { cli: "codex", workdir: workdirA },
    bindings: {
      telegram: {
        bots: [
          {
            username: "RelayBot",
            token: "token-1"
          }
        ]
      }
    }
  });
  await writeAgentConfig(tempDir, "secondary", {
    profile: { cli: "codex", workdir: workdirB },
    bindings: {
      telegram: {
        bots: [
          {
            username: "@RelayBot",
            token: "token-2"
          }
        ]
      }
    }
  });

  await assert.rejects(() => loadConfig(tempDir), /Duplicate Telegram bot username: relaybot/);
});
