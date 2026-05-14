import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const PI_SESSION_PATH_CACHE = new Map();

function asFiniteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function usageToContextLength(usage) {
  if (!isRecord(usage)) {
    return null;
  }

  const totalTokens = asFiniteNumber(usage.totalTokens);
  if (totalTokens !== null && totalTokens > 0) {
    return totalTokens;
  }

  const input = asFiniteNumber(usage.input);
  const output = asFiniteNumber(usage.output);
  const cacheRead = asFiniteNumber(usage.cacheRead ?? 0);
  const cacheWrite = asFiniteNumber(usage.cacheWrite ?? 0);
  if (input === null || output === null || cacheRead === null || cacheWrite === null) {
    return null;
  }

  return input + output + cacheRead + cacheWrite;
}

function getDefaultPiSessionsDir() {
  return path.join(os.homedir(), ".pi", "agent", "sessions");
}

export async function findPiSessionPathForSession(
  sessionId,
  { sessionsDir = getDefaultPiSessionsDir() } = {}
) {
  if (!sessionId) {
    return null;
  }

  const cached = PI_SESSION_PATH_CACHE.get(sessionId);
  if (cached) {
    try {
      const stat = await fs.stat(cached);
      if (stat.isFile()) {
        return cached;
      }
    } catch {
      PI_SESSION_PATH_CACHE.delete(sessionId);
    }
  }

  const matches = [];
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
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) {
        continue;
      }
      if (!entry.name.includes(sessionId)) {
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

  if (matches.length === 0) {
    return null;
  }

  matches.sort((left, right) => right.mtimeMs - left.mtimeMs);
  const bestPath = matches[0].fullPath;
  PI_SESSION_PATH_CACHE.set(sessionId, bestPath);
  return bestPath;
}

export async function readPiFinalAssistantContextLengthFromSession(sessionPath) {
  let file = null;

  try {
    file = await fs.open(sessionPath, "r");
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
        if (!line || !line.includes("\"assistant\"") || !line.includes("\"usage\"")) {
          continue;
        }

        let event;
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }

        const message = event?.message;
        if (!isRecord(message) || message.role !== "assistant") {
          continue;
        }
        if (message.stopReason === "aborted" || message.stopReason === "error") {
          continue;
        }

        const contextLength = usageToContextLength(message.usage);
        if (contextLength !== null && contextLength > 0) {
          return contextLength;
        }
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

export async function readContextLengthForSession(sessionId, options) {
  const sessionPath = await findPiSessionPathForSession(sessionId, options);
  if (!sessionPath) {
    return null;
  }

  return readPiFinalAssistantContextLengthFromSession(sessionPath);
}
