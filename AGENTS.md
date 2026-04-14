# AGENTS

## Shell Environment

- In this repo, `node` and `npm` come from `nvm` initialized in `~/.zshrc`.
- Codex command execution may use a non-interactive shell that does not load `~/.zshrc` automatically.
- Before running any `node`, `npm`, or `npx` command here, use:

```bash
source ~/.zshrc >/dev/null 2>&1 && <command>
```

Examples:

```bash
source ~/.zshrc >/dev/null 2>&1 && npm test
source ~/.zshrc >/dev/null 2>&1 && node --version
```

## Secrets And Local Config

- Never commit Telegram bot tokens, local usernames, or any real user identifiers.
- Never commit files from `~/.codex-telegram-relay/`; that directory is local runtime state and config only.
- Keep examples and tests generic. Use placeholders such as `YOUR_TELEGRAM_BOT_TOKEN` and `your-telegram-username`.
- Before committing, scan staged changes for secrets or personal paths and remove them.
