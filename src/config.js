import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

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

export function normalizeConfig(rawConfig, configPath = DEFAULT_CONFIG_PATH) {
  if (!rawConfig || typeof rawConfig !== "object" || Array.isArray(rawConfig)) {
    throw new Error("Config root must be a JSON object");
  }

  if (!Array.isArray(rawConfig.bots) || rawConfig.bots.length === 0) {
    throw new Error("Config must include a non-empty bots array");
  }

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
    if (botNames.has(name)) {
      throw new Error(`Duplicate bot name: ${name}`);
    }
    botNames.add(name);

    if (typeof bot.token !== "string" || !bot.token.trim()) {
      throw new Error(`${prefix}.token must be a non-empty string`);
    }

    const allowedUsernames = bot.allowedUsernames ?? [];
    const allowedUserIds = bot.allowedUserIds ?? [];
    const codexArgs = bot.codexArgs ?? [];

    assertArrayOfStrings(allowedUsernames, `${prefix}.allowedUsernames`);
    assertArrayOfStrings(codexArgs, `${prefix}.codexArgs`);

    if (!Array.isArray(allowedUserIds)) {
      throw new Error(`${prefix}.allowedUserIds must be an array`);
    }

    const normalizedUserIds = allowedUserIds.map((value) => {
      const numberValue = Number(value);
      if (!Number.isInteger(numberValue)) {
        throw new Error(`${prefix}.allowedUserIds must contain only integer values`);
      }
      return numberValue;
    });

    if (normalizedUserIds.length === 0 && allowedUsernames.length === 0) {
      throw new Error(
        `${prefix} must define at least one allowed username or allowed user id`
      );
    }

    const runningIndicator = bot.runningIndicator ?? "typing";
    if (!["typing", "off"].includes(runningIndicator)) {
      throw new Error(`${prefix}.runningIndicator must be "typing" or "off"`);
    }

    const workdir = path.resolve(bot.workdir ?? os.homedir());

    return {
      name,
      token: bot.token.trim(),
      workdir,
      allowedUsernames: allowedUsernames.map(normalizeTelegramUsername).filter(Boolean),
      allowedUserIds: normalizedUserIds,
      codexArgs: codexArgs.map((entry) => entry.trim()).filter(Boolean),
      runningIndicator
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
