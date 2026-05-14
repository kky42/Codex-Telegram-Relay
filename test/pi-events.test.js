import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { eventToActions, parseJsonlLine } from "../src/cli_adapter/pi/events.js";

const fixturePath = path.join(process.cwd(), "test", "fixtures", "pi-events.jsonl");

test("parseJsonlLine returns null for non-json lines", () => {
  assert.equal(parseJsonlLine("not-json"), null);
});

test("fixture events emit the final assistant message only after message_end", async () => {
  const content = await fs.readFile(fixturePath, "utf8");
  const actions = content
    .trim()
    .split("\n")
    .map((line) => parseJsonlLine(line))
    .flatMap((event) => eventToActions(event));

  assert.deepEqual(actions, [
    {
      kind: "session_started",
      sessionId: "019e227d-4508-74ed-acd1-9d990c98b99d"
    },
    {
      kind: "context_length",
      contextLength: 1519
    },
    {
      kind: "message",
      text: "OK"
    },
    {
      kind: "context_length",
      contextLength: 1519
    },
    {
      kind: "turn_completed"
    },
    {
      kind: "turn_completed"
    }
  ]);
});

test("tool execution events become progress actions", () => {
  assert.deepEqual(eventToActions({
    type: "tool_execution_start",
    toolName: "bash",
    toolCallId: "tool-1",
    args: {}
  }), [
    {
      kind: "progress",
      text: "bash"
    }
  ]);
});

test("assistant error message_end produces an error action", () => {
  assert.deepEqual(eventToActions({
    type: "message_end",
    message: {
      role: "assistant",
      content: [],
      stopReason: "error",
      errorMessage: "provider unavailable"
    }
  }), [
    {
      kind: "error",
      text: "Pi failed: provider unavailable"
    }
  ]);
});
