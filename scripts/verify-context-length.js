#!/usr/bin/env node

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { ChatSession } from "../src/bot-runtime.js";
import { StateStore } from "../src/state-store.js";
import { startCodexRun } from "../src/codex-runner.js";
import { readContextLengthForThread } from "../src/context-length.js";
import { toErrorMessage } from "../src/utils.js";

class SilentBotApi {
  constructor() {
    this.messages = [];
  }

  async sendMessage(payload) {
    this.messages.push(payload);
    return { message_id: this.messages.length };
  }

  async sendChatAction() {
    return true;
  }
}

function printHelp() {
  process.stdout.write(`Usage: verify-context-length --workdir /path --message "first" --message "follow up"

Options:
  --workdir <path>   Working directory for codex runs (defaults to current directory)
  --message <text>   Prompt to send; pass at least twice for multi-round verification
  --help             Show this help
`);
}

function parseArgs(argv) {
  let workdir = process.cwd();
  const messages = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      return { help: true, workdir, messages };
    }
    if (arg === "--workdir") {
      workdir = argv[index + 1];
      index += 1;
      if (!workdir) {
        throw new Error("Missing value after --workdir");
      }
      continue;
    }
    if (arg === "--message") {
      const message = argv[index + 1];
      index += 1;
      if (!message) {
        throw new Error("Missing value after --message");
      }
      messages.push(message);
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (messages.length < 2) {
    throw new Error("Provide at least two --message values for multi-round verification.");
  }

  return {
    help: false,
    workdir: path.resolve(workdir),
    messages
  };
}

async function waitForIdle(session, runOutcomes) {
  while (session.isRunning || session.queue.length > 0 || session.activeRun) {
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  const failedRun = runOutcomes.find((outcome) => outcome.error || !outcome.sawTerminalEvent);
  if (!failedRun) {
    return;
  }

  if (failedRun.error) {
    throw failedRun.error;
  }

  throw new Error("Codex exited without a terminal JSON event.");
}

function describeDelta(previousValue, currentValue) {
  if (!Number.isFinite(previousValue) || !Number.isFinite(currentValue)) {
    return { delta: null, trend: "unknown" };
  }

  const delta = currentValue - previousValue;
  if (delta > 0) {
    return { delta, trend: "grew" };
  }
  if (delta < 0) {
    return { delta, trend: "decreased" };
  }
  return { delta, trend: "unchanged" };
}

function printRoundSummary({ round, message, threadId, contextLength, previousContextLength, statusText }) {
  const { delta, trend } = describeDelta(previousContextLength, contextLength);
  const deltaText = delta === null ? "n/a" : String(delta);

  process.stdout.write(
    [
      `round: ${round}`,
      `message: ${message}`,
      `threadId: ${threadId ?? "n/a"}`,
      `context_length_raw: ${Number.isFinite(contextLength) ? contextLength : "n/a"}`,
      `delta_from_previous: ${deltaText}`,
      `trend: ${trend}`,
      "status:",
      statusText,
      ""
    ].join("\n")
  );
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    printHelp();
    return;
  }

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-telegram-relay-verify-"));
  const statePath = path.join(tempDir, "state.json");
  const stateStore = new StateStore(statePath);
  await stateStore.load();

  const botApi = new SilentBotApi();
  const runOutcomes = [];
  const session = new ChatSession({
    botConfig: {
      name: "verify-context-length",
      token: "unused",
      workdir: args.workdir,
      allowedUsernames: [],
      auto: "low"
    },
    botApi,
    stateStore,
    logger: (message) => {
      process.stderr.write(`${message}\n`);
    },
    chatId: 1,
    createCodexRun: (params) => {
      const run = startCodexRun(params);
      const outcome = { error: null, sawTerminalEvent: true };
      runOutcomes.push(outcome);
      run.done
        .then((result) => {
          outcome.sawTerminalEvent = result.sawTerminalEvent;
        })
        .catch((error) => {
          outcome.error = error;
        });
      return run;
    },
    resolveContextLength: readContextLengthForThread
  });
  session.startTyping = () => {};
  session.stopTyping = () => {};

  const observations = [];

  try {
    for (let index = 0; index < args.messages.length; index += 1) {
      const message = args.messages[index];
      runOutcomes.length = 0;
      await session.enqueueMessage(message);
      await waitForIdle(session, runOutcomes);

      const currentContextLength = session.contextLength ?? null;
      const previousContextLength = observations.at(-1)?.contextLength ?? null;
      const observation = {
        round: index + 1,
        message,
        threadId: session.threadId,
        contextLength: currentContextLength,
        statusText: session.statusText()
      };
      observations.push(observation);
      printRoundSummary({
        ...observation,
        previousContextLength
      });
    }

    process.stdout.write("summary:\n");
    for (const observation of observations) {
      process.stdout.write(
        JSON.stringify(
          {
            round: observation.round,
            threadId: observation.threadId,
            contextLength: observation.contextLength
          },
          null,
          2
        )
      );
      process.stdout.write("\n");
    }
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${toErrorMessage(error)}\n`);
  process.exitCode = 1;
});
