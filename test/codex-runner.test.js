import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import assert from "node:assert/strict";

import { buildCodexArgs, startCodexRun } from "../src/codex-runner.js";
import { TELEGRAM_OUTPUT_DEVELOPER_INSTRUCTIONS } from "../src/prompt/telegram-output.js";

test("buildCodexArgs uses exec for a fresh thread", () => {
  assert.deepEqual(buildCodexArgs({
    workdir: "/tmp/project",
    message: "hello"
  }), [
    "exec",
    "-C",
    "/tmp/project",
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
    "exec",
    "-C",
    "/tmp/project",
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
    autoMode: "high"
  }), [
    "exec",
    "-C",
    "/tmp/project",
    "--json",
    "--skip-git-repo-check",
    "--dangerously-bypass-approvals-and-sandbox",
    "hello"
  ]);
});

test("buildCodexArgs uses read-only sandbox when auto mode is low", () => {
  assert.deepEqual(buildCodexArgs({
    workdir: "/tmp/project",
    message: "hello",
    autoMode: "low"
  }), [
    "exec",
    "-C",
    "/tmp/project",
    "--json",
    "--skip-git-repo-check",
    "--sandbox",
    "read-only",
    "hello"
  ]);
});

test("buildCodexArgs uses workspace-write sandbox when auto mode is medium", () => {
  assert.deepEqual(buildCodexArgs({
    workdir: "/tmp/project",
    message: "hello",
    autoMode: "medium"
  }), [
    "exec",
    "-C",
    "/tmp/project",
    "--json",
    "--skip-git-repo-check",
    "--sandbox",
    "workspace-write",
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
    "exec",
    "-C",
    "/tmp/project",
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
    "exec",
    "-C",
    "/tmp/project",
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
    "exec",
    "-C",
    "/tmp/project",
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
    "exec",
    "-C",
    "/tmp/project",
    "--json",
    "--skip-git-repo-check",
    "--dangerously-bypass-approvals-and-sandbox",
    "--image=/tmp/one.png",
    "resume",
    "thread-123",
    ""
  ]);
});

test("buildCodexArgs supports ephemeral last-message capture runs", () => {
  assert.deepEqual(buildCodexArgs({
    workdir: "/tmp/project",
    message: "hello",
    ephemeral: true,
    outputLastMessagePath: "/tmp/last-message.txt"
  }), [
    "exec",
    "-C",
    "/tmp/project",
    "--json",
    "--skip-git-repo-check",
    "--ephemeral",
    "--output-last-message",
    "/tmp/last-message.txt",
    "--dangerously-bypass-approvals-and-sandbox",
    "hello"
  ]);
});

test("buildCodexArgs injects developer_instructions only for fresh threads", () => {
  const freshArgs = buildCodexArgs({
    workdir: "/tmp/project",
    message: "hello",
    developerInstructions: TELEGRAM_OUTPUT_DEVELOPER_INSTRUCTIONS
  });
  const resumedArgs = buildCodexArgs({
    workdir: "/tmp/project",
    threadId: "thread-123",
    message: "hello",
    developerInstructions: TELEGRAM_OUTPUT_DEVELOPER_INSTRUCTIONS
  });

  assert.ok(freshArgs.includes("-c"));
  assert.ok(
    freshArgs.includes(
      `developer_instructions=${JSON.stringify(TELEGRAM_OUTPUT_DEVELOPER_INSTRUCTIONS)}`
    )
  );
  assert.ok(
    !resumedArgs.some((arg) => arg.startsWith("developer_instructions="))
  );
});

test("startCodexRun invokes codex with exec-scoped workdir arguments", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-telegram-relay-args-"));
  const fakeCodexPath = path.join(tempDir, "codex");
  await fs.writeFile(
    fakeCodexPath,
    `#!/usr/bin/env node
process.stdout.write(JSON.stringify(process.argv.slice(2)) + "\\n");
`,
    "utf8"
  );
  await fs.chmod(fakeCodexPath, 0o755);

  const originalPath = process.env.PATH;
  process.env.PATH = `${tempDir}${path.delimiter}${originalPath ?? ""}`;

  try {
    const run = startCodexRun({
      workdir: "/tmp/project",
      message: "hello"
    });

    const chunks = [];
    run.child.stdout.setEncoding("utf8");
    run.child.stdout.on("data", (chunk) => {
      chunks.push(chunk);
    });

    await run.done;

    assert.deepEqual(JSON.parse(chunks.join("").trim()), [
      "exec",
      "-C",
      "/tmp/project",
      "--json",
      "--skip-git-repo-check",
      "--dangerously-bypass-approvals-and-sandbox",
      "hello"
    ]);
  } finally {
    process.env.PATH = originalPath;
    await fs.rm(tempDir, { recursive: true, force: true });
  }
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
