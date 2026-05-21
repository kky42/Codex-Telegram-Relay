import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import {
  loadConfig,
  findChatBindingConfig,
  findMattermostBotConfig,
  findTelegramBotConfig
} from "../src/config.js";

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
  assert.equal(config.telegramBots[0].bindingId, "relaybot");
  assert.deepEqual(config.telegramBots[0].allowedUsernames, ["owneruser", "alloweduser"]);
  assert.deepEqual(config.telegramBots[0].groupHistory, { hours: 24, messages: 1000 });
  assert.equal(config.telegramBots[0].agent.id, "primary");
  assert.equal(config.telegramBots[0].agent.workdir, workdir);
  assert.equal(config.chatBindings.length, 1);
  assert.equal(config.chatBindings[0], config.telegramBots[0]);

  const botConfig = findTelegramBotConfig(config, { agentId: "primary", username: "@RelayBot" });
  assert.equal(botConfig?.username, "relaybot");
  const bindingConfig = findChatBindingConfig(config, {
    platform: "telegram",
    agentId: "primary",
    bindingId: "@RelayBot"
  });
  assert.equal(bindingConfig?.bindingId, "relaybot");
});

test("loadConfig accepts telegram group history settings", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "anyagent-config-"));
  const workdir = await fs.mkdtemp(path.join(os.tmpdir(), "anyagent-workdir-"));

  await writeAgentConfig(tempDir, "primary", {
    profile: {
      cli: "codex",
      workdir
    },
    bindings: {
      telegram: {
        groupHistory: {
          hours: 6,
          messages: 50
        },
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
  assert.deepEqual(config.telegramBots[0].groupHistory, { hours: 6, messages: 50 });
});

test("loadConfig loads mattermost bindings", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "anyagent-config-"));
  const workdir = await fs.mkdtemp(path.join(os.tmpdir(), "anyagent-workdir-"));

  await writeAgentConfig(tempDir, "primary", {
    profile: {
      cli: "codex",
      workdir
    },
    bindings: {
      mattermost: {
        allowedUsernames: ["@OwnerUser"],
        groupHistory: {
          hours: 12,
          messages: 75
        },
        bots: [
          {
            serverUrl: "http://localhost:8065/",
            username: "@RelayBot",
            token: "token-1",
            allowedUsernames: ["@Allowed.User"]
          }
        ]
      }
    }
  });

  const config = await loadConfig(tempDir);
  assert.equal(config.telegramBots.length, 0);
  assert.equal(config.mattermostBots.length, 1);
  assert.equal(config.mattermostBots[0].platform, "mattermost");
  assert.equal(config.mattermostBots[0].serverUrl, "http://localhost:8065");
  assert.equal(config.mattermostBots[0].username, "relaybot");
  assert.equal(config.mattermostBots[0].bindingId, "localhost:8065:relaybot");
  assert.deepEqual(config.mattermostBots[0].allowedUsernames, ["owneruser", "allowed.user"]);
  assert.deepEqual(config.mattermostBots[0].groupHistory, { hours: 12, messages: 75 });
  assert.equal(config.mattermostBots[0].agent.workdir, workdir);
  assert.equal(config.chatBindings[0], config.mattermostBots[0]);

  const botConfig = findMattermostBotConfig(config, {
    agentId: "primary",
    bindingId: "localhost:8065:relaybot"
  });
  assert.equal(botConfig?.username, "relaybot");
  const bindingConfig = findChatBindingConfig(config, {
    platform: "mattermost",
    agentId: "primary",
    bindingId: "localhost:8065:relaybot"
  });
  assert.equal(bindingConfig?.bindingId, "localhost:8065:relaybot");
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

test("loadConfig rejects missing workdir values", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "anyagent-config-"));

  await writeAgentConfig(tempDir, "primary", {
    profile: {
      cli: "codex"
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

  await assert.rejects(() => loadConfig(tempDir), /profile\.workdir must be a non-empty string/);
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

  await assert.rejects(() => loadConfig(tempDir), /profile.workdir must point to an existing directory/);
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

test("loadConfig rejects duplicate Mattermost binding ids", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "anyagent-config-"));
  const workdirA = await fs.mkdtemp(path.join(os.tmpdir(), "anyagent-workdir-a-"));
  const workdirB = await fs.mkdtemp(path.join(os.tmpdir(), "anyagent-workdir-b-"));

  await writeAgentConfig(tempDir, "primary", {
    profile: { cli: "codex", workdir: workdirA },
    bindings: {
      mattermost: {
        bots: [
          {
            serverUrl: "http://localhost:8065",
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
      mattermost: {
        bots: [
          {
            serverUrl: "http://localhost:8065/",
            username: "@RelayBot",
            token: "token-2"
          }
        ]
      }
    }
  });

  await assert.rejects(
    () => loadConfig(tempDir),
    /Duplicate chat binding: mattermost:localhost:8065:relaybot/
  );
});
