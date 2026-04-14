export function parseJsonlLine(line) {
  const trimmed = String(line || "").trim();
  if (!trimmed) {
    return null;
  }

  try {
    const parsed = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== "object" || typeof parsed.type !== "string") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function eventToActions(event) {
  if (!event || typeof event !== "object") {
    return [];
  }

  switch (event.type) {
    case "thread.started":
      return [{ kind: "thread_started", threadId: event.thread_id ?? null }];
    case "turn.completed":
      return [
        {
          kind: "turn_completed",
          cumulativeUsage: {
            inputTokens: Number(event.usage?.input_tokens ?? 0),
            cachedInputTokens: Number(event.usage?.cached_input_tokens ?? 0),
            outputTokens: Number(event.usage?.output_tokens ?? 0)
          }
        }
      ];
    case "turn.failed":
      return [
        {
          kind: "error",
          text: `Codex failed: ${event.error?.message ?? "turn failed"}`
        }
      ];
    case "error":
      return [
        {
          kind: "error",
          text: `Codex error: ${event.message ?? "unknown error"}`
        }
      ];
    case "item.completed": {
      const item = event.item;
      if (!item || typeof item !== "object" || typeof item.type !== "string") {
        return [];
      }

      if (item.type === "agent_message") {
        return [{ kind: "message", text: item.text ?? "" }];
      }

      return [{ kind: "message", text: item.type }];
    }
    default:
      return [];
  }
}
