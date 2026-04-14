# Codex Telegram Relay

Lightweight Codex x Telegram bot relay.

## Requirements

- Node.js 20+
- `codex` CLI available in `PATH`
- One or more Telegram bot tokens

## Install

```bash
npm install
npm start
```

Or run it directly after publishing:

```bash
npx codex-telegram-relay
```

## Config

Default config path: `~/.codex-telegram-relay/config.json`

Default state path: `~/.codex-telegram-relay/state.json`

Example config:

```json
{
  "allowedUsernames": ["your-telegram-username"],
  "bots": [
    {
      "name": "primary",
      "token": "YOUR_TELEGRAM_BOT_TOKEN",
      "workdir": "/Users/you/project",
      "yolo": false
    }
  ]
}
```

Notes:

- Top-level `allowedUsernames` is optional and defaults to an empty array. It applies to every bot.
- Bot-level `allowedUsernames` is optional and is merged with the top-level list for that bot.
- `name` must be unique and may contain only letters, numbers, `_`, and `-`.
- `workdir` is optional. If omitted, the relay uses your home directory. The configured path must already exist.
- `yolo` is optional and defaults to `false`.
- `yolo: false` maps to `codex exec --sandbox read-only`.
- `yolo: true` maps to `codex exec --dangerously-bypass-approvals-and-sandbox`.
- `allowedUsernames` entries are matched case-insensitively and may be written with or without a leading `@`.
- If you do not know your Telegram username, send the bot any message once. The unauthorized reply tells you which username to put in `allowedUsernames`.
- Accounts without a Telegram username are not allowed until a username is set in Telegram.
- Multiple bots can be configured in the same file and run from one process.

## Behavior

- Only private chats are supported.
- Each `(bot, chat)` pair gets its own Codex thread state and FIFO queue.
- Fresh prompts use either:
  - `codex -C <workdir> exec --json --skip-git-repo-check --sandbox read-only <message>`
  - `codex -C <workdir> exec --json --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox <message>`
- Continued prompts use the same mode with `resume <threadId> <message>`.
- `thread.started` updates the persisted `threadId`.
- `turn.completed` updates the persisted cumulative usage totals.
- The latest context length is read from the matching Codex rollout log, using the final `token_count.last_token_usage` event.
- User-visible Telegram messages only come from:
  - completed `agent_message` items
  - completed non-message items rendered as their item type, such as `command_execution`
  - terminal errors
- Start/end and other progress-only events are filtered out of the user-visible chat.

## Slash Commands

- `/status` shows whether Codex is running, the workdir, the latest context length, the latest per-turn usage total, and the queued messages.
- `/yolo` toggles between read-only and full-access for future runs.
- `/yolo on` switches future runs to full-access mode.
- `/yolo off` switches future runs to read-only mode.
- `/abort` interrupts Codex and clears the queued messages while keeping the current thread id.
- `/new` interrupts Codex, clears queued messages, and drops the stored thread id so the next prompt starts fresh.

## Development

Run tests with:

```bash
npm test
```

This project uses only Node.js built-ins. No runtime dependencies are required.
