import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const CODEX_ROLLOUT_PATH_CACHE = new Map();

function asFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getDefaultCodexSessionsDir() {
  return path.join(os.homedir(), ".codex", "sessions");
}

export async function findCodexRolloutPathForThread(threadId, { sessionsDir = getDefaultCodexSessionsDir() } = {}) {
  if (!threadId) {
    return null;
  }

  const cached = CODEX_ROLLOUT_PATH_CACHE.get(threadId);
  if (cached) {
    try {
      const stat = await fs.stat(cached);
      if (stat.isFile()) {
        return cached;
      }
    } catch {
      CODEX_ROLLOUT_PATH_CACHE.delete(threadId);
    }
  }

  const candidateDirs = [];
  const now = new Date();
  for (let index = 0; index < 14; index += 1) {
    const date = new Date(now);
    date.setDate(now.getDate() - index);
    const year = String(date.getFullYear());
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    candidateDirs.push(path.join(sessionsDir, year, month, day));
  }

  const matches = [];

  const scanDir = async (dir) => {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (!entry.isFile()) {
        continue;
      }
      if (!entry.name.startsWith("rollout-") || !entry.name.endsWith(".jsonl")) {
        continue;
      }
      if (!entry.name.includes(threadId)) {
        continue;
      }

      const fullPath = path.join(dir, entry.name);
      try {
        const stat = await fs.stat(fullPath);
        if (stat.isFile()) {
          matches.push({ fullPath, mtimeMs: stat.mtimeMs });
        }
      } catch {
        // Ignore files that disappear between readdir and stat.
      }
    }
  };

  for (const dir of candidateDirs) {
    await scanDir(dir);
  }

  if (matches.length === 0) {
    const scanTree = async (dir, depth) => {
      if (depth < 0) {
        return;
      }

      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await scanTree(fullPath, depth - 1);
          continue;
        }
        if (!entry.isFile()) {
          continue;
        }
        if (!entry.name.startsWith("rollout-") || !entry.name.endsWith(".jsonl")) {
          continue;
        }
        if (!entry.name.includes(threadId)) {
          continue;
        }

        try {
          const stat = await fs.stat(fullPath);
          if (stat.isFile()) {
            matches.push({ fullPath, mtimeMs: stat.mtimeMs });
          }
        } catch {
          // Ignore files that disappear between readdir and stat.
        }
      }
    };

    await scanTree(sessionsDir, 3);
  }

  if (matches.length === 0) {
    return null;
  }

  matches.sort((left, right) => right.mtimeMs - left.mtimeMs);
  const bestPath = matches[0].fullPath;
  CODEX_ROLLOUT_PATH_CACHE.set(threadId, bestPath);
  return bestPath;
}

export async function readCodexFinalCallTokenUsageFromRollout(rolloutPath) {
  let file = null;

  try {
    file = await fs.open(rolloutPath, "r");
    const stat = await file.stat();
    if (stat.size <= 0) {
      return null;
    }

    const initialTailBytes = 256 * 1024;
    const maxTailBytes = 8 * 1024 * 1024;
    let tailBytes = Math.min(stat.size, initialTailBytes);

    while (tailBytes > 0) {
      const start = Math.max(0, stat.size - tailBytes);
      const buffer = Buffer.alloc(tailBytes);
      const { bytesRead } = await file.read(buffer, 0, tailBytes, start);
      const text = buffer.subarray(0, bytesRead).toString("utf8");
      const lines = text.split("\n");

      for (let index = lines.length - 1; index >= 0; index -= 1) {
        const line = String(lines[index] ?? "").trim();
        if (!line || !line.includes("token_count")) {
          continue;
        }

        let event;
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }

        if (!isRecord(event) || event.type !== "event_msg") {
          continue;
        }

        const payload = event.payload;
        if (!isRecord(payload) || payload.type !== "token_count") {
          continue;
        }

        const info = payload.info;
        if (!isRecord(info)) {
          continue;
        }

        const lastUsage = info.last_token_usage;
        if (!isRecord(lastUsage)) {
          continue;
        }

        const inputTokens = asFiniteNumber(lastUsage.input_tokens);
        const cachedInputTokens = asFiniteNumber(lastUsage.cached_input_tokens);
        const outputTokens = asFiniteNumber(lastUsage.output_tokens);
        const reasoningOutputTokens = asFiniteNumber(lastUsage.reasoning_output_tokens);

        if (
          inputTokens === null ||
          cachedInputTokens === null ||
          outputTokens === null ||
          reasoningOutputTokens === null
        ) {
          continue;
        }

        return {
          inputTokens,
          cachedInputTokens,
          outputTokens,
          reasoningOutputTokens
        };
      }

      if (tailBytes >= stat.size || tailBytes >= maxTailBytes) {
        break;
      }

      tailBytes = Math.min(stat.size, tailBytes * 2);
    }

    return null;
  } catch {
    return null;
  } finally {
    try {
      await file?.close();
    } catch {
      // Ignore close failures after best-effort parsing.
    }
  }
}

export async function readContextLengthForThread(threadId, options) {
  const rolloutPath = await findCodexRolloutPathForThread(threadId, options);
  if (!rolloutPath) {
    return null;
  }

  const usage = await readCodexFinalCallTokenUsageFromRollout(rolloutPath);
  if (!usage) {
    return null;
  }

  return usage.inputTokens + usage.outputTokens;
}
