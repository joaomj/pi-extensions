# pi-extensions

Small Pi extensions by Joao Marcos. Each extension lives in `extensions/<name>` and is published to npm independently, so Pi installs them from there:

```sh
pi install npm:@joaomj/pi-claude-usage
```

| Extension | npm package | What it does |
|---|---|---|
| [background-bash](extensions/background-bash) | `@joaomj/pi-background-bash` | Keeps shell commands from blocking the agent; long commands move to the background automatically |
| [claude-usage](extensions/claude-usage) | `@joaomj/pi-claude-usage` | Shows remaining Claude subscription quota (5-hour and weekly) in the footer |

## Develop

Requirements: Node 22+, pnpm 10.

```sh
pnpm install
pnpm run check   # typecheck all extensions
pnpm run test    # run all extension tests
```

Load one extension in isolation:

```sh
pi --no-extensions -e ./extensions/claude-usage/src/index.ts
```

## Release

Each release is driven by [changesets](https://github.com/changesets/changesets):

1. Add a changeset file under `.changeset/` describing the bump (`patch`, `minor`, or `major`) for the changed packages.
2. Merge to `main`. The release workflow opens a version PR; merging it publishes the bumped packages to npm via trusted publishing (no tokens).

First-time setup per published package: on npmjs.com, package Settings → Trusted Publisher → add GitHub repository `joaomj/pi-extensions`.

## License

MIT. See [LICENSE](LICENSE).
