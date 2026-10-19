import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";

export type JobRecord = {
  jobId: string;
  sessionId: string;
  command: string;
  name?: string;
  startedAt: number;
  cwd: string;
  shell: string;
  shellArgs: string[];
  executionCommand: string;
  maxLogBytes: number;
  timeoutSeconds?: number;
};
export type JobRuntime = { jobId: string; runnerPid: number; pgid: number };
export type JobResult = {
  jobId: string;
  exitCode?: number;
  error?: string;
  cancelled: boolean;
  timedOut: boolean;
  keptBytes: number;
  totalBytes: number;
  logCapped: boolean;
  finishedAt: number;
};

export const sessionDirectory = (root: string, cwd: string, sessionId: string): string =>
  resolve(cwd, root, createHash("sha256").update(sessionId).digest("hex"));

export const privateDirectory = async (directory: string): Promise<void> => {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
};
export const writeRecord = async (
  directory: string,
  name: string,
  value: unknown,
): Promise<void> => {
  const path = join(directory, name);
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: "wx" });
  await rename(temporary, path);
};
const jobIdentity = z.string().uuid();
const marker = z.object({ jobId: jobIdentity });
const schemas: Record<string, z.ZodType> = {
  "job.json": z.object({
    jobId: jobIdentity,
    sessionId: z.string().min(1),
    command: z.string(),
    name: z.string().optional(),
    startedAt: z.number().finite(),
    cwd: z.string(),
    shell: z.string(),
    shellArgs: z.array(z.string()),
    executionCommand: z.string(),
    maxLogBytes: z.number().int().positive(),
    timeoutSeconds: z.number().positive().optional(),
  }),
  "runtime.json": z.object({
    jobId: jobIdentity,
    runnerPid: z.number().int().positive(),
    pgid: z.number().int().positive(),
  }),
  "result.json": z.object({
    jobId: jobIdentity,
    exitCode: z.number().int().optional(),
    error: z.string().optional(),
    cancelled: z.boolean(),
    timedOut: z.boolean(),
    keptBytes: z.number().int().nonnegative(),
    totalBytes: z.number().int().nonnegative(),
    logCapped: z.boolean(),
    finishedAt: z.number().finite(),
  }),
  "delivered.json": marker,
  "suppressed.json": marker,
  "background.json": marker,
};
export const readRecord = async <T>(directory: string, name: string): Promise<T | undefined> => {
  try {
    const value: unknown = JSON.parse(await readFile(join(directory, name), "utf8"));
    const schema = schemas[name];
    if (!schema) throw new Error(`Unknown background record type ${name}`);
    return schema.parse(value) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`Cannot read background job record ${join(directory, name)}`, { cause: error });
  }
};

const run = promisify(execFile);
export const runnerExists = async (runtime: JobRuntime, directory: string): Promise<boolean> => {
  try {
    const { stdout } = await run("ps", ["-ww", "-p", String(runtime.runnerPid), "-o", "args="]);
    return stdout.includes("durable-runner.mjs") && stdout.includes(directory);
  } catch (error) {
    if ((error as { code?: unknown }).code === 1) return false;
    throw new Error(`Cannot inspect background runner ${runtime.runnerPid}`, { cause: error });
  }
};
