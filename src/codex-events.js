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

  const item = event.item;
  const isItemRecord = item && typeof item === "object" && typeof item.type === "string";

  switch (event.type) {
    case "thread.started":
      return [{ kind: "thread_started", threadId: event.thread_id ?? null }];
    case "turn.completed":
      return [{ kind: "turn_completed" }];
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
    case "item.started":
      if (!isItemRecord || item.type === "agent_message") {
        return [];
      }

      return [{ kind: "progress", text: item.type }];
    case "item.completed": {
      if (!isItemRecord) {
        return [];
      }

      if (item.type === "agent_message") {
        return [{ kind: "message", text: item.text ?? "" }];
      }

      return [{ kind: "progress", text: item.type }];
    }
    default:
      return [];
  }
}
