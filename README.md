# AnyAgent

Run CLI coding agents from chat platforms.

The current implementation ships CLI adapters for `codex`, `claude`, and `pi`, plus one chat
adapter (`telegram`). The internal layout is ready for additional CLI agents such as Pi
and additional chat platforms such as Mattermost.

![codex in telegram example](./assets/example.png)

## Start

Run it directly without installing the package globally:

```bash
npx anyagent
```

Foreground mode keeps the relay attached to the current terminal. If you close the terminal, log out, reboot the computer, or the process crashes, the relay stops.

If you used the previous `codex-telegram-relay` package, the CLI and local
runtime directory have intentionally changed. Move any local config you want to
keep into `~/.anyagent/agents/<agent-id>/config.json`.

## Adapter Layout

- CLI adapters live in `src/cli_adapter/<agent>/`.
- Chat adapters live in `src/chat_adapter/<platform>/`.
- Current adapters: `src/cli_adapter/codex/`, `src/cli_adapter/claude/`, `src/cli_adapter/pi/`, and `src/chat_adapter/telegram/`.

## Config

Default config path: `~/.anyagent/agents`

Each agent lives in its own directory:

```json
{
  "profile": {
    "cli": "codex",
    "workdir": "/Users/you/project",
    "auto": "medium",
    "model": "gpt-5.4",
    "reasoningEffort": "xhigh"
  },
  "bindings": {
    "telegram": {
      "allowedUsernames": ["your-telegram-username"],
      "bots": [
        {
          "username": "your_bot_username",
          "token": "YOUR_TELEGRAM_BOT_TOKEN"
        }
      ]
    }
  }
}
```

Notes:

- `profile.cli` can be `codex`, `claude`, or `pi`.
- `profile.workdir` is optional. If omitted, the relay uses your home directory. It must already exist.
- `profile.auto` defaults to `medium`.
- `profile.model` and `profile.reasoningEffort` default to `default`, which means the relay does not pass a CLI-specific override.
- `bindings.telegram.allowedUsernames` and bot usernames accept values with or without `@` and are normalized to lowercase.
- If you do not know your Telegram username, send the bot any message once. The unauthorized reply shows the normalized username to add.
- A single agent directory can bind to multiple Telegram bots, and the same agent profile can be reused by multiple chat platforms later.

## Persistent Deployment

The relay does not daemonize itself and does not restart itself after crashes or reboots. For always-on usage, run it under a process manager.

### PM2 Example

Use PM2 when you want the relay to keep running in the background and restart automatically after crashes:

```bash
npm install -g pm2 anyagent
pm2 start anyagent --name anyagent
pm2 save
```

Useful PM2 commands:

- `pm2 status`
- `pm2 logs anyagent`
- `pm2 restart anyagent`
- `pm2 stop anyagent`

## Telegram Commands

- `/status` shows running state, current workdir, auto/model/reasoning values, the latest context length, and the queued messages for the current chat.
- `/workdir` shows the current chat workdir.
- `/workdir <path>` changes the current chat workdir. Only absolute paths and `~/...` are accepted.
- `/auto` shows the current auto level.
- `/auto <low|medium|high>` sets the auto level for future runs in the current chat.
- `/model` shows the current model value.
- `/model <value>` sets the model for future runs in the current chat. Use `/model default` to return to CLI defaults.
- `/reasoning` shows the current reasoning value.
- `/reasoning <value>` sets reasoning effort for future runs in the current chat. Use `/reasoning default` to return to CLI defaults.
- `/reset` reloads the current agent config from disk, clears chat-specific overrides, and starts a fresh session for this chat.
- `/clear_cache` deletes cached Telegram attachments for the current Telegram bot instance.
- `/abort` interrupts the active agent run and clears the queued messages while keeping the current `sessionId`.
- `/new` interrupts the active agent run, clears queued messages, and drops the current chat's stored `sessionId`.

## Behavior

- Only private chats are supported.
- Startup discards pending Telegram updates so messages and slash commands sent while the relay was stopped are not processed after restart.
- Each `(Telegram bot, chat)` pair has its own in-memory queue, `sessionId`, and usage state.
- Supported Telegram attachments are `photo`, `document`, `video`, `audio`, `voice`, and `animation`.
- Supported attachments are downloaded to `~/.anyagent/cache/telegram/<bot-username>/c<base36-chat-id>/...` and passed to every agent by local file path in the prompt.
- Attachment paths are rendered as `<attachments>` XML blocks with one `<attachment path="..." kind="..." />` entry per downloaded file, including photos.
- Telegram media albums are grouped by `media_group_id` and submitted as one logical agent turn.
- Attachments larger than 20 MB are rejected.
- Codex fresh prompts use `codex exec --json --skip-git-repo-check`; continued prompts use `codex exec resume`.
- Claude fresh prompts use `claude -p --output-format stream-json`; continued prompts use `claude -p --output-format stream-json --resume <session-id>`.
- Pi fresh prompts use `pi -p --mode json`; continued prompts use `pi -p --mode json --session <session-id>`.
- The relay maps `auto` to each CLI's permission model. Codex uses `read-only`, `workspace-write`, or dangerous bypass. Claude uses `dontAsk`, `acceptEdits`, or `--dangerously-skip-permissions`.
- Pi uses `--sandbox readonly`, `--sandbox on`, or `--sandbox off` when the installed Pi extensions expose the `--sandbox` flag, such as `@kky42/pi-sandbox`. If the flag is not available, the relay starts Pi without sandbox arguments.
- Fresh interactive sessions inject only a relay attachment contract using `<attachments>` XML blocks; Telegram-specific formatting is handled by the relay. Claude receives this contract through `--append-system-prompt`.
- The relay keeps `sessionId` and the latest `context_length` in memory for the chat while the process is running.
- Codex `context_length` is derived from the final `token_count.last_token_usage` event in the Codex rollout file under `~/.codex/sessions/...`. Claude `context_length` is derived from the streamed result usage. Pi `context_length` is derived from the final assistant `usage.totalTokens` value in the JSON event stream or saved session file under `~/.pi/agent/sessions/...`.
- Completed Codex `agent_message` items, Claude text response events, and Pi assistant `message_end` events become the visible final reply. Pi text deltas are not forwarded one by one.
- Non-message items such as `reasoning`, `web_search`, and `command_execution` reuse one in-flight Telegram message that is edited as progress changes.
- Telegram converts agent Markdown replies to Telegram-safe HTML, sends with `HTML` parse mode first, then falls back to `MarkdownV2` or plain text if parsing still fails.
- Slash commands that change settings only affect the invoking chat session.
- `/clear_cache` is bot-wide. It clears only `~/.anyagent/cache/telegram/<bot-username>/` and refuses to run while turns or media albums are pending.
- `/workdir <path>` only affects the invoking chat, aborts its current run, clears that chat's queue, and resets that chat to a fresh agent session.
- `/abort` affects only the interactive run and queue for the current chat.
