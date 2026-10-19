import { constants as fsConstants } from "node:fs";
import { access, open, readdir, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import {
  getShellConfig,
  type AgentToolResult,
  type BashOperations,
  type BashToolDetails,
} from "@earendil-works/pi-coding-agent";
import { BoundedOutput } from "./bounded-output";
import {
  privateDirectory,
  readRecord,
  runnerExists,
  sessionDirectory,
  writeRecord,
  type JobRecord,
  type JobResult,
  type JobRuntime,
} from "./job-store";
import type { ResolvedOptions } from "./config";
import type { PiBashSettings } from "./pi-settings";

export type BackgroundBashDetails = BashToolDetails & {
  pgid?: number;
  jobId?: string;
  active?: boolean;
  logCapped?: boolean;
};
export type ProcessOutcome =
  | { result: AgentToolResult<BackgroundBashDetails | undefined>; error?: undefined }
  | { result?: undefined; error: Error };
export type ManagedProcess = {
  pgid: number;
  jobId: string;
  directory: string;
  command: string;
  name?: string;
  startedAt: number;
  logPath: string;
  controller: AbortController;
  notifyOnExit: boolean;
  exitCode?: number;
  logCapped?: boolean;
  cancelled?: boolean;
  runnerError?: string;
  failure?: Error;
  latest?: AgentToolResult<BackgroundBashDetails | undefined>;
  completion?: Promise<ProcessOutcome>;
  detachAbort: () => void;
  stopMonitoring: () => void;
};
type ProcessMetadata = {
  command: string;
  name?: string;
  controller: AbortController;
  env: NodeJS.ProcessEnv;
  onData: (data: Buffer) => void;
  detachAbort: () => void;
};
type Deferred<Value> = {
  promise: Promise<Value>;
  resolve: (value: Value) => void;
  reject: (error: unknown) => void;
};
const deferred = <Value>(): Deferred<Value> => {
  let resolve!: (value: Value) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<Value>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const failureFrom = (result: JobResult): Error | undefined => {
  if (result.error) return new Error(`Background runner failed: ${result.error}`);
  if (result.timedOut) return new Error("Background command timed out");
  if (result.cancelled) return new Error("Command aborted");
  if (result.exitCode === undefined)
    return new Error("Background runner did not record an exit code");
  if (result.exitCode !== 0) return new Error(`Command exited with code ${result.exitCode}`);
  return undefined;
};

export class ProcessManager {
  readonly processes = new Map<string, ManagedProcess>();
  private readonly pendingDeliveries = new Map<string, ManagedProcess>();
  private runDir: string | undefined;
  private sessionId: string | undefined;
  private bashSettings: PiBashSettings = {};
  private shuttingDown = false;

  constructor(
    private readonly options: ResolvedOptions,
    private readonly onBackgroundCountChange: (count: number) => void,
    private readonly onRecoveredCompletion: (
      managed: ManagedProcess,
      outcome: ProcessOutcome,
    ) => void,
    private readonly onError: (error: Error) => void,
  ) {}

  initialize = async (
    sessionId: string,
    cwd: string,
    bashSettings: PiBashSettings,
    deliveredJobIds: ReadonlySet<string>,
  ): Promise<void> => {
    this.shuttingDown = false;
    this.sessionId = sessionId;
    this.bashSettings = bashSettings;
    this.runDir = sessionDirectory(this.options.outputDir, cwd, sessionId);
    await privateDirectory(this.runDir);
    for (const entry of await readdir(this.runDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const directory = join(this.runDir, entry.name);
      const record = await readRecord<JobRecord>(directory, "job.json");
      if (!record || record.sessionId !== sessionId || record.jobId !== entry.name) {
        throw new Error(`Invalid background job identity in ${directory}`);
      }
      if (deliveredJobIds.has(record.jobId)) {
        await writeRecord(directory, "delivered.json", { jobId: record.jobId });
        if (!this.options.preserveOutputFiles && (await readRecord(directory, "result.json"))) {
          await rm(directory, { recursive: true });
        }
        continue;
      }
      if (await readRecord(directory, "delivered.json")) continue;
      const suppressed = Boolean(await readRecord(directory, "suppressed.json"));
      if (suppressed && (await readRecord(directory, "result.json"))) continue;
      const runtime = await this.waitForRuntime(record, directory);
      const output = new BoundedOutput();
      const managed = this.createManaged(
        record,
        runtime,
        directory,
        new AbortController(),
        () => {},
      );
      const observe = this.observe(managed, runtime, (data) => {
        output.append(data);
        managed.latest = this.recoveredResult(managed, output);
      });
      managed.completion = observe.then(
        (result) => {
          output.finish();
          managed.exitCode = result.exitCode;
          managed.logCapped = result.logCapped;
          managed.cancelled = result.cancelled;
          managed.runnerError = result.error;
          const error = failureFrom(result);
          managed.failure = error;
          if (error)
            return {
              error: new Error(
                `${output.snapshot().content}\n\n${error.message}\nFull output: ${managed.logPath}`,
              ),
            };
          const value = this.recoveredResult(managed, output);
          managed.latest = value;
          return { result: value };
        },
        (error) => ({ error: error instanceof Error ? error : new Error(String(error)) }),
      );
      await this.handoff(managed, this.onRecoveredCompletion, suppressed);
    }
    this.emitBackgroundCount();
  };

  getCommandPrefix = (): string | undefined => this.bashSettings.commandPrefix;

  prepare = (metadata: ProcessMetadata) => {
    const spawned = deferred<ManagedProcess>();
    const operations: BashOperations = {
      exec: async (command, cwd, options) => {
        try {
          return await this.spawnProcess(
            command,
            cwd,
            { ...options, onData: metadata.onData },
            metadata,
            spawned,
          );
        } catch (error) {
          spawned.reject(error);
          throw error;
        }
      },
    };
    return { operations, spawned: spawned.promise };
  };

  handoff = async (
    managed: ManagedProcess,
    notify: (managed: ManagedProcess, outcome: ProcessOutcome) => void,
    suppressed = false,
  ): Promise<void> => {
    await writeRecord(managed.directory, "background.json", { jobId: managed.jobId });
    managed.notifyOnExit = !suppressed;
    managed.detachAbort();
    const completion = managed.completion;
    if (!completion) throw new Error(`Process ${managed.pgid} has no completion promise`);
    this.emitBackgroundCount();
    void completion
      .then(async (outcome) => {
        if (this.shuttingDown) return;
        this.processes.delete(managed.jobId);
        this.emitBackgroundCount();
        if (managed.notifyOnExit) {
          this.pendingDeliveries.set(managed.jobId, managed);
          notify(managed, outcome);
        } else {
          await this.removeCompletedOutput(managed);
        }
      })
      .catch((error) =>
        this.onError(new Error(`Cannot deliver background job ${managed.jobId}`, { cause: error })),
      );
  };

  acknowledgeDelivered = async (jobIds: ReadonlySet<string>): Promise<void> => {
    for (const [jobId, managed] of this.pendingDeliveries) {
      if (!jobIds.has(jobId)) continue;
      await writeRecord(managed.directory, "delivered.json", { jobId });
      await this.removeCompletedOutput(managed);
      this.pendingDeliveries.delete(jobId);
    }
  };

  finishForeground = async (managed: ManagedProcess): Promise<void> => {
    managed.detachAbort();
    await writeRecord(managed.directory, "delivered.json", { jobId: managed.jobId });
    this.processes.delete(managed.jobId);
    await this.removeCompletedOutput(managed);
  };

  kill = async (jobId: string): Promise<{ managed: ManagedProcess; outcome: ProcessOutcome }> => {
    const managed = this.processes.get(jobId);
    if (!managed?.notifyOnExit) throw new Error(`No active background job ${jobId}`);
    await writeRecord(managed.directory, "suppressed.json", { jobId: managed.jobId });
    managed.notifyOnExit = false;
    this.emitBackgroundCount();
    managed.detachAbort();
    managed.controller.abort();
    if (!managed.completion) throw new Error(`Job ${jobId} has no completion promise`);
    const outcome = await managed.completion;
    if (managed.runnerError || (!managed.cancelled && outcome.error)) {
      throw new Error(
        `Cannot confirm cancellation of job ${jobId}: ${managed.runnerError ?? outcome.error?.message}`,
      );
    }
    this.processes.delete(jobId);
    return { managed, outcome };
  };

  shutdown = async (): Promise<void> => {
    this.shuttingDown = true;
    const foreground: ManagedProcess[] = [];
    for (const managed of this.processes.values()) {
      managed.detachAbort();
      if (await readRecord(managed.directory, "background.json")) {
        managed.stopMonitoring();
      } else {
        managed.controller.abort();
        foreground.push(managed);
      }
    }
    await Promise.all(
      foreground.map((managed) => {
        if (!managed.completion)
          throw new Error(`Process ${managed.pgid} has no completion promise during shutdown`);
        return managed.completion;
      }),
    );
    this.processes.clear();
    this.pendingDeliveries.clear();
    this.onBackgroundCountChange(0);
    this.runDir = undefined;
    this.sessionId = undefined;
    this.bashSettings = {};
  };

  private emitBackgroundCount = (): void => {
    this.onBackgroundCountChange(
      [...this.processes.values()].filter((managed) => managed.notifyOnExit).length,
    );
  };
  private removeCompletedOutput = async (managed: ManagedProcess): Promise<void> => {
    if (!this.options.preserveOutputFiles && (await readRecord(managed.directory, "result.json"))) {
      await rm(managed.directory, { recursive: true });
    }
  };
  private createManaged = (
    record: JobRecord,
    runtime: JobRuntime,
    directory: string,
    controller: AbortController,
    detachAbort: () => void,
  ): ManagedProcess => {
    if (
      runtime.jobId !== record.jobId ||
      !Number.isSafeInteger(runtime.pgid) ||
      runtime.pgid <= 0
    ) {
      throw new Error(`Invalid background process identity in ${directory}`);
    }
    const managed: ManagedProcess = {
      pgid: runtime.pgid,
      jobId: record.jobId,
      directory,
      command: record.command,
      name: record.name,
      startedAt: record.startedAt,
      logPath: join(directory, "output.log"),
      controller,
      notifyOnExit: false,
      detachAbort,
      stopMonitoring: () => {},
    };
    const existing = this.processes.get(record.jobId);
    if (existing) throw new Error(`Background job ${existing.jobId} is already tracked`);
    this.processes.set(record.jobId, managed);
    return managed;
  };
  private waitForRuntime = async (record: JobRecord, directory: string): Promise<JobRuntime> => {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const runtime = await readRecord<JobRuntime>(directory, "runtime.json");
      if (runtime) return runtime;
      const result = await readRecord<JobResult>(directory, "result.json");
      if (result) {
        await writeRecord(directory, "delivered.json", { jobId: record.jobId });
        throw new Error(
          `Cannot start background job ${record.jobId}: ${result.error ?? "missing runtime identity"}`,
        );
      }
      await pause(25);
    }
    throw new Error(
      `Background runner did not start job ${record.jobId} within 5 seconds; inspect ${directory}`,
    );
  };
  private spawnProcess = async (
    command: string,
    cwd: string,
    options: Parameters<BashOperations["exec"]>[2],
    metadata: ProcessMetadata,
    spawned: Deferred<ManagedProcess>,
  ): Promise<{ exitCode: number | null }> => {
    if (this.shuttingDown) throw new Error("Background bash is shutting down");
    if (options.signal?.aborted) throw new Error("aborted");
    if (!this.runDir || !this.sessionId) throw new Error("Background bash is not initialized");
    try {
      await access(cwd, fsConstants.F_OK);
    } catch (error) {
      throw new Error(`Cannot access working directory ${cwd}`, { cause: error });
    }
    const { shell, args } = getShellConfig(this.bashSettings.shellPath);
    const record: JobRecord = {
      jobId: randomUUID(),
      sessionId: this.sessionId,
      command: metadata.command,
      name: metadata.name,
      startedAt: Date.now(),
      cwd,
      shell,
      shellArgs: args,
      executionCommand: command,
      maxLogBytes: this.options.maxLogBytes,
      timeoutSeconds: options.timeout,
    };
    const directory = join(this.runDir, record.jobId);
    await privateDirectory(directory);
    await writeRecord(directory, "job.json", record);
    const worker = spawn(
      process.execPath,
      [fileURLToPath(new URL("./durable-runner.mjs", import.meta.url)), directory],
      {
        cwd,
        env: { ...options.env, ...metadata.env },
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      },
    );
    try {
      await new Promise<void>((resolve, reject) => {
        worker.once("spawn", resolve);
        worker.once("error", reject);
      });
    } catch (error) {
      await rm(directory, { recursive: true });
      throw new Error(`Cannot start background runner for ${record.jobId}`, { cause: error });
    }
    worker.unref();
    const runtime = await this.waitForRuntime(record, directory);
    const managed = this.createManaged(
      record,
      runtime,
      directory,
      metadata.controller,
      metadata.detachAbort,
    );
    const observation = this.observe(managed, runtime, options.onData);
    spawned.resolve(managed);
    const result = await observation;
    managed.exitCode = result.exitCode;
    managed.logCapped = result.logCapped;
    managed.cancelled = result.cancelled;
    managed.runnerError = result.error;
    managed.failure = failureFrom(result);
    if (result.error) throw new Error(`Background runner failed: ${result.error}`);
    if (result.timedOut) throw new Error(`timeout:${options.timeout}`);
    if (result.cancelled) throw new Error("aborted");
    if (result.exitCode === undefined)
      throw new Error("Background runner did not record an exit code");
    return { exitCode: result.exitCode };
  };

  private observe = (
    managed: ManagedProcess,
    runtime: JobRuntime,
    onData: (data: Buffer) => void,
  ): Promise<JobResult> =>
    new Promise((resolve, reject) => {
      let offset = 0;
      let reading = false;
      let stopped = false;
      let cancellationSent = false;
      let lastLivenessCheck = 0;
      const stop = () => {
        stopped = true;
        clearInterval(timer);
      };
      managed.stopMonitoring = stop;
      const tick = async () => {
        if (reading || stopped) return;
        reading = true;
        try {
          if (managed.controller.signal.aborted && !cancellationSent) {
            await writeRecord(managed.directory, "cancel.json", { jobId: managed.jobId });
            cancellationSent = true;
          }
          const result = await readRecord<JobResult>(managed.directory, "result.json");
          const log = await open(managed.logPath, "r");
          try {
            const size = (await log.stat()).size;
            const limit = result ? size : Math.min(size, offset + 1024 * 1024);
            const buffer = Buffer.alloc(64 * 1024);
            while (offset < limit) {
              const { bytesRead } = await log.read(
                buffer,
                0,
                Math.min(buffer.length, limit - offset),
                offset,
              );
              if (!bytesRead)
                throw new Error(`Background log shrank unexpectedly: ${managed.logPath}`);
              onData(buffer.subarray(0, bytesRead));
              offset += bytesRead;
            }
          } finally {
            await log.close();
          }
          if (stopped) return;
          if (result) {
            if (result.jobId !== managed.jobId)
              throw new Error(`Completion identity mismatch for ${managed.jobId}`);
            if (result.logCapped)
              onData(
                Buffer.from(
                  `\n[Log capped at ${result.keptBytes} bytes; ${result.totalBytes - result.keptBytes} output bytes discarded. Exit status is preserved.]\n`,
                ),
              );
            stop();
            resolve(result);
          } else if (Date.now() - lastLivenessCheck >= 1000) {
            lastLivenessCheck = Date.now();
            if (!(await runnerExists(runtime, managed.directory))) {
              const completed = await readRecord<JobResult>(managed.directory, "result.json");
              if (!completed)
                throw new Error(
                  `Runner for job ${managed.jobId} disappeared without an exit record; outcome unknown. Do not automatically rerun the command.`,
                );
            }
          }
        } catch (error) {
          stop();
          reject(
            new Error(
              `Cannot observe background job ${managed.jobId}: ${error instanceof Error ? error.message : String(error)}`,
              { cause: error },
            ),
          );
        } finally {
          reading = false;
        }
      };
      const timer = setInterval(() => {
        void tick();
      }, 100);
      void tick();
    });

  private recoveredResult = (
    managed: ManagedProcess,
    output: BoundedOutput,
  ): AgentToolResult<BackgroundBashDetails> => {
    const snapshot = output.snapshot();
    return {
      content: [
        {
          type: "text",
          text: `${snapshot.content || "(no output)"}\n\nFull output: ${managed.logPath}`,
        },
      ],
      details: {
        pgid: managed.pgid,
        jobId: managed.jobId,
        fullOutputPath: managed.logPath,
        truncation: snapshot.truncation,
        logCapped: managed.logCapped,
      },
    };
  };
}
