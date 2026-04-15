import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import assert from "node:assert/strict";

import { buildCodexArgs, startCodexRun } from "../src/codex-runner.js";

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

test("buildCodexArgs appends image flags for a fresh thread", () => {
  assert.deepEqual(buildCodexArgs({
    workdir: "/tmp/project",
    message: "",
    imagePaths: ["/tmp/one.png", "/tmp/two.png"]
  }), [
    "-C",
    "/tmp/project",
    "exec",
    "--json",
    "--skip-git-repo-check",
    "--dangerously-bypass-approvals-and-sandbox",
    "--image=/tmp/one.png",
    "--image=/tmp/two.png",
    ""
  ]);
});

test("buildCodexArgs appends image flags before exec resume", () => {
  assert.deepEqual(buildCodexArgs({
    workdir: "/tmp/project",
    threadId: "thread-123",
    message: "",
    imagePaths: ["/tmp/one.png"]
  }), [
    "-C",
    "/tmp/project",
    "exec",
    "--json",
    "--skip-git-repo-check",
    "--dangerously-bypass-approvals-and-sandbox",
    "--image=/tmp/one.png",
    "resume",
    "thread-123",
    ""
  ]);
});

test("startCodexRun forces SIGKILL when the child ignores SIGTERM", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-telegram-relay-runner-"));
  const fakeCodexPath = path.join(tempDir, "codex");
  await fs.writeFile(
    fakeCodexPath,
    `#!/usr/bin/env node
process.on("SIGTERM", () => {});
process.stdout.write("ready\\n");
setInterval(() => {}, 1000);
`,
    "utf8"
  );
  await fs.chmod(fakeCodexPath, 0o755);

  const originalPath = process.env.PATH;
  process.env.PATH = `${tempDir}${path.delimiter}${originalPath ?? ""}`;

  try {
    const run = startCodexRun({
      workdir: tempDir,
      message: "hello",
      forceKillDelayMs: 50
    });

    await new Promise((resolve) => {
      run.child.stdout.once("data", resolve);
    });
    run.abort();
    const result = await run.done;

    assert.equal(result.aborted, true);
    assert.equal(result.signal, "SIGKILL");
  } finally {
    process.env.PATH = originalPath;
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
