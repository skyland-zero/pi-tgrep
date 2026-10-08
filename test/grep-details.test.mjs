import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { createGrepToolOverride, createStatusCache } from "../src/grep-tool.ts";
import { resetBinaryCache } from "../src/tgrep-client.ts";
import { LIST_BINARY } from "./platform.mjs";

const execFileP = promisify(execFile);

const FIXTURE = path.resolve(import.meta.dirname, "fixtures/repo");

const INDEXING_STATUS = [
  "Server status for /tmp/fake",
  "PID: 12345",
  "Port: 4567",
  "Files: 100",
  "Watcher: active",
  "Indexing: in progress",
  "",
].join("\n");

function makePi({ whichResult, statusText, statusCalls } = {}) {
  // The discovered binary is an absolute path, so match it by name rather than by the bare command.
  const isTgrep = (command) => /(^|[\\/])tgrep(\.exe)?$/i.test(command);
  return {
    async exec(command, args, options = {}) {
      // The extension asks `where.exe` on Windows and `which` elsewhere for the same discovery step.
      if ((command === LIST_BINARY || command === "which") && args[0] === "tgrep" && whichResult !== undefined) {
        return whichResult;
      }
      if (isTgrep(command) && args[0] === "status") {
        statusCalls?.push(Date.now());
        if (statusText !== undefined) return { stdout: statusText, stderr: "", code: 0, killed: false };
      }
      try {
        const { stdout, stderr } = await execFileP(command, args, {
          cwd: options.cwd,
          timeout: options.timeout,
        });
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

const repoDir = await mkdtemp(path.join(tmpdir(), "pi-tgrep-details-"));
await cp(FIXTURE, repoDir, { recursive: true });
await execFileP("git", ["init"], { cwd: repoDir });

const ctx = { cwd: repoDir, ui: {} };

async function runStatusCacheTests() {
  // A settled verdict is memoized for the session. Without it every search pays a `tgrep status`
  // spawn, which on Windows costs about as much as the search itself.
  const settledCalls = [];
  resetBinaryCache();
  const cached = createGrepToolOverride(makePi({ statusCalls: settledCalls }));
  await cached.execute("s1", { pattern: "needle" }, undefined, undefined, ctx);
  await cached.execute("s2", { pattern: "needle" }, undefined, undefined, ctx);
  await cached.execute("s3", { pattern: "needle" }, undefined, undefined, ctx);
  assert.equal(settledCalls.length, 1, `a settled index must be probed once, saw ${settledCalls.length}`);

  // A build in progress is re-checked after the recheck delay, so the fallback ends by itself once
  // the index is ready.
  const indexingCalls = [];
  resetBinaryCache();
  // The search itself takes longer than a tiny delay, so the reuse check needs a generous TTL and
  // the expiry check its own one-millisecond cache.
  const reused = createStatusCache(5_000);
  const indexing = createGrepToolOverride(makePi({ statusText: INDEXING_STATUS, statusCalls: indexingCalls }), reused);
  const first = await indexing.execute("s4", { pattern: "needle" }, undefined, undefined, ctx);
  assert.equal(first.details.fallback.reason, "indexing");
  assert.equal(indexingCalls.length, 1, "the first search must probe");
  await indexing.execute("s5", { pattern: "needle" }, undefined, undefined, ctx);
  assert.equal(indexingCalls.length, 1, "a fresh in-progress verdict must be reused, not re-probed");

  const expiring = createStatusCache(1);
  const expiringTool = createGrepToolOverride(makePi({ statusText: INDEXING_STATUS, statusCalls: indexingCalls }), expiring);
  await expiringTool.execute("s6", { pattern: "needle" }, undefined, undefined, ctx);
  assert.equal(indexingCalls.length, 2, "a new cache must probe again");
  await new Promise((resolve) => setTimeout(resolve, 100));
  await expiringTool.execute("s7", { pattern: "needle" }, undefined, undefined, ctx);
  assert.equal(indexingCalls.length, 3, "an expired in-progress verdict must be re-probed");

  // clear() drops the memo, which is what /tgrep-reindex asks for.
  expiring.clear();
  await expiringTool.execute("s8", { pattern: "needle" }, undefined, undefined, ctx);
  assert.equal(indexingCalls.length, 4, "clear() must force a fresh probe");
  console.log("status cache tests ok");
}

try {
  resetBinaryCache();
  const tool = createGrepToolOverride(makePi());

  const plain = await tool.execute("d1", { pattern: "needle" }, undefined, undefined, ctx);
  assert.equal(plain.details.engine, "tgrep");
  assert.equal(plain.details.fallback, undefined);
  assert.equal(plain.details.truncated, undefined);
  assert.match(plain.content[0].text, /src\/app\.ts:\d+: /);
  console.log("indexed success details ok");

  const limited = await tool.execute("d2", { pattern: "needle", limit: 1 }, undefined, undefined, ctx);
  assert.equal(limited.details.matchLimitReached, 1);
  assert.equal(limited.details.truncated, true);
  assert.match(limited.content[0].text, /1 matches limit reached/);
  console.log("truncated details ok");

  resetBinaryCache();
  const indexing = await createGrepToolOverride(makePi({ statusText: INDEXING_STATUS })).execute(
    "d3",
    { pattern: "needle" },
    undefined,
    undefined,
    ctx,
  );
  assert.equal(indexing.details.engine, "rg-fallback");
  assert.equal(indexing.details.fallback.reason, "indexing");
  assert.ok(indexing.details.fallback.message, "indexing fallback must carry a message");
  assert.match(indexing.content[0].text, /src\/app\.ts/);
  console.log("fallback-while-indexing details ok");

  resetBinaryCache();
  // Windows filters the listing down to spawnable .exe/.com paths and probes each candidate with
  // `tgrep --version`, so an unusable entry degrades to "no-binary" instead of reaching spawn.
  const missingBinary = process.platform === "win32" ? "C:\\nonexistent\\pi-tgrep-missing-tgrep.exe" : "/nonexistent/pi-tgrep-missing-tgrep";
  const errored = await createGrepToolOverride(
    makePi({ whichResult: { stdout: `${missingBinary}\n`, stderr: "", code: 0, killed: false } }),
  ).execute("d4", { pattern: "needle" }, undefined, undefined, ctx);
  assert.equal(errored.details.engine, "rg-fallback");
  if (process.platform === "win32") {
    assert.equal(errored.details.fallback.reason, "no-binary");
  } else {
    assert.equal(errored.details.fallback.reason, "error");
    assert.match(errored.details.fallback.message, /nonexistent|ENOENT|spawn/i);
  }
  assert.match(errored.content[0].text, /src\/app\.ts/);
  console.log("fallback-on-error details ok");

  resetBinaryCache();
  const noBinary = await createGrepToolOverride(
    makePi({ whichResult: { stdout: "", stderr: "", code: 1, killed: false } }),
  ).execute("d5", { pattern: "needle" }, undefined, undefined, ctx);
  assert.equal(noBinary.details.engine, "rg-fallback");
  assert.equal(noBinary.details.fallback.reason, "no-binary");
  assert.match(noBinary.content[0].text, /src\/app\.ts/);
  console.log("fallback-no-binary details ok");

  await runStatusCacheTests();
} finally {
  resetBinaryCache();
  await rm(repoDir, { recursive: true, force: true });
}
console.log("ALL GREP DETAILS TESTS PASSED");
