import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import assert from "node:assert/strict";

import { buildCodexArgs } from "../src/cli_adapter/codex/args.js";
import { startCodexRun } from "../src/cli_adapter/codex/runner.js";
import { ATTACHMENT_OUTPUT_DEVELOPER_INSTRUCTIONS } from "../src/chat_adapter/output-instructions.js";

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
  const fakeCodexPath = path.join(tempDir, "codex");
  await fs.mkdir(workdir);
  await fs.writeFile(
    fakeCodexPath,
    `#!/usr/bin/env node
process.stdout.write(JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }) + "\\n");
`,
    "utf8"
  );
  await fs.chmod(fakeCodexPath, 0o755);

  const originalPath = process.env.PATH;
  process.env.PATH = `${tempDir}${path.delimiter}${originalPath ?? ""}`;

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

    assert.deepEqual(JSON.parse(chunks.join("").trim()), {
      args: [
        "exec",
        "--json",
        "--skip-git-repo-check",
        "--sandbox",
        "workspace-write",
        "hello"
      ],
      cwd: await fs.realpath(workdir)
    });
  } finally {
    process.env.PATH = originalPath;
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("startCodexRun forces SIGKILL when the child ignores SIGTERM", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "anyagent-runner-"));
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
