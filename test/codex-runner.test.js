import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import assert from "node:assert/strict";

import { buildCodexArgs } from "../src/cli_adapter/codex/args.js";
import { startCodexRun } from "../src/cli_adapter/codex/runner.js";
import { ATTACHMENT_OUTPUT_DEVELOPER_INSTRUCTIONS } from "../src/chat_adapter/common/output-instructions.js";
import { createFakeCliCommand } from "./support/fakes.js";

test("buildCodexArgs uses exec for a fresh session", () => {
  assert.deepEqual(buildCodexArgs({
    message: "hello"
  }), [
    "exec",
    "--json",
    "--skip-git-repo-check",
    "--sandbox",
    "workspace-write",
    "hello"
  ]);
});

test("buildCodexArgs uses exec resume when session id exists", () => {
  assert.deepEqual(buildCodexArgs({
    sessionId: "session-123",
    message: "continue"
  }), [
    "exec",
    "--json",
    "--skip-git-repo-check",
    "--sandbox",
    "workspace-write",
    "resume",
    "session-123",
    "continue"
  ]);
});

test("buildCodexArgs uses dangerous bypass for full-access mode", () => {
  assert.deepEqual(buildCodexArgs({
    message: "hello",
    autoMode: "high"
  }), [
    "exec",
    "--json",
    "--skip-git-repo-check",
    "--dangerously-bypass-approvals-and-sandbox",
    "hello"
  ]);
});

test("buildCodexArgs uses read-only sandbox when auto mode is low", () => {
  assert.deepEqual(buildCodexArgs({
    message: "hello",
    autoMode: "low"
  }), [
    "exec",
    "--json",
    "--skip-git-repo-check",
    "--sandbox",
    "read-only",
    "hello"
  ]);
});

test("buildCodexArgs uses workspace-write sandbox when auto mode is medium", () => {
  assert.deepEqual(buildCodexArgs({
    message: "hello",
    autoMode: "medium"
  }), [
    "exec",
    "--json",
    "--skip-git-repo-check",
    "--sandbox",
    "workspace-write",
    "hello"
  ]);
});

test("buildCodexArgs omits model and reasoning-effort when set to default", () => {
  assert.deepEqual(buildCodexArgs({
    message: "hello",
    model: "default",
    reasoningEffort: "default"
  }), [
    "exec",
    "--json",
    "--skip-git-repo-check",
    "--sandbox",
    "workspace-write",
    "hello"
  ]);
});

test("buildCodexArgs appends model and reasoning-effort when provided", () => {
  assert.deepEqual(buildCodexArgs({
    message: "hello",
    model: "gpt-5.4",
    reasoningEffort: "high"
  }), [
    "exec",
    "--json",
    "--skip-git-repo-check",
    "--sandbox",
    "workspace-write",
    "--model",
    "gpt-5.4",
    "-c",
    "model_reasoning_effort=\"high\"",
    "hello"
  ]);
});

test("buildCodexArgs injects developer_instructions only for fresh sessions", () => {
  const freshArgs = buildCodexArgs({
    message: "hello",
    developerInstructions: ATTACHMENT_OUTPUT_DEVELOPER_INSTRUCTIONS
  });
  const resumedArgs = buildCodexArgs({
    sessionId: "session-123",
    message: "hello",
    developerInstructions: ATTACHMENT_OUTPUT_DEVELOPER_INSTRUCTIONS
  });

  assert.ok(freshArgs.includes("-c"));
  assert.ok(
    freshArgs.includes(
      `developer_instructions=${JSON.stringify(ATTACHMENT_OUTPUT_DEVELOPER_INSTRUCTIONS)}`
    )
  );
  assert.doesNotMatch(ATTACHMENT_OUTPUT_DEVELOPER_INSTRUCTIONS, /Telegram|HTML|Markdown/i);
  assert.ok(
    !resumedArgs.some((arg) => arg.startsWith("developer_instructions="))
  );
});

test("startCodexRun invokes codex from the requested workdir", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "anyagent-args-"));
  const workdir = path.join(tempDir, "workspace");
  await fs.mkdir(workdir);
  await fs.writeFile(path.join(workdir, "cwd-marker.txt"), "ok", "utf8");
  const fakeCommand = await createFakeCliCommand(
    tempDir,
    "codex",
    `import fs from "node:fs";
import path from "node:path";

process.stdout.write(JSON.stringify({
  args: process.argv.slice(2),
  cwdBasename: path.basename(process.cwd()),
  hasCwdMarker: fs.existsSync("cwd-marker.txt")
}) + "\\n");
`
  );

  try {
    const run = startCodexRun({
      workdir,
      message: "hello"
    });

    const chunks = [];
    run.child.stdout.setEncoding("utf8");
    run.child.stdout.on("data", (chunk) => {
      chunks.push(chunk);
    });

    await run.done;

    const output = JSON.parse(chunks.join("").trim());
    assert.deepEqual(output.args, [
      "exec",
      "--json",
      "--skip-git-repo-check",
      "--sandbox",
      "workspace-write",
      "hello"
    ]);
    assert.equal(output.cwdBasename, "workspace");
    assert.equal(output.hasCwdMarker, true);
  } finally {
    fakeCommand.restorePath();
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("startCodexRun terminates a child that ignores SIGTERM", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "anyagent-runner-"));
  const fakeCommand = await createFakeCliCommand(
    tempDir,
    "codex",
    `process.on("SIGTERM", () => {});
process.stdout.write("ready\\n");
setInterval(() => {}, 1000);
`
  );

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
    if (process.platform === "win32") {
      assert.equal(result.signal, null);
    } else {
      assert.equal(result.signal, "SIGKILL");
    }
  } finally {
    fakeCommand.restorePath();
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
