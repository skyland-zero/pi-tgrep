import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  findTgrep,
  isTgrepProcess,
  resetBinaryCache,
  spawnableCandidates,
  stopServer,
  toWindowsPath,
} from "../src/tgrep-client.ts";

const execFileP = promisify(execFile);

/** A pi stub that really runs the commands, like the host does. */
function makePi() {
  return {
    async exec(command, args, options = {}) {
      try {
        const { stdout, stderr } = await execFileP(command, args, { cwd: options.cwd, timeout: options.timeout });
        return { stdout, stderr, code: 0, killed: false };
      } catch (err) {
        return {
          stdout: err.stdout ?? "",
          stderr: err.stderr ?? String(err.message),
          code: typeof err.code === "number" ? err.code : 1,
          killed: Boolean(err.killed),
        };
      }
    },
  };
}

async function withEnv(name, value, run) {
  const saved = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  resetBinaryCache();
  try {
    return await run();
  } finally {
    if (saved === undefined) delete process.env[name];
    else process.env[name] = saved;
    resetBinaryCache();
  }
}

function runPathTests() {
  assert.equal(toWindowsPath("/c/Users/me/tgrep"), "C:\\Users\\me\\tgrep");
  assert.equal(toWindowsPath("/cygdrive/d/repo/.tgrep"), "D:\\repo\\.tgrep");
  assert.equal(toWindowsPath("/usr/bin/tgrep"), "/usr/bin/tgrep");
  assert.equal(toWindowsPath("/opt/homebrew/bin/tgrep"), "/opt/homebrew/bin/tgrep");
  assert.equal(toWindowsPath("C:\\Program Files\\tgrep.exe"), "C:\\Program Files\\tgrep.exe");
  assert.equal(toWindowsPath("tgrep"), "tgrep");

  // POSIX listings are used verbatim, in order, deduplicated.
  assert.deepEqual(spawnableCandidates(["/opt/homebrew/bin/tgrep", " /opt/homebrew/bin/tgrep", ""], "darwin"), [
    "/opt/homebrew/bin/tgrep",
  ]);

  // Windows listings are converted, get the `.exe` Git Bash strips back, and drop non-spawnable shims.
  assert.deepEqual(
    spawnableCandidates(
      ["/c/Users/me/AppData/Roaming/npm/tgrep", "C:\\tools\\tgrep.exe", "C:\\shims\\tgrep.cmd", "C:\\x\\tgrep.bat"],
      "win32",
    ),
    ["C:\\Users\\me\\AppData\\Roaming\\npm\\tgrep.exe", "C:\\tools\\tgrep.exe"],
  );
  console.log("binary path tests ok");
}

async function runOverrideTests(pi) {
  await withEnv("PI_TGREP_BIN", "/nonexistent/pi-tgrep-missing-tgrep", async () => {
    assert.equal(await findTgrep(pi), null, "an explicit override that does not run must stay dormant");
  });
  console.log("PI_TGREP_BIN override tests ok");
}

async function runProcessIdentityTests(pi) {
  assert.equal(await isTgrepProcess(pi, 0), false, "pid 0 is never a tgrep server");
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore", windowsHide: true });
  try {
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(await isTgrepProcess(pi, child.pid), false, "a node process must not pass as tgrep");

    // A pid that is alive but foreign must survive /tgrep-stop, and the bookkeeping must stay put:
    // otherwise the daemon is orphaned and the next session starts a second one.
    const dir = await mkdtemp(path.join(tmpdir(), "pi-tgrep-stop-"));
    const indexDir = path.join(dir, ".tgrep");
    await mkdir(indexDir, { recursive: true });
    const serveJson = path.join(indexDir, "serve.json");
    await writeFile(serveJson, JSON.stringify({ pid: child.pid, port: 1 }));
    try {
      // A live pid that is not tgrep means the recorded server is gone and the pid was recycled:
      // the stranger must survive, and the stale record must go so status() stops reporting a server.
      assert.equal(await stopServer(pi, dir), false, "a foreign pid must not be stopped");
      assert.equal(child.exitCode, null, "the foreign process must still be running");
      await assert.rejects(readFile(serveJson, "utf-8"), "stale serve.json must be removed");

      // A dead pid leaves stale bookkeeping behind, which the next status must not trust.
      const dead = spawn(process.execPath, ["-e", ""], { stdio: "ignore", windowsHide: true });
      await new Promise((resolve) => dead.once("exit", resolve));
      await writeFile(serveJson, JSON.stringify({ pid: dead.pid, port: 1 }));
      assert.equal(await stopServer(pi, dir), false, "a dead pid is not a running server");
      await assert.rejects(readFile(serveJson, "utf-8"), "stale serve.json must be removed");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  } finally {
    child.kill();
  }
  console.log("process identity tests ok");
}

try {
  runPathTests();
  const pi = makePi();
  await runOverrideTests(pi);
  await runProcessIdentityTests(pi);
} finally {
  resetBinaryCache();
}
console.log("ALL BINARY DISCOVERY TESTS PASSED");
