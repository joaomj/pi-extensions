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
2. Merge to `main`. The release workflow opens a version PR with bumped versions and changelogs.
3. Merge the version PR. Nothing is published to npm at this point.
4. Create a GitHub Release with a tag that points at the merged commit (for example `v0.1.1`).
5. Publishing the release stages every package version that is not yet on npm, using trusted publishing (no tokens).
6. Approve the staged packages on npmjs.com. Staged publishing requires a human with 2FA, so this approval cannot be automated.

First-time setup per package on npmjs.com: package Settings → Trusted Publisher → add GitHub repository `joaomj/pi-extensions` with workflow `release.yml`. The trusted publisher only needs `npm stage publish`. Allowing direct `npm publish` would remove the approval step but would also let any published release in this repository push to npm unattended.

## License

MIT. See [LICENSE](LICENSE).
