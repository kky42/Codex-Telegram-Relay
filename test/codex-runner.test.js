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
    "resume",
    "thread-123",
    "continue"
  ]);
});
