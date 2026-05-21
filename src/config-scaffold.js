import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { AUTO_DEFAULT } from "./auto-mode.js";
import { SUPPORTED_AGENT_CLIS } from "./cli_adapter/index.js";
import {
  DEFAULT_CONFIG_PATH,
  ensureDir,
  normalizeAgentId,
  writeJsonFileAtomic
} from "./utils.js";
import {
  DEFAULT_MODEL,
  DEFAULT_REASONING_EFFORT
} from "./runtime-settings.js";
import {
  DEFAULT_GROUP_HISTORY_HOURS,
  DEFAULT_GROUP_HISTORY_MESSAGES
} from "./chat_adapter/common/group-history-defaults.js";

const SUPPORTED_AGENT_CLI_SET = new Set(SUPPORTED_AGENT_CLIS);

async function pathExists(filePath) {
  try {
    await fs.stat(filePath);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function normalizeCliName(value) {
  const cli = String(value ?? "").trim().toLowerCase();
  if (!SUPPORTED_AGENT_CLI_SET.has(cli)) {
    throw new Error(`cli-name must be one of: ${SUPPORTED_AGENT_CLIS.join(", ")}`);
  }
  return cli;
}

export function buildCanonicalAgentConfig({ cli, workdir = os.homedir() }) {
  return {
    profile: {
      cli: normalizeCliName(cli),
      workdir: path.resolve(workdir),
      auto: AUTO_DEFAULT,
      model: DEFAULT_MODEL,
      reasoningEffort: DEFAULT_REASONING_EFFORT
    },
    bindings: {
      telegram: {
        allowedUsernames: ["your-telegram-username"],
        groupHistory: {
          hours: DEFAULT_GROUP_HISTORY_HOURS,
          messages: DEFAULT_GROUP_HISTORY_MESSAGES
        },
        bots: []
      },
      mattermost: {
        allowedUsernames: ["your-mattermost-username"],
        groupHistory: {
          hours: DEFAULT_GROUP_HISTORY_HOURS,
          messages: DEFAULT_GROUP_HISTORY_MESSAGES
        },
        bots: []
      }
    }
  };
}

export async function addAgentConfig({
  agentId,
  cli,
  configPath = DEFAULT_CONFIG_PATH,
  homeDir = os.homedir()
}) {
  const normalizedAgentId = normalizeAgentId(agentId, "agent-name");
  const normalizedCli = normalizeCliName(cli);
  const agentsRoot = path.resolve(configPath);
  if (path.basename(agentsRoot) === "config.json") {
    throw new Error("anyagent add requires --config to point to an agents directory.");
  }

  const agentDir = path.join(agentsRoot, normalizedAgentId);
  const configFilePath = path.join(agentDir, "config.json");
  if (await pathExists(agentDir)) {
    throw new Error(`Agent directory already exists: ${agentDir}`);
  }

  await ensureDir(agentDir);
  await writeJsonFileAtomic(
    configFilePath,
    buildCanonicalAgentConfig({
      cli: normalizedCli,
      workdir: homeDir
    })
  );

  return {
    agentId: normalizedAgentId,
    cli: normalizedCli,
    agentDir,
    configFilePath
  };
}
