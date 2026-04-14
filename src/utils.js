import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const APP_DIR = path.join(os.homedir(), ".codex-telegram-relay");
export const DEFAULT_CONFIG_PATH = path.join(APP_DIR, "config.json");
export const DEFAULT_STATE_PATH = path.join(APP_DIR, "state.json");
export const TELEGRAM_MESSAGE_LIMIT = 4000;
export const INVALID_WORKDIR_MESSAGE =
  "Use an absolute path or ~/..., and make sure it points to an existing directory.";

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

export async function readJsonFile(filePath, fallbackValue = null) {
  try {
    const content = await fs.readFile(filePath, "utf8");
    return JSON.parse(content);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return fallbackValue;
    }
    throw error;
  }
}

export async function writeJsonFileAtomic(filePath, value) {
  await ensureDir(path.dirname(filePath));
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  const content = `${JSON.stringify(value, null, 2)}\n`;
  await fs.writeFile(tempPath, content, "utf8");
  await fs.rename(tempPath, filePath);
}

export function normalizeTelegramUsername(username) {
  return String(username || "").trim().replace(/^@+/, "").toLowerCase();
}

export function expandWorkdirPath(rawPath, { homeDir = os.homedir() } = {}) {
  const normalized = String(rawPath ?? "").trim();
  if (normalized === "~") {
    return homeDir;
  }

  if (/^~[\\/]/.test(normalized)) {
    return path.resolve(homeDir, normalized.slice(2));
  }

  if (path.isAbsolute(normalized)) {
    return path.resolve(normalized);
  }

  throw new Error(INVALID_WORKDIR_MESSAGE);
}

export async function resolveWorkdirPath(rawPath, { homeDir = os.homedir() } = {}) {
  const expandedPath = expandWorkdirPath(rawPath, { homeDir });

  try {
    const stats = await fs.stat(expandedPath);
    if (!stats.isDirectory()) {
      throw new Error(INVALID_WORKDIR_MESSAGE);
    }
  } catch (error) {
    if (error instanceof Error && error.message === INVALID_WORKDIR_MESSAGE) {
      throw error;
    }
    throw new Error(INVALID_WORKDIR_MESSAGE);
  }

  return expandedPath;
}

export function formatTokenCountK(value) {
  const total = Number(value);
  if (!Number.isFinite(total)) {
    return "n/a";
  }

  return `${(total / 1000).toFixed(1)}k`;
}

export function truncateText(text, maxLength = 120) {
  if (text.length <= maxLength) {
    return text;
  }
  if (maxLength <= 1) {
    return text.slice(0, maxLength);
  }
  return `${text.slice(0, maxLength - 1)}…`;
}

export function splitPlainText(text, maxLength = TELEGRAM_MESSAGE_LIMIT) {
  if (!text) {
    return [""];
  }

  const chunks = [];
  let remaining = text;

  while (remaining.length > maxLength) {
    let splitAt = remaining.lastIndexOf("\n\n", maxLength);
    if (splitAt < Math.floor(maxLength / 2)) {
      splitAt = remaining.lastIndexOf("\n", maxLength);
    }
    if (splitAt < Math.floor(maxLength / 2)) {
      splitAt = remaining.lastIndexOf(" ", maxLength);
    }
    if (splitAt <= 0) {
      splitAt = maxLength;
    }

    const chunk = remaining.slice(0, splitAt).trimEnd();
    if (chunk) {
      chunks.push(chunk);
    }
    remaining = remaining.slice(splitAt).trimStart();
  }

  if (remaining) {
    chunks.push(remaining);
  }

  return chunks.length > 0 ? chunks : [""];
}

export function toErrorMessage(error) {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
