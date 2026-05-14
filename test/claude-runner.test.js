import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import assert from "node:assert/strict";

import { buildClaudeArgs } from "../src/cli_adapter/claude/args.js";
import { startClaudeRun } from "../src/cli_adapter/claude/runner.js";
import { ATTACHMENT_OUTPUT_DEVELOPER_INSTRUCTIONS } from "../src/chat_adapter/output-instructions.js";

test("buildClaudeArgs uses print stream-json for a fresh session", () => {
  assert.deepEqual(buildClaudeArgs({
    message: "hello"
  }), [
    "-p",
    "--output-format",
    "stream-json",
    "--permission-mode",
    "acceptEdits",
    "hello"
  ]);
});

test("buildClaudeArgs resumes an existing session", () => {
  assert.deepEqual(buildClaudeArgs({
    sessionId: "9f4026da-cb03-4e1e-a75c-b3fa94f42156",
    message: "continue"
  }), [
    "-p",
    "--output-format",
    "stream-json",
    "--permission-mode",
    "acceptEdits",
    "--resume",
    "9f4026da-cb03-4e1e-a75c-b3fa94f42156",
    "continue"
  ]);
});

test("buildClaudeArgs maps auto modes to Claude permission flags", () => {
  assert.deepEqual(buildClaudeArgs({
    message: "hello",
    autoMode: "low"
  }), [
    "-p",
    "--output-format",
    "stream-json",
    "--permission-mode",
    "dontAsk",
    "hello"
  ]);

  assert.deepEqual(buildClaudeArgs({
    message: "hello",
    autoMode: "high"
  }), [
    "-p",
    "--output-format",
    "stream-json",
    "--dangerously-skip-permissions",
    "hello"
  ]);
});

test("buildClaudeArgs appends model, effort, and attachment contract prompt", () => {
  assert.deepEqual(buildClaudeArgs({
    message: "hello",
    model: "sonnet",
    reasoningEffort: "high",
    developerInstructions: ATTACHMENT_OUTPUT_DEVELOPER_INSTRUCTIONS
  }), [
    "-p",
    "--output-format",
    "stream-json",
    "--permission-mode",
    "acceptEdits",
    "--model",
    "sonnet",
    "--effort",
    "high",
    "--append-system-prompt",
    ATTACHMENT_OUTPUT_DEVELOPER_INSTRUCTIONS,
    "hello"
  ]);
});

test("startClaudeRun invokes claude from the requested workdir", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "anyagent-claude-args-"));
  const workdir = path.join(tempDir, "workspace");
  const fakeClaudePath = path.join(tempDir, "claude");
  await fs.mkdir(workdir);
  await fs.writeFile(
    fakeClaudePath,
    `#!/usr/bin/env node
process.stdout.write(JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }) + "\\n");
`,
    "utf8"
  );
  await fs.chmod(fakeClaudePath, 0o755);

  const originalPath = process.env.PATH;
  process.env.PATH = `${tempDir}${path.delimiter}${originalPath ?? ""}`;

  try {
    const run = startClaudeRun({
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
        "-p",
        "--output-format",
        "stream-json",
        "--permission-mode",
        "acceptEdits",
        "hello"
      ],
      cwd: await fs.realpath(workdir)
    });
  } finally {
    process.env.PATH = originalPath;
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
