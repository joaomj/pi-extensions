# pi-claude-usage

Pi extension that shows your remaining Claude subscription quota — the 5-hour session window and the weekly window — as a segment in Pi's footer while the session uses Claude.

```text
claude 5h:100% ↻4h12m wk:91% ↻1d21h
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

The segment appears only when the active model uses Claude:

- `claude-directsdk`, or another provider whose id starts with `claude`.
- `anthropic`, when Pi is signed in to that provider with OAuth.

Sessions that use another provider do not load the quota code, read your Claude login, or contact the usage endpoint in the background. Running `/claude-account` is an explicit exception.

The extension loads in the background after a Claude session starts. When a cached value exists, it appears immediately. Keychain and network work starts two seconds after the session starts, and only when the cached value is missing or older than five minutes. Switching to a non-Claude model clears the segment. Switching back restores it from the cache.

The footer stays current for the whole session:

- It re-renders every 15 seconds, so the reset countdown keeps ticking between requests.
- It requests fresh numbers when a run starts, at each turn boundary, and when a run settles.
- Requests are throttled to at most one per minute, and a window whose reset time has passed triggers one more request so the percentage jumps back up instead of staying stale.
- The five-minute cache only avoids network work in the first seconds after a session starts.

### Choose an account

When several Claude logins exist on the machine, pick which account the footer shows:

```sh
/claude-account
```

The picker lists every login found together with its live weekly remainder so accounts are distinguishable. The choice persists in `~/.config/pi-claude-usage/config.json`.

An explicit choice never falls back to another account. If the selected login cannot return data, the segment keeps the last value for that login or clears. `/claude-account auto` returns to first-working-wins.

## Develop locally

From the source repository root:

```bash
pnpm install --frozen-lockfile
pi --no-extensions -e ./extensions/claude-usage/src/index.ts
```

## How it works

Numbers come from the same unofficial endpoint Claude Code's own `/status` uses (`GET https://api.anthropic.com/api/oauth/usage`). The OAuth token is sent only there — never logged, never persisted. Per-account snapshots cache under `~/.cache/pi-claude-usage.json`.

The extension entry point has no runtime imports. The quota implementation, Keychain access, and network client load only when the session switches to Claude.

## Limitations

- The endpoint is unofficial and undocumented. If Anthropic rate-limits or reshapes it, the footer keeps the last cached numbers (or clears) instead of erroring.
- Expired tokens are skipped, not refreshed; signing in or running Claude Code rotates them.
- On macOS the first read may trigger one Keychain approval prompt for the terminal.

## License

MIT.
