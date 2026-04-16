import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { normalizeBotAuto } from "./auto-mode.js";
import {
  normalizeBotModel,
  normalizeBotReasoningEffort
} from "./runtime-settings.js";
import { normalizeBotSchedules } from "./schedules.js";
import {
  DEFAULT_CONFIG_PATH,
  DEFAULT_STATE_PATH,
  normalizeTelegramUsername
} from "./utils.js";

function assertArrayOfStrings(value, fieldPath) {
  if (!Array.isArray(value)) {
    throw new Error(`${fieldPath} must be an array of strings`);
  }

  for (const entry of value) {
    if (typeof entry !== "string") {
      throw new Error(`${fieldPath} must contain only strings`);
    }
  }
}

function normalizeAllowedUsernames(value, fieldPath) {
  const usernames = value ?? [];
  assertArrayOfStrings(usernames, fieldPath);
  return usernames.map(normalizeTelegramUsername).filter(Boolean);
}

export function normalizeConfig(rawConfig, configPath = DEFAULT_CONFIG_PATH) {
  if (!rawConfig || typeof rawConfig !== "object" || Array.isArray(rawConfig)) {
    throw new Error("Config root must be a JSON object");
  }

  if (!Array.isArray(rawConfig.bots) || rawConfig.bots.length === 0) {
    throw new Error("Config must include a non-empty bots array");
  }

  const defaultAllowedUsernames = normalizeAllowedUsernames(
    rawConfig.allowedUsernames,
    "allowedUsernames"
  );
  const botNames = new Set();
  const normalizedBots = rawConfig.bots.map((bot, index) => {
    const prefix = `bots[${index}]`;
    if (!bot || typeof bot !== "object" || Array.isArray(bot)) {
      throw new Error(`${prefix} must be an object`);
    }

    if (typeof bot.name !== "string" || !bot.name.trim()) {
      throw new Error(`${prefix}.name must be a non-empty string`);
    }
    const name = bot.name.trim();
    if (!/^[A-Za-z0-9_-]+$/.test(name)) {
      throw new Error(`${prefix}.name must contain only letters, numbers, "_" or "-"`);
    }
    if (botNames.has(name)) {
      throw new Error(`Duplicate bot name: ${name}`);
    }
    botNames.add(name);

    if (typeof bot.token !== "string" || !bot.token.trim()) {
      throw new Error(`${prefix}.token must be a non-empty string`);
    }

    const workdir = path.resolve(bot.workdir ?? os.homedir());
    if (!existsSync(workdir)) {
      throw new Error(`${prefix}.workdir must point to an existing path`);
    }
    const allowedUsernames = normalizeAllowedUsernames(
      bot.allowedUsernames,
      `${prefix}.allowedUsernames`
    );
    const auto = normalizeBotAuto(bot, prefix);
    const schedules = normalizeBotSchedules(bot.schedules, `${prefix}.schedules`);

    return {
      name,
      token: bot.token.trim(),
      workdir,
      allowedUsernames: [...new Set([...defaultAllowedUsernames, ...allowedUsernames])],
      schedules,
      auto,
      model: normalizeBotModel(bot, prefix),
      reasoningEffort: normalizeBotReasoningEffort(bot, prefix)
    };
  });

  return {
    configPath: path.resolve(configPath),
    statePath: path.resolve(rawConfig.statePath ?? DEFAULT_STATE_PATH),
    bots: normalizedBots
  };
}

export async function loadConfig(configPath = DEFAULT_CONFIG_PATH) {
  let content;
  try {
    content = await fs.readFile(configPath, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      throw new Error(
        `Config file not found at ${configPath}. Create it with a bots array before starting the relay.`
      );
    }
    throw error;
  }

  let rawConfig;
  try {
    rawConfig = JSON.parse(content);
  } catch (error) {
    throw new Error(`Failed to parse config JSON at ${configPath}: ${error.message}`);
  }

  return normalizeConfig(rawConfig, configPath);
}
