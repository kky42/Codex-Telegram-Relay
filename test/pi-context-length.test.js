import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import {
  findPiSessionPathForSession,
  readContextLengthForSession,
  readPiFinalAssistantContextLengthFromSession
} from "../src/cli_adapter/pi/context-length.js";

function sessionFixture(sessionId, totalTokens = 1519) {
  return [
    JSON.stringify({
      type: "session",
      version: 3,
      id: sessionId,
      timestamp: "2026-05-13T17:58:15.560Z",
      cwd: "/tmp/project"
    }),
    JSON.stringify({
      type: "message",
      id: "user-1",
      parentId: null,
      timestamp: "2026-05-13T17:58:16.000Z",
      message: {
        role: "user",
        content: "hello"
      }
    }),
    JSON.stringify({
      type: "message",
      id: "assistant-1",
      parentId: "user-1",
      timestamp: "2026-05-13T17:58:17.000Z",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "OK" }],
        usage: {
          input: 994,
          output: 13,
          cacheRead: 512,
          cacheWrite: 0,
          totalTokens,
          cost: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            total: 0
          }
        },
        stopReason: "stop"
      }
    })
  ].join("\n");
}

test("readPiFinalAssistantContextLengthFromSession uses assistant usage.totalTokens", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "anyagent-pi-session-"));
  const sessionPath = path.join(tempDir, "2026-05-13_session-abc.jsonl");
  await fs.writeFile(sessionPath, sessionFixture("session-abc", 1519), "utf8");

  const contextLength = await readPiFinalAssistantContextLengthFromSession(sessionPath);

  assert.equal(contextLength, 1519);
});

test("readPiFinalAssistantContextLengthFromSession falls back to usage components", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "anyagent-pi-session-"));
  const sessionPath = path.join(tempDir, "2026-05-13_session-abc.jsonl");
  await fs.writeFile(sessionPath, sessionFixture("session-abc", 0), "utf8");

  const contextLength = await readPiFinalAssistantContextLengthFromSession(sessionPath);

  assert.equal(contextLength, 1519);
});

test("findPiSessionPathForSession and readContextLengthForSession use the newest matching session file", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "anyagent-pi-sessions-"));
  const workdirSessionDir = path.join(tempDir, "--tmp-project--");
  await fs.mkdir(workdirSessionDir, { recursive: true });

  const sessionId = "019e227d-4508-74ed-acd1-9d990c98b99d";
  const olderPath = path.join(workdirSessionDir, `20260513T175000_${sessionId}.jsonl`);
  const newerPath = path.join(workdirSessionDir, `20260513T175815_${sessionId}.jsonl`);
  await fs.writeFile(olderPath, sessionFixture(sessionId, 1200), "utf8");
  await fs.writeFile(newerPath, sessionFixture(sessionId, 1519), "utf8");

  const olderMtime = new Date("2026-05-13T17:50:00.000Z");
  const newerMtime = new Date("2026-05-13T17:58:15.000Z");
  await fs.utimes(olderPath, olderMtime, olderMtime);
  await fs.utimes(newerPath, newerMtime, newerMtime);

  const sessionPath = await findPiSessionPathForSession(sessionId, { sessionsDir: tempDir });
  const contextLength = await readContextLengthForSession(sessionId, { sessionsDir: tempDir });

  assert.equal(sessionPath, newerPath);
  assert.equal(contextLength, 1519);
});
