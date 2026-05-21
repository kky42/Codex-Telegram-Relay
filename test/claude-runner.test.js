import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { buildClaudeArgs } from "../src/cli_adapter/claude/args.js";
import { startClaudeRun } from "../src/cli_adapter/claude/runner.js";
import { ATTACHMENT_OUTPUT_DEVELOPER_INSTRUCTIONS } from "../src/chat_adapter/common/output-instructions.js";
import { createFakeCliCommand } from "./support/fakes.js";

test("buildClaudeArgs uses print stream-json for a fresh session", () => {
  assert.deepEqual(buildClaudeArgs({
    message: "hello"
  }), [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--allowedTools",
    "WebFetch,WebSearch",
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
    "--verbose",
    "--allowedTools",
    "WebFetch,WebSearch",
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
    "--verbose",
    "--allowedTools",
    "WebFetch,WebSearch",
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
    "--verbose",
    "--allowedTools",
    "WebFetch,WebSearch",
    "--dangerously-skip-permissions",
    "hello"
  ]);
});

test("buildClaudeArgs allows Claude web tools for every auto mode", () => {
  for (const autoMode of ["low", "medium", "high"]) {
    assert.deepEqual(
      buildClaudeArgs({ message: "hello", autoMode }).slice(4, 6),
      ["--allowedTools", "WebFetch,WebSearch"]
    );
  }
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
    "--verbose",
    "--allowedTools",
    "WebFetch,WebSearch",
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
  await fs.mkdir(workdir);
  await fs.writeFile(path.join(workdir, "cwd-marker.txt"), "ok", "utf8");
  const fakeCommand = await createFakeCliCommand(
    tempDir,
    "claude",
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

    const output = JSON.parse(chunks.join("").trim());
    assert.deepEqual(output.args, [
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--allowedTools",
      "WebFetch,WebSearch",
      "--permission-mode",
      "acceptEdits",
      "hello"
    ]);
    assert.equal(output.cwdBasename, "workspace");
    assert.equal(output.hasCwdMarker, true);
  } finally {
    fakeCommand.restorePath();
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
