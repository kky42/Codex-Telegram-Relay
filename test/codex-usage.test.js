import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import {
  buildTurnUsage,
  findCodexRolloutPathForThread,
  readCodexFinalCallTokenUsageFromRollout,
  readContextLengthForThread
} from "../src/codex-usage.js";

test("buildTurnUsage subtracts prior cumulative totals for resumed runs", () => {
  assert.deepEqual(
    buildTurnUsage({
      contextLength: 12345,
      currentCumulativeUsage: {
        inputTokens: 25000,
        cachedInputTokens: 18000,
        outputTokens: 420
      },
      previousCumulativeUsage: {
        inputTokens: 21000,
        cachedInputTokens: 15000,
        outputTokens: 300
      },
      isResume: true
    }),
    {
      contextLength: 12345,
      inputTokens: 4000,
      outputTokens: 120,
      cacheReadTokens: 3000
    }
  );
});

test("buildTurnUsage leaves deltas unknown when resuming without prior totals", () => {
  assert.deepEqual(
    buildTurnUsage({
      contextLength: 12345,
      currentCumulativeUsage: {
        inputTokens: 25000,
        cachedInputTokens: 18000,
        outputTokens: 420
      },
      previousCumulativeUsage: null,
      isResume: true
    }),
    {
      contextLength: 12345,
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null
    }
  );
});

test("readCodexFinalCallTokenUsageFromRollout returns the last token_count usage", async () => {
  const fixturePath = path.join(process.cwd(), "test", "fixtures", "codex-rollout.jsonl");

  const usage = await readCodexFinalCallTokenUsageFromRollout(fixturePath);

  assert.deepEqual(usage, {
    inputTokens: 1540,
    cachedInputTokens: 910,
    outputTokens: 85,
    reasoningOutputTokens: 0
  });
});

test("findCodexRolloutPathForThread and readContextLengthForThread use the newest rollout file", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-telegram-relay-rollout-"));
  const threadId = "thread-xyz";
  const dateDir = path.join(tempDir, "2026", "04", "14");
  await fs.mkdir(dateDir, { recursive: true });

  const olderPath = path.join(dateDir, `rollout-older-${threadId}.jsonl`);
  const newerPath = path.join(dateDir, `rollout-newer-${threadId}.jsonl`);
  const fixture = await fs.readFile(path.join(process.cwd(), "test", "fixtures", "codex-rollout.jsonl"), "utf8");
  await fs.writeFile(olderPath, fixture.replace("\"input_tokens\":1540", "\"input_tokens\":1100"), "utf8");
  await fs.writeFile(newerPath, fixture, "utf8");

  const olderMtime = new Date("2026-04-14T10:00:00.000Z");
  const newerMtime = new Date("2026-04-14T10:05:00.000Z");
  await fs.utimes(olderPath, olderMtime, olderMtime);
  await fs.utimes(newerPath, newerMtime, newerMtime);

  const rolloutPath = await findCodexRolloutPathForThread(threadId, { sessionsDir: tempDir });
  const contextLength = await readContextLengthForThread(threadId, { sessionsDir: tempDir });

  assert.equal(rolloutPath, newerPath);
  assert.equal(contextLength, 1625);
});
