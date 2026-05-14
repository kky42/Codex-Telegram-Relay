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

## Telegram Network Notes

- This project calls the Telegram Bot API through Node's `fetch`, so Telegram reachability in the Telegram app does not guarantee reachability from the terminal.
- If `npm start` fails with `TypeError: fetch failed` and the underlying cause is `ECONNRESET` before the TLS handshake to `api.telegram.org`, treat it as a local network or proxy-path issue first, not a bot logic regression.
- In environments that use a local HTTP proxy such as `127.0.0.1:7890`, start the relay with explicit proxy variables when Node is not automatically inheriting the proxy path:

```bash
HTTP_PROXY=http://127.0.0.1:7890 HTTPS_PROXY=http://127.0.0.1:7890 npm start
```

- This is especially relevant when `api.telegram.org` resolves to a proxy fake-IP range such as `198.18.0.0/15`; in that case, Node may fail unless the proxy variables are set explicitly.

## Adapter Layout

- The package and CLI are named `anyagent`.
- CLI-agent adapters live under `src/cli_adapter/<agent>/`.
- Chat adapters live under `src/chat_adapter/<platform>/`.
- The current concrete adapters are `src/cli_adapter/codex/` and `src/chat_adapter/telegram/`.
- Keep Codex-specific command construction, event decoding, and context-length logic inside the Codex CLI adapter.
- Keep Telegram Bot API calls, Telegram command routing, Telegram rendering, Telegram attachment handling, and Telegram output instructions inside the Telegram chat adapter.
- Do not add root-level compatibility shims for old module locations.

## Secrets And Local Config

- Never commit Telegram bot tokens, local usernames, or any real user identifiers.
- Never commit files from `~/.anyagent/`; that directory is local runtime state and config only.
- Keep examples and tests generic. Use placeholders such as `YOUR_TELEGRAM_BOT_TOKEN` and `your-telegram-username`.
- Before committing, scan staged changes for secrets or personal paths and remove them.

## Relay Behavior Decisions

- Bot-level and chat-level `auto` values use three levels:
  - `low` => `codex exec --sandbox read-only`
  - `medium` => `codex exec --sandbox workspace-write`
  - `high` => `codex exec --dangerously-bypass-approvals-and-sandbox`
- `/abort` only affects the interactive run and queued interactive messages for the current chat.

## Codex Instruction Injection

- Before changing any system prompt, appended system prompt, developer instruction, artifact/attachment contract, or user message prompt construction, discuss the proposed change with the user and get explicit permission.
- For relay-specific response-shaping rules, prefer `developer_instructions`.
- Experimental result in local `codex exec` runs:
  - `developer_instructions` is injected as an additional developer message for that turn and affects model behavior immediately.
  - `instructions` did not show a meaningful effect in the current CLI version and should be treated as reserved for future use.
  - `model_instructions_file` is heavier-weight: it can override the normal model-instructions / `AGENTS.md` layer. Do not use it for the relay's Telegram formatting policy.
- For this relay, inject `developer_instructions` only when starting a fresh Codex session.
- Do not resend `developer_instructions` on `codex exec resume` for an already-bootstrapped session.

## Release Automation

- npm publishing is handled by GitHub Actions in [`.github/workflows/publish.yml`](.github/workflows/publish.yml).
- Keep all release-process notes in `AGENTS.md`, not in `README.md`. `README.md` is user-facing only.

### Required GitHub/NPM Configuration

- GitHub Actions must be enabled for this repository.
- The repository must define a GitHub Actions secret named `NPM_TOKEN`.
- `NPM_TOKEN` should be an npm automation token belonging to an account that is allowed to publish the package.
- The release tag must be pushed to a commit that already contains [`.github/workflows/publish.yml`](.github/workflows/publish.yml), otherwise no publish workflow will run.
- The repository `GITHUB_TOKEN` must retain permission to create releases. The workflow uses it to create a GitHub Release after a successful npm publish.

### Release Preconditions Checklist

- Confirm [`.github/workflows/publish.yml`](.github/workflows/publish.yml) exists on the branch that will receive the release tag.
- Confirm the package name in `package.json` is the one intended for npm publication.
- Confirm the npm account behind `NPM_TOKEN` has publish access for that package name.
- Confirm `package.json` `version` has been updated to the exact version to be released.
- Confirm the working tree does not contain secrets, local usernames, or paths that must not be committed.
- Confirm the test suite passes before creating or pushing the release tag.

### Required Release Confirmation With User

- Before every real release, the assistant must inspect the unreleased changes and recommend a concrete semantic version bump.
- The assistant must explicitly confirm the proposed version number with the user before creating or pushing any release tag.
- The assistant must draft a concise release summary before release and explicitly confirm it with the user.
- The release summary must use simple language and mention only important features, important fixes, or breaking changes.
- The release summary must not turn into a changelog and must not include minor internal refactors unless they materially affect users or operators.
- If version confirmation or release-summary confirmation is missing, the assistant must stop before tagging or triggering release automation.

### Trigger And Version Rules

- The publish workflow is triggered only by pushing a Git tag in the exact `vX.Y.Z` format.
- The workflow strips the leading `v` from the tag and compares the rest to `package.json` `version`.
- Example: tag `v0.1.1` requires `"version": "0.1.1"` in `package.json`.
- If the tag and `package.json` version do not match exactly, the workflow fails intentionally and nothing is published.
- Tags such as `0.1.1`, `release-0.1.1`, or `v0.1` do not match the workflow trigger and will not publish.
- The same workflow also supports a manual `workflow_dispatch` run for safe validation. Manual runs do not publish to npm and do not create a GitHub Release; they only run install, tests, `npm whoami`, and `npm publish --dry-run`.

### Expected Release Flow

- Update `package.json` to the release version, or use `npm version patch|minor|major` to do it and create the matching tag.
- Push the branch commit that contains the version bump and the publish workflow.
- Push the corresponding `vX.Y.Z` tag to GitHub.
- GitHub Actions will then install dependencies, run `npm test`, verify the tag/version match, run `npm publish`, and create a GitHub Release for the same tag with generated release notes.

The expected command sequence is:

```bash
npm version patch
git push origin main
git push origin --tags
```

### Common Publish Failures

- `NPM_TOKEN` is missing in GitHub repository secrets.
- `NPM_TOKEN` exists but the npm account does not have publish permission.
- `npm whoami` fails in GitHub Actions, which means `NPM_TOKEN` is invalid or lacks registry access.
- The tag format is wrong, so the workflow is never triggered.
- The tag points to a commit that does not yet contain the publish workflow.
- The tag version and `package.json` version do not match.
- `npm test` fails in GitHub Actions, which blocks `npm publish`.
- GitHub Release creation can fail if repository release permissions are disabled or the workflow loses `contents: write`.
