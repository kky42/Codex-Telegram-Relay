# Codex Telegram Relay

Small Telegram relay for `codex exec`.

## Run

```bash
npm install
npm start
```

Or after publishing:

```bash
npx codex-telegram-relay
```

## Config

Default config path: `~/.codex-telegram-relay/config.json`

Default state path: `~/.codex-telegram-relay/state.json`

Example:

```json
{
  "allowedUsernames": ["your-telegram-username"],
  "bots": [
    {
      "name": "primary",
      "token": "YOUR_TELEGRAM_BOT_TOKEN",
      "workdir": "/Users/you/project",
      "yolo": true,
      "model": "default",
      "reasoningEffort": "default"
    }
  ]
}
```

Notes:

- Top-level `allowedUsernames` is optional and merged into every bot.
- Bot-level `allowedUsernames` is optional and is merged with the top-level list.
- `allowedUsernames` matching is case-insensitive and accepts values with or without `@`.
- `name` must be unique and may contain only letters, numbers, `_`, and `-`.
- `workdir` is optional. If omitted, the relay uses your home directory. It must already exist.
- `yolo` defaults to `true`.
- `model` and `reasoningEffort` default to `default`, which means the relay does not pass an override to `codex exec`.
- `yolo: false` maps to `codex exec --sandbox read-only`.
- `yolo: true` maps to `codex exec --dangerously-bypass-approvals-and-sandbox`.
- If you do not know your Telegram username, send the bot any message once. The unauthorized reply shows the normalized username to add.
- Multiple bots can be configured in one file and run in one process.

## Behavior

- Only private chats are supported.
- Each `(bot, chat)` pair has its own queue, `threadId`, and usage state.
- Fresh prompts use `codex exec --json --skip-git-repo-check`; continued prompts use `codex exec resume`.
- The relay persists `threadId` from `thread.started` and cumulative usage from `turn.completed`.
- `context_length` is derived from the final `token_count.last_token_usage` event in the thread's rollout file under `~/.codex/sessions/...`.
- Completed `agent_message` items become the visible final reply.
- Non-message items such as `reasoning`, `web_search`, and `command_execution` reuse one in-flight Telegram message that is edited as progress changes.
- Slash commands that change bot settings persist those defaults to `config.json`. They apply immediately to the invoking chat; other already-loaded chats keep their current in-memory settings until restart.
- `/workdir <path>` is bot-wide. It updates the stored bot workdir, aborts the invoking chat's current run, clears that chat's queue, and resets that chat to a fresh Codex session.

## Commands

- `/status` shows running state, current workdir, yolo/model/reasoning values, the latest context length, and the queued messages for the current chat.
- `/workdir` shows the current bot workdir.
- `/workdir <path>` changes the bot workdir. Only absolute paths and `~/...` are accepted.
- `/yolo` toggles between read-only and full-access for future runs in the current chat and persists the bot default.
- `/yolo on` switches to full-access mode.
- `/yolo off` switches to read-only mode.
- `/model` shows the current model value.
- `/model <value>` sets the model for future runs in the current chat and persists the bot default. Use `/model default` to return to CLI defaults.
- `/reasoning` shows the current reasoning value.
- `/reasoning <value>` sets reasoning effort for future runs in the current chat and persists the bot default. Use `/reasoning default` to return to CLI defaults.
- `/abort` interrupts Codex and clears the queued messages while keeping the current `threadId`.
- `/new` interrupts Codex, clears queued messages, and drops the current chat's stored `threadId`.

## Development

Run tests:

```bash
source ~/.zshrc >/dev/null 2>&1 && npm test
```

Audit multi-round `context_length` growth with real Codex runs:

```bash
source ~/.zshrc >/dev/null 2>&1 && npm run verify:context-length -- --workdir /path/to/project --message "first prompt" --message "follow up"
```
