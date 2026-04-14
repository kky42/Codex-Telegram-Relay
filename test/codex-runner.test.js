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
    "--dangerously-bypass-approvals-and-sandbox",
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
    "--dangerously-bypass-approvals-and-sandbox",
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

test("buildCodexArgs uses read-only sandbox when yolo is false", () => {
  assert.deepEqual(buildCodexArgs({
    workdir: "/tmp/project",
    message: "hello",
    yolo: false
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

test("buildCodexArgs omits model and reasoning-effort when set to default", () => {
  assert.deepEqual(buildCodexArgs({
    workdir: "/tmp/project",
    message: "hello",
    model: "default",
    reasoningEffort: "default"
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

test("buildCodexArgs appends model and reasoning-effort when provided", () => {
  assert.deepEqual(buildCodexArgs({
    workdir: "/tmp/project",
    message: "hello",
    model: "gpt-5.4",
    reasoningEffort: "high"
  }), [
    "-C",
    "/tmp/project",
    "exec",
    "--json",
    "--skip-git-repo-check",
    "--dangerously-bypass-approvals-and-sandbox",
    "--model",
    "gpt-5.4",
    "-c",
    "model_reasoning_effort=\"high\"",
    "hello"
  ]);
});
