import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readdir, realpath, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
  withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";

const TgrepParams = Type.Object({
  pattern: Type.String({
    description:
      "Regex or literal text to search for. Prefer fixed=true for symbols or exact strings.",
  }),
  paths: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Files/directories to search, relative to the Pi launch directory unless absolute. Defaults to the discovered repository/workspace scope.",
      minItems: 1,
      maxItems: 32,
    }),
  ),
  fixed: Type.Optional(
    Type.Boolean({
      description: "Use literal matching (-F) instead of regex.",
    }),
  ),
  smartCase: Type.Optional(
    Type.Boolean({
      description:
        "Use smart-case matching (-S). Defaults to true unless ignoreCase=true.",
    }),
  ),
  ignoreCase: Type.Optional(
    Type.Boolean({
      description: "Force case-insensitive matching (-i).",
    }),
  ),
  wholeWord: Type.Optional(
    Type.Boolean({
      description: "Match whole words only (-w).",
    }),
  ),
  glob: Type.Optional(
    Type.Array(Type.String(), {
      description: "One or more glob filters (-g), e.g. ['*.ts', '*.tsx'].",
      minItems: 1,
      maxItems: 32,
    }),
  ),
  fileType: Type.Optional(
    Type.String({
      description: "tgrep file type filter (-t), e.g. 'rust', 'py', 'ts'.",
    }),
  ),
  context: Type.Optional(
    Type.Integer({
      description: "Lines of context before and after each match (-C).",
      minimum: 0,
      maximum: 20,
    }),
  ),
  maxMatchesPerFile: Type.Optional(
    Type.Integer({
      description: "Maximum matches returned per file (-m).",
      minimum: 1,
      maximum: 1000,
    }),
  ),
  filesOnly: Type.Optional(
    Type.Boolean({
      description: "Return matching file names only (-l).",
    }),
  ),
  count: Type.Optional(
    Type.Boolean({
      description: "Return match counts per file (-c).",
    }),
  ),
  invert: Type.Optional(
    Type.Boolean({
      description: "Return non-matching lines (-v).",
    }),
  ),
  multiline: Type.Optional(
    Type.Boolean({
      description: "Enable multiline matching (-U).",
    }),
  ),
  freshness: Type.Optional(
    Type.Union([Type.Literal("indexed"), Type.Literal("current")], {
      description:
        "indexed (default) uses/starts tgrep serve when allowed; current forces --no-index for freshest filesystem results.",
    }),
  ),
});

type TgrepInput = Static<typeof TgrepParams>;

type DiscoveryMode = "repository" | "workspace" | "scan-only";

interface RepoTarget {
  root: string;
  indexPath: string;
  name: string;
}

interface DiscoveryState {
  launchRoot: string;
  searchBoundary: string;
  mode: DiscoveryMode;
  repos: RepoTarget[];
  reason?: string;
}

interface SearchJob {
  path: string;
  repo?: RepoTarget;
  label: string;
}

interface ProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

interface TgrepDetails {
  pattern: string;
  mode: DiscoveryMode;
  launchRoot: string;
  repositoryCount: number;
  jobs: Array<{
    path: string;
    repository?: string;
    indexed: boolean;
    exitCode: number | null;
  }>;
  matchedLines: number;
  truncated: boolean;
  fullOutputPath?: string;
  warnings?: string[];
}

const MAX_CAPTURE_BYTES = 100 * 1024 * 1024;
const SERVER_START_WAIT_MS = 1500;
const SERVER_STATUS_TIMEOUT_MS = 800;
const MAX_AUTO_SERVERS_PER_SEARCH = 10;

function normalizeForCompare(path: string): string {
  const normalized = resolve(path);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isPathInside(parent: string, child: string): boolean {
  const parentKey = normalizeForCompare(parent);
  const childKey = normalizeForCompare(child);
  const rel = relative(parentKey, childKey);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function isDangerousRoot(path: string): boolean {
  const resolved = resolve(path);
  if (dirname(resolved) === resolved) return true;
  return normalizeForCompare(resolved) === normalizeForCompare(homedir());
}

function repoIndexName(root: string): string {
  const hash = createHash("sha256")
    .update(normalizeForCompare(root))
    .digest("hex")
    .slice(0, 10);
  const safeName = basename(root).replace(/[^a-zA-Z0-9._-]+/g, "-") || "repo";
  return `${safeName}-${hash}`;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function runProcess(
  command: string,
  args: string[],
  options: {
    cwd: string;
    signal?: AbortSignal;
    timeoutMs?: number;
    maxCaptureBytes?: number;
  },
): Promise<ProcessResult> {
  return await new Promise((resolvePromise, rejectPromise) => {
    let stdout = "";
    let stderr = "";
    let capturedBytes = 0;
    let settled = false;
    let timedOut = false;

    const child = spawn(command, args, {
      cwd: options.cwd,
      shell: false,
      windowsHide: true,
      signal: options.signal,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const maxCapture = options.maxCaptureBytes ?? MAX_CAPTURE_BYTES;

    const append = (current: string, chunk: Buffer): string => {
      capturedBytes += chunk.length;
      if (capturedBytes > maxCapture) {
        child.kill();
        throw new Error(
          `${command} output exceeded the ${formatSize(maxCapture)} capture limit; narrow the query.`,
        );
      }
      return current + chunk.toString("utf8");
    };

    const timer = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill();
        }, options.timeoutMs)
      : undefined;

    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      callback();
    };

    child.stdout.on("data", (chunk: Buffer) => {
      try {
        stdout = append(stdout, chunk);
      } catch (error) {
        finish(() => rejectPromise(error));
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      try {
        stderr = append(stderr, chunk);
      } catch (error) {
        finish(() => rejectPromise(error));
      }
    });

    child.on("error", (error: NodeJS.ErrnoException) => {
      finish(() => {
        if (error.name === "AbortError") {
          rejectPromise(new Error(`${command} was aborted`));
          return;
        }
        if (error.code === "ENOENT") {
          rejectPromise(
            new Error(
              `${command} executable was not found on PATH. Install Microsoft tgrep and ensure Git is available, then restart Pi.`,
            ),
          );
          return;
        }
        rejectPromise(error);
      });
    });

    child.on("close", (exitCode) => {
      finish(() => {
        if (timedOut) {
          rejectPromise(new Error(`${command} timed out after ${options.timeoutMs}ms`));
          return;
        }
        resolvePromise({ stdout, stderr, exitCode });
      });
    });
  });
}

async function gitRoot(cwd: string): Promise<string | undefined> {
  try {
    const result = await runProcess(
      "git",
      ["-C", cwd, "rev-parse", "--show-toplevel"],
      { cwd, timeoutMs: 3000, maxCaptureBytes: 64 * 1024 },
    );
    if (result.exitCode !== 0) return undefined;
    const value = result.stdout.trim();
    return value ? await realpath(value) : undefined;
  } catch {
    return undefined;
  }
}

async function discoverScope(cwd: string): Promise<DiscoveryState> {
  const launchRoot = await realpath(cwd);

  // The filesystem root and the user's home directory are intentionally never
  // auto-indexed, even if they happen to contain Git repositories.
  if (isDangerousRoot(launchRoot)) {
    return {
      launchRoot,
      searchBoundary: launchRoot,
      mode: "scan-only",
      repos: [],
      reason: "Pi was launched from a protected root/home directory",
    };
  }

  const containingRepo = await gitRoot(launchRoot);
  if (containingRepo && !isDangerousRoot(containingRepo)) {
    return {
      launchRoot,
      searchBoundary: containingRepo,
      mode: "repository",
      repos: [
        {
          root: containingRepo,
          indexPath: join(containingRepo, ".tgrep"),
          name: basename(containingRepo),
        },
      ],
    };
  }

  const children = await readdir(launchRoot, { withFileTypes: true });
  const repos: RepoTarget[] = [];

  for (const entry of children) {
    // Do not follow symlinked directories during automatic discovery.
    if (!entry.isDirectory() || entry.name === ".tgrep") continue;

    const child = join(launchRoot, entry.name);
    if (!(await pathExists(join(child, ".git")))) continue;

    const childRoot = await gitRoot(child);
    if (!childRoot) continue;
    if (normalizeForCompare(childRoot) !== normalizeForCompare(child)) continue;
    if (isDangerousRoot(childRoot)) continue;

    repos.push({
      root: childRoot,
      indexPath: join(launchRoot, ".tgrep", repoIndexName(childRoot)),
      name: entry.name,
    });
  }

  repos.sort((a, b) => a.name.localeCompare(b.name));

  if (repos.length > 0) {
    return {
      launchRoot,
      searchBoundary: launchRoot,
      mode: "workspace",
      repos,
    };
  }

  return {
    launchRoot,
    searchBoundary: launchRoot,
    mode: "scan-only",
    repos: [],
    reason: "No Git repository at the launch directory or one level below it",
  };
}

async function resolveSearchPath(
  state: DiscoveryState,
  supplied: string,
): Promise<string> {
  const candidate = supplied
    ? isAbsolute(supplied)
      ? supplied
      : resolve(state.launchRoot, supplied)
    : state.launchRoot;

  let canonical: string;
  try {
    canonical = await realpath(candidate);
  } catch {
    throw new Error(`Search path does not exist: ${supplied || "."}`);
  }

  if (!isPathInside(state.searchBoundary, canonical)) {
    throw new Error(
      `Search path must stay within ${state.searchBoundary}: ${supplied}`,
    );
  }

  return canonical;
}

function displayPath(state: DiscoveryState, canonical: string): string {
  const rel = relative(state.launchRoot, canonical);
  return rel || ".";
}

function findRepoForPath(state: DiscoveryState, canonical: string): RepoTarget | undefined {
  return state.repos.find((repo) => isPathInside(repo.root, canonical));
}

async function buildSearchJobs(
  state: DiscoveryState,
  suppliedPaths: string[] | undefined,
): Promise<SearchJob[]> {
  if (!suppliedPaths?.length) {
    if (state.mode === "workspace") {
      return state.repos.map((repo) => ({
        path: displayPath(state, repo.root),
        repo,
        label: repo.name,
      }));
    }

    return [
      {
        path: ".",
        repo: state.mode === "repository" ? state.repos[0] : undefined,
        label: state.mode === "repository" ? state.repos[0]?.name ?? "." : ".",
      },
    ];
  }

  const jobs: SearchJob[] = [];
  const seen = new Set<string>();

  for (const supplied of suppliedPaths) {
    const canonical = await resolveSearchPath(state, supplied);

    if (state.mode === "workspace" && normalizeForCompare(canonical) === normalizeForCompare(state.launchRoot)) {
      for (const repo of state.repos) {
        const key = `repo:${normalizeForCompare(repo.root)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        jobs.push({
          path: displayPath(state, repo.root),
          repo,
          label: repo.name,
        });
      }
      continue;
    }

    const repo = findRepoForPath(state, canonical);
    const path = displayPath(state, canonical);
    const key = `${repo ? `repo:${normalizeForCompare(repo.root)}` : "scan"}:${normalizeForCompare(canonical)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    jobs.push({
      path,
      repo,
      label: repo?.name ?? path,
    });
  }

  return jobs;
}

async function serverRunning(repo: RepoTarget): Promise<boolean> {
  try {
    const result = await runProcess(
      "tgrep",
      ["status", repo.root, "--index-path", repo.indexPath],
      {
        cwd: repo.root,
        timeoutMs: SERVER_STATUS_TIMEOUT_MS,
        maxCaptureBytes: 256 * 1024,
      },
    );
    return result.exitCode === 0;
  } catch (error) {
    if (error instanceof Error && error.message.includes("not found on PATH")) {
      throw error;
    }
    return false;
  }
}

async function ensureServer(repo: RepoTarget): Promise<boolean> {
  if (await serverRunning(repo)) return true;

  await mkdir(repo.indexPath, { recursive: true });

  const child = spawn(
    "tgrep",
    ["serve", repo.root, "--index-path", repo.indexPath],
    {
      cwd: repo.root,
      detached: true,
      shell: false,
      windowsHide: true,
      stdio: "ignore",
    },
  );
  child.once("error", () => {});
  child.unref();

  const deadline = Date.now() + SERVER_START_WAIT_MS;
  while (Date.now() < deadline) {
    if (await serverRunning(repo)) return true;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }

  return false;
}

function buildSearchArgs(
  params: TgrepInput,
  job: SearchJob,
  useIndex: boolean,
): string[] {
  if (params.filesOnly && params.count) {
    throw new Error("filesOnly and count are mutually exclusive");
  }

  const args: string[] = ["--color", "never"];

  if (job.repo) {
    args.push("--index-path", job.repo.indexPath);
  }
  if (!useIndex) {
    args.push("--no-index");
  }

  if (params.fixed) args.push("-F");

  if (params.ignoreCase) {
    args.push("-i");
  } else if (params.smartCase !== false) {
    args.push("-S");
  }

  if (params.wholeWord) args.push("-w");
  if (params.filesOnly) args.push("-l");
  if (params.count) args.push("-c");
  if (params.invert) args.push("-v");
  if (params.multiline) args.push("-U");

  for (const glob of params.glob ?? []) {
    args.push("-g", glob);
  }

  if (params.fileType) {
    args.push("-t", params.fileType);
  }

  if (params.context !== undefined) {
    args.push("-C", String(params.context));
  }

  if (params.maxMatchesPerFile !== undefined) {
    args.push("-m", String(params.maxMatchesPerFile));
  }

  // tgrep has subcommands such as index, serve, search, and status. Everything
  // after `--` is unambiguously the pattern and search paths.
  args.push("--", params.pattern, job.path);
  return args;
}

function formatJobOutput(job: SearchJob, output: string, multiJob: boolean): string {
  if (!multiJob) return output.trimEnd();
  return `### ${job.label}\n${output.trimEnd()}`;
}

export default function tgrepExtension(pi: ExtensionAPI) {
  let discoveryPromise: Promise<DiscoveryState> | undefined;

  const getState = async (cwd: string): Promise<DiscoveryState> => {
    discoveryPromise ??= discoverScope(cwd);
    return await discoveryPromise;
  };

  pi.on("session_start", async (_event, ctx) => {
    discoveryPromise = discoverScope(ctx.cwd);
    await discoveryPromise;
  });

  pi.registerTool({
    name: "tgrep",
    label: "tgrep",
    description:
      `Fast code search using Microsoft's trigram-indexed tgrep CLI. ` +
      `Auto-indexing is limited to a Git repository containing the Pi launch directory, or Git repositories exactly one directory below the launch directory. ` +
      `Home/filesystem roots and all other directories are scan-only. Servers start lazily on the first indexed search. ` +
      `Prefer fixed=true for symbols/exact strings and filesOnly=true for broad discovery. ` +
      `Use freshness=current after very recent edits. Output is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}.`,
    parameters: TgrepParams,

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const state = await getState(ctx.cwd);
      const jobs = await buildSearchJobs(state, params.paths);
      const warnings: string[] = [];
      const outputs: string[] = [];
      const jobDetails: TgrepDetails["jobs"] = [];
      let matchedLines = 0;

      const indexedJobs = jobs.filter((job) => job.repo).length;
      const allowAutoServers = indexedJobs <= MAX_AUTO_SERVERS_PER_SEARCH;
      if (!allowAutoServers && indexedJobs > 0 && params.freshness !== "current") {
        warnings.push(
          `Search spans ${indexedJobs} repositories; automatic server startup is capped at ${MAX_AUTO_SERVERS_PER_SEARCH}, so this query used filesystem scans instead. Narrow paths to enable lazy indexing for a specific repository.`,
        );
      }

      for (const job of jobs) {
        let useIndex = false;

        if (job.repo && params.freshness !== "current" && allowAutoServers) {
          useIndex = await ensureServer(job.repo);
          if (!useIndex) {
            warnings.push(
              `${job.label}: tgrep server was not ready; used --no-index to avoid a stale on-disk index.`,
            );
          }
        }

        const args = buildSearchArgs(params, job, useIndex);
        const result = await runProcess("tgrep", args, {
          cwd: state.launchRoot,
          signal,
        });

        jobDetails.push({
          path: job.path,
          repository: job.repo?.root,
          indexed: useIndex,
          exitCode: result.exitCode,
        });

        if (result.stderr.trim()) {
          warnings.push(`${job.label}: ${result.stderr.trim()}`);
        }

        if (result.exitCode === 0) {
          const text = result.stdout.trimEnd();
          if (text) {
            outputs.push(formatJobOutput(job, text, jobs.length > 1));
            matchedLines += text.split("\n").filter(Boolean).length;
          }
          continue;
        }

        if (result.exitCode === 1) {
          continue;
        }

        const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.exitCode}`;
        if (outputs.length === 0) {
          throw new Error(`${job.label}: tgrep failed: ${detail}`);
        }
        warnings.push(`${job.label}: tgrep failed: ${detail}`);
      }

      if (outputs.length === 0) {
        const warningText = warnings.length
          ? `\n\nWarnings:\n${warnings.map((warning) => `- ${warning}`).join("\n")}`
          : "";
        return {
          content: [{ type: "text", text: `No matches found.${warningText}` }],
          details: {
            pattern: params.pattern,
            mode: state.mode,
            launchRoot: state.launchRoot,
            repositoryCount: state.repos.length,
            jobs: jobDetails,
            matchedLines: 0,
            truncated: false,
            warnings: warnings.length ? warnings : undefined,
          } satisfies TgrepDetails,
        };
      }

      let combined = outputs.join("\n\n");
      if (warnings.length) {
        combined += `\n\nWarnings:\n${warnings.map((warning) => `- ${warning}`).join("\n")}`;
      }

      const truncation = truncateHead(combined, {
        maxLines: DEFAULT_MAX_LINES,
        maxBytes: DEFAULT_MAX_BYTES,
      });

      const details: TgrepDetails = {
        pattern: params.pattern,
        mode: state.mode,
        launchRoot: state.launchRoot,
        repositoryCount: state.repos.length,
        jobs: jobDetails,
        matchedLines,
        truncated: truncation.truncated,
        warnings: warnings.length ? warnings : undefined,
      };

      let text = truncation.content;

      if (truncation.truncated) {
        const tempDir = await mkdtemp(join(tmpdir(), "pi-tgrep-"));
        const outputPath = join(tempDir, "output.txt");

        await withFileMutationQueue(outputPath, async () => {
          await writeFile(outputPath, combined, "utf8");
        });

        details.fullOutputPath = outputPath;

        text +=
          `\n\n[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines ` +
          `(${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}). ` +
          `Full output saved to: ${outputPath}]`;
      }

      return {
        content: [{ type: "text", text }],
        details,
      };
    },
  });
}
