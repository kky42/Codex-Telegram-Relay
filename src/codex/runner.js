import { spawn } from "node:child_process";

import { buildCodexArgs } from "./args.js";
import { parseJsonlLine } from "./events.js";

function hasChildExited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

export function startCodexRun({
  workdir,
  threadId,
  message,
  imagePaths = [],
  outputLastMessagePath = null,
  ephemeral = false,
  autoMode,
  model,
  reasoningEffort,
  developerInstructions,
  forceKillDelayMs = 3000,
  onEvent = async () => {},
  onStdErr = () => {}
}) {
  const args = buildCodexArgs({
    workdir,
    threadId,
    message,
    imagePaths,
    outputLastMessagePath,
    ephemeral,
    autoMode,
    model,
    reasoningEffort,
    developerInstructions
  });
  const child = spawn("codex", args, {
    cwd: process.cwd(),
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"]
  });

  let stdoutBuffer = "";
  let pending = Promise.resolve();
  let aborted = false;
  let sawTerminalEvent = false;

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");

  child.stdout.on("data", (chunk) => {
    stdoutBuffer += chunk;
    const lines = stdoutBuffer.split(/\r?\n/);
    stdoutBuffer = lines.pop() ?? "";

    for (const line of lines) {
      const event = parseJsonlLine(line);
      if (!event) {
        continue;
      }
      if (event.type === "turn.completed" || event.type === "turn.failed" || event.type === "error") {
        sawTerminalEvent = true;
      }
      pending = pending.then(() => onEvent(event));
    }
  });

  child.stderr.on("data", (chunk) => {
    onStdErr(String(chunk));
  });

  const done = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", async (code, signal) => {
      if (stdoutBuffer.trim()) {
        const event = parseJsonlLine(stdoutBuffer);
        if (event) {
          if (
            event.type === "turn.completed" ||
            event.type === "turn.failed" ||
            event.type === "error"
          ) {
            sawTerminalEvent = true;
          }
          pending = pending.then(() => onEvent(event));
        }
      }

      try {
        await pending;
      } catch (error) {
        reject(error);
        return;
      }

      if (aborted) {
        resolve({ code, signal, aborted: true, sawTerminalEvent });
        return;
      }

      if (code === 0) {
        resolve({ code, signal, aborted: false, sawTerminalEvent });
        return;
      }

      reject(new Error(`codex exited with code ${code}${signal ? ` (signal ${signal})` : ""}`));
    });
  });

  return {
    child,
    done,
    abort() {
      if (aborted || hasChildExited(child)) {
        return;
      }
      aborted = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!hasChildExited(child)) {
          child.kill("SIGKILL");
        }
      }, forceKillDelayMs).unref();
    }
  };
}
