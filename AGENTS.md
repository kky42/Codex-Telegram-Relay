# AGENTS

## Shell Environment

- In this repo, `node`, `npm`, and `npx` come from the `nvm` toolchain.
- In the current Codex terminal environment, these commands are available directly without prepending `source ~/.zshrc`.
- If a future shell session fails to resolve them, use the following fallback:

```bash
source ~/.zshrc >/dev/null 2>&1 && <command>
```

Examples:

```bash
npm test
node --version
npx tsc --noEmit
```

## Secrets And Local Config

- Never commit Telegram bot tokens, local usernames, or any real user identifiers.
- Never commit files from `~/.codex-telegram-relay/`; that directory is local runtime state and config only.
- Keep examples and tests generic. Use placeholders such as `YOUR_TELEGRAM_BOT_TOKEN` and `your-telegram-username`.
- Before committing, scan staged changes for secrets or personal paths and remove them.
