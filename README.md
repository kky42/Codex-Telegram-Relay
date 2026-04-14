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
  "bots": [
    {
      "name": "primary",
      "token": "YOUR_TELEGRAM_BOT_TOKEN",
      "workdir": "/Users/you/project",
      "allowedUsernames": ["your-telegram-username"],
      "allowedUserIds": [],
      "codexArgs": ["--search"],
      "runningIndicator": "typing"
    }
  ]
}
```

Notes:

- `workdir` is optional. If omitted, the relay uses your home directory.
- `allowedUsernames` and `allowedUserIds` act as a whitelist. At least one must be configured per bot.
- `codexArgs` is appended to `codex exec` and `codex exec resume`.
- `runningIndicator` supports `typing` or `off`.
- Multiple bots can be configured in the same file and run from one process.

## Behavior

- Only private chats are supported.
- Each `(bot, chat)` pair gets its own Codex thread state and FIFO queue.
- Fresh prompts use `codex -C <workdir> exec --json --skip-git-repo-check <message>`.
- Continued prompts use `codex -C <workdir> exec --json --skip-git-repo-check resume <threadId> <message>`.
- `thread.started` updates the persisted `threadId`.
- `turn.completed` updates the persisted usage snapshot.
- User-visible Telegram messages only come from:
  - completed `agent_message` items
  - completed non-message items rendered as their item type, such as `command_execution`
  - terminal errors
- Start/end and other progress-only events are filtered out of the user-visible chat.

## Slash Commands

- `/status` shows whether Codex is running, the workdir, the latest usage total as `input + output`, and the queued messages.
- `/abort` interrupts Codex and clears the queued messages while keeping the current thread id.
- `/new` interrupts Codex, clears queued messages, and drops the stored thread id so the next prompt starts fresh.

## Development

Run tests with:

```bash
npm test
```

This project uses only Node.js built-ins. No runtime dependencies are required.
