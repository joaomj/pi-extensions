import { spawn } from "node:child_process";
import { constants } from "node:os";
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";

const directory = process.argv[2];
const read = (name) => JSON.parse(readFileSync(join(directory, name), "utf8"));
const write = (name, value) => {
  const path = join(directory, name);
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
  renameSync(temporary, path);
};
const input = read("job.json");
let child;
let log;
let keptBytes = 0;
let totalBytes = 0;
let cancelled = false;
let timedOut = false;
let failure;
let closed = false;
let cancellationTimer;
let timeoutTimer;
let escalationTimer;

const killGroup = (signal) => {
  if (!child?.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
};
const fail = (error) => {
  failure ??= error instanceof Error ? error.message : String(error);
  killGroup("SIGKILL");
};
const stop = () => {
  killGroup("SIGTERM");
  escalationTimer ??= setTimeout(() => {
    try {
      killGroup("SIGKILL");
    } catch (error) {
      fail(error);
    }
  }, 500);
};
const append = (chunk) => {
  totalBytes += chunk.length;
  const length = Math.min(chunk.length, Math.max(0, input.maxLogBytes - keptBytes));
  let offset = 0;
  while (offset < length) offset += writeSync(log, chunk, offset, length - offset);
  keptBytes += length;
};
const finish = (code, signal) => {
  if (closed) return;
  closed = true;
  clearInterval(cancellationTimer);
  clearTimeout(timeoutTimer);
  clearTimeout(escalationTimer);
  try {
    killGroup("SIGKILL");
  } catch (error) {
    failure ??= error.message;
  }
  if (log !== undefined) closeSync(log);
  const exitCode = code ?? (signal ? 128 + constants.signals[signal] : undefined);
  write("result.json", {
    jobId: input.jobId,
    exitCode,
    error: failure,
    cancelled,
    timedOut,
    keptBytes,
    totalBytes,
    logCapped: totalBytes > keptBytes,
    finishedAt: Date.now(),
  });
};

try {
  log = openSync(join(directory, "output.log"), "wx", 0o600);
  child = spawn(input.shell, [...input.shellArgs, input.executionCommand], {
    cwd: input.cwd,
    env: process.env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  child.once("spawn", () => {
    write("runtime.json", { jobId: input.jobId, runnerPid: process.pid, pgid: child.pid });
    cancellationTimer = setInterval(() => {
      try {
        if (!existsSync(join(directory, "cancel.json"))) return;
        const request = read("cancel.json");
        if (request.jobId !== input.jobId) throw new Error("Cancellation job identity mismatch");
        if (!cancelled) {
          cancelled = true;
          stop();
        }
      } catch (error) {
        fail(error);
      }
    }, 50);
    if (input.timeoutSeconds !== undefined)
      timeoutTimer = setTimeout(() => {
        timedOut = true;
        try {
          stop();
        } catch (error) {
          fail(error);
        }
      }, input.timeoutSeconds * 1000);
  });
  const consume = (chunk) => {
    try {
      append(chunk);
    } catch (error) {
      fail(error);
    }
  };
  child.stdout.on("data", consume);
  child.stderr.on("data", consume);
  child.once("error", (error) => {
    failure = error.message;
  });
  child.once("close", finish);
} catch (error) {
  failure = error.message;
  finish(undefined, undefined);
}
