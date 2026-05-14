function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asFiniteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function usageToContextLength(usage) {
  if (!isRecord(usage)) {
    return null;
  }

  const totalTokens = asFiniteNumber(usage.totalTokens);
  if (totalTokens !== null && totalTokens > 0) {
    return totalTokens;
  }

  const input = asFiniteNumber(usage.input);
  const output = asFiniteNumber(usage.output);
  const cacheRead = asFiniteNumber(usage.cacheRead ?? 0);
  const cacheWrite = asFiniteNumber(usage.cacheWrite ?? 0);
  if (input === null || output === null || cacheRead === null || cacheWrite === null) {
    return null;
  }

  return input + output + cacheRead + cacheWrite;
}

function contentBlockText(block) {
  if (!isRecord(block) || block.type !== "text") {
    return null;
  }

  return typeof block.text === "string" ? block.text : "";
}

function assistantText(message) {
  if (!isRecord(message)) {
    return "";
  }

  if (!Array.isArray(message.content)) {
    return typeof message.content === "string" ? message.content : "";
  }

  return message.content
    .map(contentBlockText)
    .filter((text) => text !== null)
    .join("");
}

export function parseJsonlLine(line) {
  const trimmed = String(line || "").trim();
  if (!trimmed) {
    return null;
  }

  try {
    const parsed = JSON.parse(trimmed);
    if (!isRecord(parsed) || typeof parsed.type !== "string") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/**
 * @param {any} event
 * @returns {import("../types.js").CliAction[]}
 */
export function eventToActions(event) {
  if (!isRecord(event)) {
    return [];
  }

  switch (event.type) {
    case "session":
      return [{ kind: "session_started", sessionId: event.id ?? null }];
    case "message_end": {
      if (!isRecord(event.message) || event.message.role !== "assistant") {
        return [];
      }

      const actions = [];
      if (event.message.stopReason === "error") {
        actions.push({
          kind: "error",
          text: `Pi failed: ${event.message.errorMessage ?? "turn failed"}`
        });
      }

      const contextLength = usageToContextLength(event.message.usage);
      if (contextLength !== null) {
        actions.push({ kind: "context_length", contextLength });
      }

      const text = assistantText(event.message);
      if (text) {
        actions.push({ kind: "message", text });
      }

      return actions;
    }
    case "turn_end": {
      const actions = [];
      const contextLength = usageToContextLength(event.message?.usage);
      if (contextLength !== null) {
        actions.push({ kind: "context_length", contextLength });
      }
      actions.push({ kind: "turn_completed" });
      return actions;
    }
    case "agent_end":
      return [{ kind: "turn_completed" }];
    case "tool_execution_start":
      return typeof event.toolName === "string" && event.toolName
        ? [{ kind: "progress", text: event.toolName }]
        : [];
    case "compaction_start":
      return [{ kind: "progress", text: `compaction_${event.reason ?? "start"}` }];
    case "auto_retry_start":
      return [{ kind: "progress", text: `retry_${event.attempt ?? "start"}` }];
    case "compaction_end":
      if (!event.errorMessage) {
        return [];
      }
      return [{ kind: "error", text: `Pi compaction failed: ${event.errorMessage}` }];
    case "auto_retry_end":
      if (event.success || !event.finalError) {
        return [];
      }
      return [{ kind: "error", text: `Pi retry failed: ${event.finalError}` }];
    default:
      return [];
  }
}
