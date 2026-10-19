# pi-claude-usage

Pi extension that shows your remaining Claude subscription quota — the 5-hour session window and the weekly window — as a segment in Pi's footer.

```text
claude 5h:100% wk:91% ↻1d21h
```

## Requirements

- A Claude paid plan with this device signed in: `claude auth login`.
- macOS or Linux. On macOS the token is read from the login keychain item `Claude Code-credentials`; on Linux it is read from `~/.claude/.credentials.json` (or `$CLAUDE_CONFIG_DIR/.credentials.json`).

## Install

```sh
pi install npm:@joaomj/pi-claude-usage
```

After installation, restart Pi or run `/reload`.

## Usage

The segment refreshes on session start and after each agent run. API results are cached for 5 minutes and the endpoint is hit at most once per minute, so the footer never slows down your session.

When several Claude logins exist on the machine, pick which account the footer shows:

```sh
/claude-account
```

The picker lists every login found together with its live weekly remainder so accounts are distinguishable. The choice persists in `~/.config/pi-claude-usage/config.json`; `/claude-account auto` returns to first-working-wins.

## Develop locally

From the source repository root:

```bash
pnpm install --frozen-lockfile
pi --no-extensions -e ./extensions/claude-usage/src/index.ts
```

## How it works

Numbers come from the same unofficial endpoint Claude Code's own `/status` uses (`GET https://api.anthropic.com/api/oauth/usage`). The OAuth token is sent only there — never logged, never persisted. Per-account snapshots cache under `~/.cache/pi-claude-usage.json`.

## Limitations

- The endpoint is unofficial and undocumented. If Anthropic rate-limits or reshapes it, the footer keeps the last cached numbers (or clears) instead of erroring.
- Expired tokens are skipped, not refreshed; signing in or running Claude Code rotates them.
- On macOS the first read may trigger one Keychain approval prompt for the terminal.

## License

MIT.
