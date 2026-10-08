import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { binOverride } from "./config.ts";

export type TgrepStatus =
  | { kind: "server"; pid: number; port: number; files: number; watcherActive: boolean; indexingComplete: boolean }
  | { kind: "index"; files: number }
  | { kind: "none" };

export interface ServeInfo {
  pid: number;
  port: number;
}

let cachedBinary: string | null | undefined;

export async function findTgrep(pi: ExtensionAPI): Promise<string | null> {
  if (cachedBinary !== undefined) return cachedBinary;
  cachedBinary = await discoverTgrep(pi);
  return cachedBinary;
}

export function resetBinaryCache(): void {
  cachedBinary = undefined;
}

/** Windows runs real executables only; Node refuses to spawn .cmd/.bat shims without a shell. */
const WINDOWS_EXECUTABLE = /\.(exe|com)$/i;
/** Drive paths as Git Bash and Cygwin print them: `/c/Users/x`, `/cygdrive/c/Users/x`. */
const MSYS_DRIVE_PATH = /^\/cygdrive\/([A-Za-z])\/(.*)$|^\/([A-Za-z])\/(.*)$/;

/**
 * Rewrites a POSIX-style drive path from Git Bash (`/c/Users/x`) into the native form Node can
 * spawn (`C:\Users\x`). Anything else — already-native paths, `/usr/bin/...` mounts — is returned
 * unchanged, since there is no drive mapping to invent.
 */
export function toWindowsPath(candidate: string): string {
  const match = MSYS_DRIVE_PATH.exec(candidate);
  if (!match) return candidate;
  const drive = (match[1] ?? match[3])!;
  const rest = (match[2] ?? match[4])!;
  return `${drive.toUpperCase()}:\\${rest.replace(/\//g, "\\")}`;
}

/**
 * Turns `which`/`where` output into commands worth trying. Git Bash resolves `tgrep.exe` but prints
 * the path without its `.exe` suffix, so Windows candidates are extended and then filtered down to
 * the extensions Node can actually start — a `.cmd`/`.bat` shim is skipped rather than spawned.
 */
export function spawnableCandidates(listed: readonly string[], platform: NodeJS.Platform = process.platform): string[] {
  const candidates: string[] = [];
  for (const raw of listed) {
    const entry = raw.trim();
    if (!entry) continue;
    if (platform !== "win32") {
      candidates.push(entry);
      continue;
    }
    const native = toWindowsPath(entry);
    const expanded = path.extname(native) ? [native] : [native, `${native}.exe`];
    for (const candidate of expanded) {
      if (WINDOWS_EXECUTABLE.test(candidate)) candidates.push(candidate);
    }
  }
  return [...new Set(candidates)];
}

async function listBinaries(pi: ExtensionAPI, command: string, args: string[]): Promise<string[]> {
  try {
    const result = await pi.exec(command, args, { timeout: 5_000 });
    if (result.code !== 0) return [];
    return result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** A path on `PATH` is only usable if it runs: `which` happily reports shims Node cannot spawn. */
async function tgrepRuns(pi: ExtensionAPI, command: string): Promise<boolean> {
  try {
    const result = await pi.exec(command, ["--version"], { timeout: 5_000 });
    return result.code === 0 && /\btgrep\b/i.test(`${result.stdout}${result.stderr}`);
  } catch {
    return false;
  }
}

/**
 * Windows listings need a second look because they can name things Node cannot start: Git Bash
 * strips the `.exe` suffix, `/c/...` is not a spawnable path, and `.cmd` shims need a shell. Every
 * other platform trusts `which`, so a broken path there still surfaces as a spawn error instead of
 * being silently dropped.
 */
async function candidateIsUsable(pi: ExtensionAPI, candidate: string): Promise<boolean> {
  return process.platform !== "win32" || tgrepRuns(pi, candidate);
}

async function discoverTgrep(pi: ExtensionAPI): Promise<string | null> {
  const override = binOverride();
  // An explicit override is always probed: a wrong PI_TGREP_BIN should be visible, not silently
  // replaced by whatever else is on PATH.
  if (override) return (await tgrepRuns(pi, override)) ? override : null;
  const listed =
    process.platform === "win32"
      ? await listBinaries(pi, "where.exe", ["tgrep"])
      : await listBinaries(pi, "which", ["tgrep"]);
  for (const candidate of spawnableCandidates(listed)) {
    if (await candidateIsUsable(pi, candidate)) return candidate;
  }
  return null;
}

function parseNumber(text: string, pattern: RegExp): number | undefined {
  const match = pattern.exec(text);
  return match ? Number(match[1]) : undefined;
}

export async function readServeJson(root: string, indexDir?: string): Promise<ServeInfo | null> {
  try {
    const raw = await readFile(path.join(indexDir ?? path.join(root, ".tgrep"), "serve.json"), "utf-8");
    const parsed = JSON.parse(raw) as { pid?: unknown; port?: unknown };
    if (typeof parsed.pid === "number" && typeof parsed.port === "number") {
      return { pid: parsed.pid, port: parsed.port };
    }
  } catch {}
  return null;
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function statusText(pi: ExtensionAPI, root: string, indexDir?: string): Promise<string> {
  try {
    // The discovered command, so `PI_TGREP_BIN` and renamed binaries report status correctly.
    const bin = (await findTgrep(pi)) ?? "tgrep";
    const args = indexDir ? ["status", root, "--index-path", indexDir] : ["status", root];
    const result = await pi.exec(bin, args, { timeout: 15_000 });
    return result.stdout;
  } catch {
    return "";
  }
}

export async function status(pi: ExtensionAPI, root: string, indexDir?: string): Promise<TgrepStatus> {
  let text = await statusText(pi, root, indexDir);
  for (let attempt = 0; attempt < 2; attempt++) {
    if (/^Server status for/m.test(text)) {
      return {
        kind: "server",
        pid: parseNumber(text, /PID:\s*(\d+)/) ?? 0,
        port: parseNumber(text, /Port:\s*(\d+)/) ?? 0,
        files: parseNumber(text, /Files:\s*(\d+)/) ?? 0,
        watcherActive: /Watcher:\s*active/.test(text),
        indexingComplete: /Indexing:\s*complete/.test(text),
      };
    }
    if (!/^Index status for/m.test(text)) return { kind: "none" };
    const serve = await readServeJson(root, indexDir);
    if (!serve || !pidAlive(serve.pid)) {
      return { kind: "index", files: parseNumber(text, /Files:\s*(\d+)/) ?? 0 };
    }
    text = await statusText(pi, root, indexDir);
  }
  const serve = await readServeJson(root, indexDir);
  if (serve && pidAlive(serve.pid)) {
    return { kind: "server", pid: serve.pid, port: serve.port, files: 0, watcherActive: false, indexingComplete: false };
  }
  return { kind: "index", files: parseNumber(text, /Files:\s*(\d+)/) ?? 0 };
}

/**
 * Whether `pid` really is a tgrep process. `null` means the check could not be run at all, and the
 * caller must not signal the pid — tgrep has no stop command, so a recycled pid would kill a
 * stranger's process.
 *
 * Windows uses `tasklist` because Git Bash's `ps` rejects `-o`. Every image name the discovered
 * binary could have (a renamed release build, for instance) plus a plain `tgrep` fallback counts,
 * so a running server is never orphaned just because its executable is called something else.
 */
export async function isTgrepProcess(pi: ExtensionAPI, pid: number): Promise<boolean | null> {
  const bin = await findTgrep(pi);
  const expected = new Set(["tgrep", "tgrep.exe"]);
  if (bin) expected.add(baseName(bin).toLowerCase());
  const isTgrep = (image: string): boolean => {
    const name = baseName(image.trim());
    return expected.has(name.toLowerCase()) || /tgrep/i.test(name);
  };
  try {
    if (process.platform === "win32") {
      const result = await pi.exec("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], { timeout: 5_000 });
      if (result.code !== 0) return null;
      const image = /^\s*"([^"]+)"/.exec(result.stdout)?.[1];
      return image !== undefined && isTgrep(image);
    }
    const result = await pi.exec("ps", ["-p", String(pid), "-o", "comm="], { timeout: 5_000 });
    if (result.code !== 0) return null;
    return isTgrep(result.stdout.trim());
  } catch {
    return null;
  }
}

function baseName(value: string): string {
  return value.split(/[\\/]/).pop() ?? value;
}

/** Removes serve.json only while it still points at the pid we inspected. */
async function dropServeJson(root: string, indexDir: string | undefined, pid: number): Promise<void> {
  const serveJsonPath = path.join(indexDir ?? path.join(root, ".tgrep"), "serve.json");
  const current = await readServeJson(root, indexDir);
  if (current?.pid === pid) await rm(serveJsonPath, { force: true }).catch(() => {});
}

export async function stopServer(pi: ExtensionAPI, root: string, indexDir?: string): Promise<boolean> {
  const serveJsonPath = path.join(indexDir ?? path.join(root, ".tgrep"), "serve.json");
  const serve = await readServeJson(root, indexDir);
  if (!serve || !pidAlive(serve.pid)) {
    await rm(serveJsonPath, { force: true }).catch(() => {});
    return false;
  }
  const owned = await isTgrepProcess(pi, serve.pid);
  // Unverifiable: leave the daemon and its bookkeeping alone rather than signal a stranger.
  if (owned === null) return false;
  if (!owned) {
    // The pid was recycled: the server this file described is gone, so the record is stale.
    await dropServeJson(root, indexDir, serve.pid);
    return false;
  }
  try {
    process.kill(serve.pid, "SIGTERM");
  } catch {
    return false;
  }
  for (let waited = 0; waited < 3_000; waited += 100) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (!pidAlive(serve.pid)) {
      await dropServeJson(root, indexDir, serve.pid);
      return true;
    }
  }
  try {
    process.kill(serve.pid, "SIGKILL");
  } catch {}
  await dropServeJson(root, indexDir, serve.pid);
  return true;
}
