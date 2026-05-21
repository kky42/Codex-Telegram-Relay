export async function routeCommandOrTurn({
  command,
  args = "",
  text = "",
  session,
  runtime,
  replyTarget = null
}) {
  switch (command) {
    case "status":
      await session.handleStatus({ replyTarget });
      return;
    case "auto":
      await session.handleAuto(args, { replyTarget });
      return;
    case "workdir":
      await session.handleWorkdir(args, { replyTarget });
      return;
    case "cli":
      await session.handleCli(args, { replyTarget });
      return;
    case "model":
      await session.handleModel(args, { replyTarget });
      return;
    case "reasoning":
      await session.handleReasoningEffort(args, { replyTarget });
      return;
    case "clear_cache":
      await runtime.handleClearCache(session, { replyTarget });
      return;
    case "abort":
      await session.handleAbort({ replyTarget });
      return;
    case "new":
      await session.handleNewSession({ replyTarget });
      return;
    case "reset":
      await session.handleReset({ replyTarget });
      return;
    default:
      await session.enqueueMessage(text, { replyTarget });
  }
}
