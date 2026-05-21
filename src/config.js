import fs from "node:fs/promises";
import path from "node:path";

import { normalizeBotAuto } from "./auto-mode.js";
import { SUPPORTED_AGENT_CLIS } from "./cli_adapter/index.js";
import {
  normalizeBotModel,
  normalizeBotReasoningEffort
} from "./runtime-settings.js";
import {
  DEFAULT_CONFIG_PATH,
  expandWorkdirPath,
  normalizeAgentId,
  normalizeTelegramUsername
} from "./utils.js";
import {
  DEFAULT_GROUP_HISTORY_HOURS,
  DEFAULT_GROUP_HISTORY_MESSAGES
} from "./chat_adapter/telegram/group-history.js";

const SUPPORTED_AGENT_CLI_SET = new Set(SUPPORTED_AGENT_CLIS);

function assertObject(value, fieldPath) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${fieldPath} must be a JSON object`);
  }
}

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

function normalizeTelegramBotUsername(value, fieldPath) {
  const username = normalizeTelegramUsername(value);
  if (!username) {
    throw new Error(`${fieldPath} must be a non-empty Telegram bot username`);
  }
  if (!/^[a-z0-9_]+$/.test(username)) {
    throw new Error(`${fieldPath} must contain only letters, numbers, or "_"`);
  }
  return username;
}

function normalizePositiveInteger(value, fieldPath, defaultValue) {
  if (value === undefined) {
    return defaultValue;
  }

  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 1) {
    throw new Error(`${fieldPath} must be a positive integer`);
  }

  return normalized;
}

function normalizeGroupHistory(value, fieldPath) {
  if (value === undefined) {
    return {
      hours: DEFAULT_GROUP_HISTORY_HOURS,
      messages: DEFAULT_GROUP_HISTORY_MESSAGES
    };
  }

  assertObject(value, fieldPath);
  return {
    hours: normalizePositiveInteger(value.hours, `${fieldPath}.hours`, DEFAULT_GROUP_HISTORY_HOURS),
    messages: normalizePositiveInteger(
      value.messages,
      `${fieldPath}.messages`,
      DEFAULT_GROUP_HISTORY_MESSAGES
    )
  };
}

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

async function readJsonConfig(configPath) {
  let content;
  try {
    content = await fs.readFile(configPath, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      throw new Error(`Config file not found at ${configPath}.`);
    }
    throw error;
  }

  try {
    return JSON.parse(content);
  } catch (error) {
    throw new Error(`Failed to parse config JSON at ${configPath}: ${error.message}`);
  }
}

async function findAgentConfigFiles(configPath) {
  const resolvedPath = path.resolve(configPath);
  let stats;
  try {
    stats = await fs.stat(resolvedPath);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      throw new Error(`Agent config path not found at ${resolvedPath}.`);
    }
    throw error;
  }

  if (stats.isFile()) {
    return [
      {
        agentId: normalizeAgentId(path.basename(path.dirname(resolvedPath)), "agent id"),
        filePath: resolvedPath
      }
    ];
  }

  if (!stats.isDirectory()) {
    throw new Error(`Agent config path must be a directory or config.json file: ${resolvedPath}`);
  }

  const entries = await fs.readdir(resolvedPath, { withFileTypes: true });
  const configFiles = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) {
      continue;
    }

    const agentId = normalizeAgentId(entry.name, `agents/${entry.name}`);
    const filePath = path.join(resolvedPath, entry.name, "config.json");
    if (!(await pathExists(filePath))) {
      throw new Error(`Agent directory ${path.join(resolvedPath, entry.name)} must contain config.json`);
    }
    configFiles.push({ agentId, filePath });
  }

  if (configFiles.length > 0) {
    configFiles.sort((left, right) => left.agentId.localeCompare(right.agentId));
    return configFiles;
  }

  const directConfigPath = path.join(resolvedPath, "config.json");
  if (await pathExists(directConfigPath)) {
    return [
      {
        agentId: normalizeAgentId(path.basename(resolvedPath), "agent id"),
        filePath: directConfigPath
      }
    ];
  }

  if (configFiles.length === 0) {
    throw new Error(`No agent configs found under ${resolvedPath}.`);
  }
}

function normalizeAgentProfile(rawConfig, agentId, filePath) {
  assertObject(rawConfig.profile, `${filePath}.profile`);
  const profile = rawConfig.profile;

  if (typeof profile.cli !== "string" || !profile.cli.trim()) {
    throw new Error(`${filePath}.profile.cli must be a non-empty string`);
  }
  const cli = profile.cli.trim().toLowerCase();
  if (!SUPPORTED_AGENT_CLI_SET.has(cli)) {
    throw new Error(`${filePath}.profile.cli must be one of: ${SUPPORTED_AGENT_CLIS.join(", ")}`);
  }

  if (typeof profile.workdir !== "string" || !profile.workdir.trim()) {
    throw new Error(`${filePath}.profile.workdir must be a non-empty string`);
  }

  let workdir;
  try {
    workdir = expandWorkdirPath(profile.workdir);
  } catch {
    throw new Error(`${filePath}.profile.workdir must be an absolute path or ~/...`);
  }

  return {
    id: agentId,
    cli,
    workdir,
    auto: normalizeBotAuto(profile, `${filePath}.profile`),
    model: normalizeBotModel(profile, `${filePath}.profile`),
    reasoningEffort: normalizeBotReasoningEffort(profile, `${filePath}.profile`)
  };
}

async function normalizeAgentConfig({ agentId, filePath }) {
  const rawConfig = await readJsonConfig(filePath);
  assertObject(rawConfig, filePath);

  const agent = normalizeAgentProfile(rawConfig, agentId, filePath);
  try {
    const stats = await fs.stat(agent.workdir);
    if (!stats.isDirectory()) {
      throw new Error();
    }
  } catch {
    throw new Error(`${filePath}.profile.workdir must point to an existing directory`);
  }

  const bindings = rawConfig.bindings ?? {};
  assertObject(bindings, `${filePath}.bindings`);
  const telegram = bindings.telegram ?? null;
  const chatBindings = [];
  const telegramBots = [];

  if (telegram !== null) {
    assertObject(telegram, `${filePath}.bindings.telegram`);
    const defaultAllowedUsernames = normalizeAllowedUsernames(
      telegram.allowedUsernames,
      `${filePath}.bindings.telegram.allowedUsernames`
    );
    const bots = telegram.bots ?? [];
    if (!Array.isArray(bots)) {
      throw new Error(`${filePath}.bindings.telegram.bots must be an array`);
    }

    for (const [index, bot] of bots.entries()) {
      const prefix = `${filePath}.bindings.telegram.bots[${index}]`;
      assertObject(bot, prefix);
      const username = normalizeTelegramBotUsername(bot.username, `${prefix}.username`);
      if (typeof bot.token !== "string" || !bot.token.trim()) {
        throw new Error(`${prefix}.token must be a non-empty string`);
      }
      const allowedUsernames = normalizeAllowedUsernames(
        bot.allowedUsernames,
        `${prefix}.allowedUsernames`
      );
      const groupHistory = normalizeGroupHistory(
        bot.groupHistory ?? telegram.groupHistory,
        bot.groupHistory === undefined
          ? `${filePath}.bindings.telegram.groupHistory`
          : `${prefix}.groupHistory`
      );

      const telegramBot = {
        platform: "telegram",
        bindingId: username,
        username,
        token: bot.token.trim(),
        allowedUsernames: [...new Set([...defaultAllowedUsernames, ...allowedUsernames])],
        groupHistory,
        agent: structuredClone(agent),
        configPath: filePath
      };
      telegramBots.push(telegramBot);
      chatBindings.push(telegramBot);
    }
  }

  return {
    agent,
    chatBindings,
    telegramBots
  };
}

function normalizeChatBindingLookup({ platform, bindingId }) {
  const normalizedPlatform = String(platform ?? "").trim().toLowerCase();
  if (!normalizedPlatform) {
    throw new Error("chat binding platform must be a non-empty string");
  }

  if (normalizedPlatform === "telegram") {
    return {
      platform: normalizedPlatform,
      bindingId: normalizeTelegramBotUsername(bindingId, "telegram bot username")
    };
  }

  const normalizedBindingId = String(bindingId ?? "").trim();
  if (!normalizedBindingId) {
    throw new Error("chat binding id must be a non-empty string");
  }

  return {
    platform: normalizedPlatform,
    bindingId: normalizedBindingId
  };
}

export function findChatBindingConfig(config, { platform, agentId, bindingId }) {
  const lookup = normalizeChatBindingLookup({ platform, bindingId });
  return (
    config.chatBindings.find(
      (binding) =>
        binding.platform === lookup.platform &&
        binding.agent.id === agentId &&
        binding.bindingId === lookup.bindingId
    ) ?? null
  );
}

export function findTelegramBotConfig(config, { agentId, username }) {
  return findChatBindingConfig(config, {
    platform: "telegram",
    agentId,
    bindingId: username
  });
}

export async function loadConfig(configPath = DEFAULT_CONFIG_PATH) {
  const configFiles = await findAgentConfigFiles(configPath);
  const agents = [];
  const chatBindings = [];
  const telegramBots = [];
  const agentIds = new Set();
  const chatBindingKeys = new Set();

  for (const configFile of configFiles) {
    if (agentIds.has(configFile.agentId)) {
      throw new Error(`Duplicate agent id: ${configFile.agentId}`);
    }
    agentIds.add(configFile.agentId);

    const normalized = await normalizeAgentConfig(configFile);
    agents.push(normalized.agent);

    for (const binding of normalized.chatBindings) {
      const key = `${binding.platform}:${binding.bindingId}`;
      if (chatBindingKeys.has(key)) {
        if (binding.platform === "telegram") {
          throw new Error(`Duplicate Telegram bot username: ${binding.username}`);
        }
        throw new Error(`Duplicate chat binding: ${key}`);
      }
      chatBindingKeys.add(key);
      chatBindings.push(binding);
      if (binding.platform === "telegram") {
        telegramBots.push(binding);
      }
    }
  }

  return {
    configPath: path.resolve(configPath),
    agents,
    chatBindings,
    telegramBots
  };
}
