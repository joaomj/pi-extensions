# pi-background-bash

Keep shell commands from blocking the agent. Known long-running commands start in the background immediately; any other command moves there after 30 seconds without stopping. Background jobs survive Pi exit, and logs have a per-job limit.

This extension derives from `@richardgill/pi-background-bash` with durable background routing added. The published upstream package does not include these changes.

## Install

```bash
pi install npm:@joaomj/pi-background-bash
```

After installation, run `/reload` or restart Pi.

The extension registers `bash`, `bash_process`, and `/proc`. Remove other background runners and extensions that rewrite shell timeouts before enabling it.

## Develop locally

From the source repository root:

```bash
pnpm install --frozen-lockfile
pi --no-extensions -e ./extensions/background-bash/src/index.ts
```

## Run commands

```ts
type BashInput = {
  command: string;
  name?: string;
  background?: boolean;
  timeout?: number;
};
```

By default, `bash` waits up to 30 seconds. A command that exceeds this limit continues in the background as the same process. The agent receives a job ID and can continue other work. The maximum foreground window also defaults to 30 seconds. A timeout never kills a command.

Use `background: true` to return a job ID immediately. This option ignores `timeout`. Cancel a job explicitly with `bash_process`. Cancellation first sends SIGTERM, then SIGKILL after 500 milliseconds if necessary.

### Automatic background routing

The extension classifies each command before it runs. A command known to run long starts in the background immediately, whatever the model requested, and the result names the reason. The model cannot keep such a command in the foreground.

The classifier recognizes these categories:

- Test suites and repository-wide checks: test runners, package-manager test scripts, task-runner test targets, test scripts such as `./run_tests.sh`, type checkers, and security scanners.
- Builds, dependency installs, containers, infrastructure, and deployments.
- Database migrations, dumps, and restores.
- Servers, watchers, and followed logs.
- Waits and polls, such as `gh run watch`, `sleep 5` or longer, and endless loops.
- Remote sessions and network diagnostics, such as `ssh`, `rsync`, `ping`, `mtr`, and `tcpdump`.
- Downloads, media and model processing, benchmarks, and scans of the whole disk or home directory.

It looks through wrappers such as `cd dir &&`, `sudo`, `env`, `uv run`, `npx`, `pnpm exec`, `docker compose exec`, and `bash -c`, and through heredocs fed to a shell. Quoted text, heredoc data, `--version`, and `--help` do not trigger it.

The classifier is a fixed rule set, not a model. A long command outside these categories still moves to the background after the timeout. A short command inside a category, such as `ssh host uptime`, reports through the completion message instead of inline.

Commands use Pi's configured shell and command prefix. Output sent to the model follows Pi's 50 KiB and 2,000-line limits. Each command also writes a private combined stdout/stderr log.

Examples:

```text
Run npm test with bash. Let automatic promotion release the agent if the command takes longer than 30 seconds.
Run a dev server with bash, background true, and name dev-server.
Run pytest with bash. The extension moves it to the background immediately.
```

After promotion, do not poll or restart the command. Completion produces a follow-up message and wakes the agent while its owning session is active.

## Inspect and cancel jobs

```ts
type BashProcessInput =
  | { action: "list" }
  | { action: "peek"; jobId: string }
  | { action: "kill"; jobId: string };
```

`list` shows active jobs in the current session. `peek` returns bounded captured output. `kill` asks the detached runner to cancel its own command and suppresses the automatic completion message.

Use the persistent `jobId`, not a process ID, for inspection and cancellation. A process ID can be reused by the operating system. Cancellation does not signal a process identified only by a saved PID.

Run `/proc` to select a job and confirm cancellation. The footer shows the active background count.

## Recovery and storage

A detached Node.js runner owns each command and its output capture. Pi does not need to remain open for the command to finish.

Background jobs survive `/reload`, session replacement, and Pi exit, including an abrupt host termination. Graceful session shutdown still cancels commands that have not moved to the background. An abruptly interrupted foreground command is recovered rather than restarted.

Resume the original session to recover its running jobs and undelivered results. Other sessions do not receive these results or control these jobs. Pi cannot wake a closed process or a session that is not active.

Records and logs live under `<os-temp-dir>/pi-background-bash/<session-hash>/<job-id>/`. The default root uses Node.js `os.tmpdir()`, which follows the operating system and temporary-directory environment settings. OS cleanup can remove these records, so recovery lasts only while they remain. Set `outputDir` to a persistent directory when longer retention is required. A relative `outputDir` resolves from the session's working directory. Keep that setting stable to recover earlier jobs.

Directories use mode `0700`. Record and log files use mode `0600`. Environment variables are inherited by the runner but are not written into job records. Commands and command output can still contain secrets; protect the storage directory.

A completion record is separate from command output. Output cannot imitate an exit record. The extension acknowledges a completion only when the message is in the session history. Queued messages remain recoverable after host exit. On resume, the extension checks both delivery markers and persisted messages to avoid replay. Each completion includes its stable job ID.

If a runner disappears without an exit record, the extension reports an unknown outcome. It does not restart the command or infer success.

## Log limits

`maxLogBytes` defaults to 2,097,152 bytes (2 MiB) per job. The runner keeps the first bytes up to that limit and continues draining excess output. Reaching the limit does not kill the command or change its exit status.

Completion reports how much output was discarded. A capped log is an incomplete record; do not infer that missing diagnostics indicate success. Increase the limit before a future run when the complete output is required.

`preserveOutputFiles` defaults to `true`. Set it to `false` to remove a job's records and log after completion is handled. It never removes a running job during session shutdown. Preserved jobs have no automatic retention policy; remove old completed records when needed. The cap limits each log, not total disk use.

## Configuration

Create `~/.pi/agent/background-bash.jsonc`:

```jsonc
{
  "defaultTimeoutSeconds": 30,
  "maxTimeoutSeconds": 30,
  "maxLogBytes": 2097152,
  "preserveOutputFiles": true
}
```

`maxLogBytes` must be a positive safe integer. Timeout settings must be positive whole numbers. `defaultTimeoutSeconds` must not exceed `maxTimeoutSeconds`.

Optional settings include `outputDir`, `bashToolName`, `processToolName`, tool descriptions, prompt snippets, and prompt guidelines. Templates support `{{bashToolName}}`, `{{processToolName}}`, `{{defaultTimeoutSeconds}}`, `{{maxTimeoutSeconds}}`, and `{{maxLogBytes}}`.

Set `systemPrompt` to `false` to omit snippets and guidelines. Set an individual snippet to `false` to omit only that snippet.

## Verification

From the repository root:

```bash
pnpm run check
pnpm exec vitest run tests/background-bash.integration.test.ts tests/config.unit.test.ts --root extensions/background-bash
```

The integration tests run real commands. They cover automatic routing, promotion, cancellation, graceful recovery, abrupt host exit, session ownership, and capped logs with successful and failed exit codes.

For interactive acceptance, load an isolated session with the command above:

1. Run a command longer than 30 seconds without explicit background mode. Confirm that the same process continues after handoff.
2. Confirm that completion wakes the idle agent once and clears the footer count.
3. Start a background command, then reload or close Pi. Resume the original session and confirm that the result arrives without restarting the command.
4. Inspect and cancel a running job by `jobId`, or select it with `/proc`. Confirm that cancellation suppresses its completion notification.

Use `bash_process` to stop remaining test jobs. Do not signal a saved PID to cancel a recovered job.

## Limitations

Linux and macOS are supported. The extension has no pseudo-terminal, interactive stdin, attach interface, or log rotation. Jobs do not survive operating-system reboot. Completed records remain recoverable if storage survives the reboot; interrupted jobs have an unknown outcome.
