import { spawn } from "node:child_process";

import { parseJsonlLine } from "./codex-events.js";
import { YOLO_OFF } from "./yolo.js";

export function buildCodexArgs({
  workdir,
  threadId,
  message,
  yolo = YOLO_OFF
}) {
  const modeArgs = yolo
    ? ["--dangerously-bypass-approvals-and-sandbox"]
    : ["--sandbox", "read-only"];
  const baseArgs = ["-C", workdir, "exec", "--json", "--skip-git-repo-check", ...modeArgs];

  if (threadId) {
    return [...baseArgs, "resume", threadId, message];
  }

  return [...baseArgs, message];
}

export function startCodexRun({
  workdir,
  threadId,
  message,
  yolo = YOLO_OFF,
  onEvent = async () => {},
  onStdErr = () => {}
}) {
  const args = buildCodexArgs({ workdir, threadId, message, yolo });
  const child = spawn("codex", args, {
    cwd: workdir,
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
      if (aborted || child.killed) {
        return;
      }
      aborted = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!child.killed) {
          child.kill("SIGKILL");
        }
      }, 3000).unref();
    }
  };
}
