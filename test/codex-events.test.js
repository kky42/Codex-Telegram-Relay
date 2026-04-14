import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { eventToActions, parseJsonlLine } from "../src/codex-events.js";

const fixturePath = path.join(process.cwd(), "test", "fixtures", "codex-events.jsonl");

test("parseJsonlLine returns null for non-json lines", () => {
  assert.equal(parseJsonlLine("not-json"), null);
});

test("fixture events produce only visible actions and usage updates", async () => {
  const content = await fs.readFile(fixturePath, "utf8");
  const actions = content
    .trim()
    .split("\n")
    .map((line) => parseJsonlLine(line))
    .flatMap((event) => eventToActions(event));

  assert.deepEqual(actions, [
    {
      kind: "thread_started",
      threadId: "019d89e6-1949-7af1-aa82-9d13d9adc4a3"
    },
    {
      kind: "message",
      text: "command_execution"
    },
    {
      kind: "message",
      text: "command-probe-ok"
    },
    {
      kind: "turn_completed",
      cumulativeUsage: {
        inputTokens: 20971,
        cachedInputTokens: 15616,
        outputTokens: 181
      }
    }
  ]);
});
