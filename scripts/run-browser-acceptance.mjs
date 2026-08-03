import { spawn } from "node:child_process";
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { constants as operatingSystemConstants } from "node:os";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const lockPath = fileURLToPath(new URL("../.playwright/browser-acceptance.lock", import.meta.url));
const playwrightCli = fileURLToPath(new URL("../node_modules/@playwright/test/cli.js", import.meta.url));
const invalidLockRecoveryAgeMs = 5 * 60 * 1_000;

function processIsRunning(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

function existingLock() {
  try {
    const value = JSON.parse(readFileSync(lockPath, "utf8"));
    return value && Number.isSafeInteger(value.pid) && value.pid > 0
      ? { pid: value.pid, startedAt: typeof value.startedAt === "string" ? value.startedAt : "unknown" }
      : null;
  } catch {
    return null;
  }
}

function removeLockIfStale() {
  const owner = existingLock();
  if (owner && processIsRunning(owner.pid)) {
    throw new Error(
      `Albert browser acceptance is already running under PID ${owner.pid} (started ${owner.startedAt}).`,
    );
  }
  if (!owner) {
    const age = Date.now() - statSync(lockPath).mtimeMs;
    if (age < invalidLockRecoveryAgeMs) {
      throw new Error("Albert browser acceptance lock is initializing or invalid; retry after the owner exits.");
    }
  }
  unlinkSync(lockPath);
}

function acquireLock() {
  mkdirSync(dirname(lockPath), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const descriptor = openSync(lockPath, "wx", 0o600);
      try {
        writeFileSync(descriptor, JSON.stringify({
          pid: process.pid,
          startedAt: new Date().toISOString(),
        }));
      } catch (error) {
        closeSync(descriptor);
        try {
          unlinkSync(lockPath);
        } catch {
          // Preserve the original write failure.
        }
        throw error;
      }
      return descriptor;
    } catch (error) {
      if (error?.code !== "EEXIST" || attempt > 0) throw error;
      removeLockIfStale();
    }
  }
  throw new Error("Albert browser acceptance lock could not be acquired.");
}

let lockDescriptor;
try {
  lockDescriptor = acquireLock();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}

let released = false;
function releaseLock() {
  if (released) return;
  released = true;
  try {
    closeSync(lockDescriptor);
  } catch {
    // The exit path remains safe if the descriptor was already closed.
  }
  try {
    if (existingLock()?.pid === process.pid) unlinkSync(lockPath);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      process.stderr.write(`Albert browser acceptance lock cleanup failed: ${String(error)}\n`);
    }
  }
}

process.on("exit", releaseLock);

const child = spawn(process.execPath, [playwrightCli, "test", ...process.argv.slice(2)], {
  cwd: fileURLToPath(new URL("..", import.meta.url)),
  env: process.env,
  stdio: "inherit",
});

let finalizing = false;
function signalExitCode(signal) {
  return 128 + (operatingSystemConstants.signals[signal] ?? 1);
}

function finish(code) {
  if (finalizing) return;
  finalizing = true;
  releaseLock();
  process.exit(code);
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    if (finalizing) return;
    if (!child.killed) child.kill(signal);
    const forcedExit = setTimeout(() => finish(signalExitCode(signal)), 5_000);
    forcedExit.unref();
  });
}

child.once("error", (error) => {
  process.stderr.write(`Albert browser acceptance could not start Playwright: ${error.message}\n`);
  finish(1);
});

child.once("exit", (code, signal) => {
  finish(code ?? (signal ? signalExitCode(signal) : 1));
});
