import test from "node:test";
import assert from "node:assert/strict";

import { buildCodexArgs } from "../src/codex-runner.js";

test("buildCodexArgs uses exec for a fresh thread", () => {
  assert.deepEqual(buildCodexArgs({
    workdir: "/tmp/project",
    message: "hello"
  }), [
    "-C",
    "/tmp/project",
    "exec",
    "--json",
    "--skip-git-repo-check",
    "--sandbox",
    "read-only",
    "hello"
  ]);
});

test("buildCodexArgs uses exec resume when thread id exists", () => {
  assert.deepEqual(buildCodexArgs({
    workdir: "/tmp/project",
    threadId: "thread-123",
    message: "continue"
  }), [
    "-C",
    "/tmp/project",
    "exec",
    "--json",
    "--skip-git-repo-check",
    "--sandbox",
    "read-only",
    "resume",
    "thread-123",
    "continue"
  ]);
});

test("buildCodexArgs uses dangerous bypass for full-access mode", () => {
  assert.deepEqual(buildCodexArgs({
    workdir: "/tmp/project",
    message: "hello",
    yolo: true
  }), [
    "-C",
    "/tmp/project",
    "exec",
    "--json",
    "--skip-git-repo-check",
    "--dangerously-bypass-approvals-and-sandbox",
    "hello"
  ]);
});
