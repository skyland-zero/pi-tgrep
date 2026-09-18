import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readdir, realpath, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { StringDecoder } from "node:string_decoder";
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
  capturedBytes: number;
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
const MAX_SEARCH_JOB_CAPTURE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_SEARCH_CAPTURE_BYTES = 16 * 1024 * 1024;
const MAX_TOTAL_SEARCH_LINES = 20_000;
const MAX_WARNING_COUNT = 100;
const MAX_WARNING_CHARS = 4_000;
const SERVER_START_WAIT_MS = 1500;
const SERVER_STATUS_TIMEOUT_MS = 800;
const MAX_AUTO_SERVERS_PER_SEARCH = 10;

class ProcessOutputLimitError extends Error {
  constructor(command: string, maxCaptureBytes: number) {
    super(
      `${command} output exceeded the ${formatSize(maxCaptureBytes)} capture limit; narrow the query.`,
    );
    this.name = "ProcessOutputLimitError";
  }
}

function normalizeForCompare(path: string): string {
  const normalized = resolve(path);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isPathInside(parent: string, child: string): boolean {
  const parentKey = normalizeForCompare(parent);
  const childKey = normalizeForCompare(child);
  const rel = relative(parentKey, childKey);
  return (
    rel === "" ||
    (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
  );
}

function isDangerousRoot(path: string, homePath: string): boolean {
  const resolved = resolve(path);
  if (dirname(resolved) === resolved) return true;
  return normalizeForCompare(resolved) === normalizeForCompare(homePath);
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

    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");

    const append = (
      current: string,
      chunk: Buffer,
      decoder: StringDecoder,
    ): string => {
      capturedBytes += chunk.length;
      if (capturedBytes > maxCapture) {
        child.kill();
        throw new ProcessOutputLimitError(command, maxCapture);
      }
      return current + decoder.write(chunk);
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
        stdout = append(stdout, chunk, stdoutDecoder);
      } catch (error) {
        finish(() => rejectPromise(error));
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      try {
        stderr = append(stderr, chunk, stderrDecoder);
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
        stdout += stdoutDecoder.end();
        stderr += stderrDecoder.end();
        if (timedOut) {
          rejectPromise(new Error(`${command} timed out after ${options.timeoutMs}ms`));
          return;
        }
        resolvePromise({ stdout, stderr, exitCode, capturedBytes });
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
  let homeRoot: string;
  try {
    homeRoot = await realpath(homedir());
  } catch {
    homeRoot = resolve(homedir());
  }

  // The filesystem root and the user's home directory are intentionally never
  // auto-indexed, even if they happen to contain Git repositories.
  if (isDangerousRoot(launchRoot, homeRoot)) {
    return {
      launchRoot,
      searchBoundary: launchRoot,
      mode: "scan-only",
      repos: [],
      reason: "Pi was launched from a protected root/home directory",
    };
  }

  const containingRepo = await gitRoot(launchRoot);
  if (containingRepo && !isDangerousRoot(containingRepo, homeRoot)) {
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
    if (isDangerousRoot(childRoot, homeRoot)) continue;

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

    if (state.mode === "repository") {
      const repo = state.repos[0];
      return [
        {
          path: repo ? displayPath(state, repo.root) : ".",
          repo,
          label: repo?.name ?? ".",
        },
      ];
    }

    return [
      {
        path: ".",
        label: ".",
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
    if (result.exitCode !== 0) return false;

    // `tgrep status` exits successfully when it reports that the server is not
    // running (and also when no index exists). Current tgrep prints a PID when
    // the server is active; older builds may print an explicit `Server: running`
    // line. Only one of those positive states is enough to trust the index.
    if (/^\s*Server\s*:\s*not\s+running\b/im.test(result.stdout)) return false;
    if (/^\s*Server\s*:\s*running\b/im.test(result.stdout)) return true;
    return /^\s*PID\s*:\s*\d+\s*$/im.test(result.stdout);
  } catch (error) {
    if (error instanceof Error && error.message.includes("not found on PATH")) {
      throw error;
    }
    return false;
  }
}

async function ensureServer(repo: RepoTarget): Promise<boolean> {
  if (await serverRunning(repo)) return true;

  try {
    await mkdir(repo.indexPath, { recursive: true });
  } catch {
    return false;
  }

  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(
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
  } catch {
    return false;
  }
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

function countLines(text: string): number {
  if (text.length === 0) return 0;
  let lines = 1;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) lines++;
  }
  return text.endsWith("\n") ? lines - 1 : lines;
}

function countNonEmptyLines(text: string): number {
  let count = 0;
  let lineStart = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) !== 10) continue;
    if (i > lineStart) count++;
    lineStart = i + 1;
  }
  if (lineStart < text.length) count++;
  return count;
}

function takeFirstLines(text: string, maxLines: number): string {
  if (maxLines <= 0) return "";
  let lines = 1;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) !== 10) continue;
    if (lines === maxLines) return text.slice(0, i);
    lines++;
  }
  return text;
}

function compactWarning(warning: string): string {
  const compact = warning.replace(/\s+/g, " ").trim();
  if (compact.length <= MAX_WARNING_CHARS) return compact;

  let end = MAX_WARNING_CHARS;
  const lastChar = compact.charCodeAt(end - 1);
  if (lastChar >= 0xd800 && lastChar <= 0xdbff) end--;
  return `${compact.slice(0, end)}… [warning truncated]`;
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
      `Use freshness=current after very recent edits. Search capture is capped at ${formatSize(MAX_SEARCH_JOB_CAPTURE_BYTES)} per path, ${formatSize(MAX_TOTAL_SEARCH_CAPTURE_BYTES)} per call, and ${MAX_TOTAL_SEARCH_LINES.toLocaleString()} lines. Displayed output is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}.`,
    parameters: TgrepParams,

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (params.filesOnly && params.count) {
        throw new Error("filesOnly and count are mutually exclusive");
      }

      const state = await getState(ctx.cwd);
      const jobs = await buildSearchJobs(state, params.paths);
      const warnings: string[] = [];
      let omittedWarningCount = 0;
      const addWarning = (warning: string) => {
        if (warnings.length >= MAX_WARNING_COUNT) {
          omittedWarningCount++;
          return;
        }
        warnings.push(compactWarning(warning));
      };
      const visibleWarnings = () =>
        omittedWarningCount > 0
          ? [...warnings, `${omittedWarningCount} additional warnings omitted.`]
          : warnings;
      const outputs: string[] = [];
      const jobDetails: TgrepDetails["jobs"] = [];
      let matchedLines = 0;
      let capturedBytes = 0;
      let outputBytes = 0;
      let outputLines = 0;
      let outputLimitReached = false;

      const indexedJobs = jobs.filter((job) => job.repo).length;
      const allowAutoServers = indexedJobs <= MAX_AUTO_SERVERS_PER_SEARCH;
      if (!allowAutoServers && indexedJobs > 0 && params.freshness !== "current") {
        addWarning(
          `Search spans ${indexedJobs} repositories; automatic server startup is capped at ${MAX_AUTO_SERVERS_PER_SEARCH}, so this query used filesystem scans instead. Narrow paths to enable lazy indexing for a specific repository.`,
        );
      }

      for (const job of jobs) {
        const remainingCaptureBytes =
          MAX_TOTAL_SEARCH_CAPTURE_BYTES - capturedBytes;
        if (remainingCaptureBytes <= 0) {
          outputLimitReached = true;
          addWarning(
            `Search reached the ${formatSize(MAX_TOTAL_SEARCH_CAPTURE_BYTES)} total capture limit; remaining paths were skipped. Narrow the query or search fewer paths.`,
          );
          break;
        }

        let useIndex = false;

        if (job.repo && params.freshness !== "current" && allowAutoServers) {
          useIndex = await ensureServer(job.repo);
          if (!useIndex) {
            addWarning(
              `${job.label}: tgrep server was not ready; used --no-index to avoid a stale on-disk index.`,
            );
          }
        }

        const args = buildSearchArgs(params, job, useIndex);
        let result: ProcessResult;
        try {
          result = await runProcess("tgrep", args, {
            cwd: state.launchRoot,
            signal,
            maxCaptureBytes: Math.min(
              MAX_SEARCH_JOB_CAPTURE_BYTES,
              remainingCaptureBytes,
            ),
          });
        } catch (error) {
          if (!(error instanceof ProcessOutputLimitError)) throw error;

          jobDetails.push({
            path: job.path,
            repository: job.repo?.root,
            indexed: useIndex,
            exitCode: null,
          });
          outputLimitReached = true;
          addWarning(
            `${job.label}: ${error.message} Search stopped here; remaining paths were skipped.`,
          );
          break;
        }
        capturedBytes += result.capturedBytes;

        jobDetails.push({
          path: job.path,
          repository: job.repo?.root,
          indexed: useIndex,
          exitCode: result.exitCode,
        });

        if (result.stderr.trim()) {
          addWarning(`${job.label}: ${result.stderr}`);
        }

        if (result.exitCode === 0) {
          const text = result.stdout.trimEnd();
          if (text) {
            const formatted = formatJobOutput(job, text, jobs.length > 1);
            const separatorBytes = outputs.length ? 2 : 0;
            const separatorLines = outputs.length ? 2 : 0;
            const remainingOutputBytes =
              MAX_TOTAL_SEARCH_CAPTURE_BYTES - outputBytes - separatorBytes;
            const remainingOutputLines =
              MAX_TOTAL_SEARCH_LINES - outputLines - separatorLines;
            const formattedBytes = Buffer.byteLength(formatted, "utf8");
            const formattedLines = countLines(formatted);

            if (formattedBytes > remainingOutputBytes) {
              outputLimitReached = true;
              addWarning(
                `Search reached the ${formatSize(MAX_TOTAL_SEARCH_CAPTURE_BYTES)} total output limit; this and remaining results were omitted. Narrow the query or search fewer paths.`,
              );
              break;
            }

            if (formattedLines > remainingOutputLines) {
              const keptFormatted = takeFirstLines(
                formatted,
                remainingOutputLines,
              );
              if (keptFormatted) {
                outputs.push(keptFormatted);
                outputBytes +=
                  separatorBytes + Buffer.byteLength(keptFormatted, "utf8");
                outputLines += separatorLines + countLines(keptFormatted);
              }
              const keptMatchText =
                jobs.length > 1
                  ? takeFirstLines(text, Math.max(0, remainingOutputLines - 1))
                  : keptFormatted;
              matchedLines += countNonEmptyLines(keptMatchText);
              outputLimitReached = true;
              addWarning(
                `Search reached the ${MAX_TOTAL_SEARCH_LINES.toLocaleString()} line limit; remaining results were omitted. Narrow the query or search fewer paths.`,
              );
              break;
            }

            outputs.push(formatted);
            outputBytes += separatorBytes + formattedBytes;
            outputLines += separatorLines + formattedLines;
            matchedLines += countNonEmptyLines(text);
          }
          continue;
        }

        if (result.exitCode === 1) {
          continue;
        }

        const detail = compactWarning(
          result.stderr.trim() || result.stdout.trim() || `exit code ${result.exitCode}`,
        );
        if (outputs.length === 0) {
          throw new Error(`${job.label}: tgrep failed: ${detail}`);
        }
        addWarning(`${job.label}: tgrep failed: ${detail}`);
      }

      if (outputs.length === 0) {
        const finalWarnings = visibleWarnings();
        const warningText = finalWarnings.length
          ? `\n\nWarnings:\n${finalWarnings.map((warning) => `- ${warning}`).join("\n")}`
          : "";
        const message = `${outputLimitReached ? "Search incomplete; output limits were reached before any results could be returned." : "No matches found."}${warningText}`;
        const truncation = truncateHead(message, {
          maxLines: DEFAULT_MAX_LINES,
          maxBytes: DEFAULT_MAX_BYTES,
        });
        let text = truncation.content;
        if (truncation.truncated) {
          text += "\n\n[Warning output truncated; see tool details for recorded warnings.]";
        }
        return {
          content: [{ type: "text", text }],
          details: {
            pattern: params.pattern,
            mode: state.mode,
            launchRoot: state.launchRoot,
            repositoryCount: state.repos.length,
            jobs: jobDetails,
            matchedLines: 0,
            truncated: outputLimitReached || truncation.truncated,
            warnings: finalWarnings.length ? finalWarnings : undefined,
          } satisfies TgrepDetails,
        };
      }

      let combined = outputs.join("\n\n");
      const finalWarnings = visibleWarnings();
      if (finalWarnings.length) {
        combined += `\n\nWarnings:\n${finalWarnings.map((warning) => `- ${warning}`).join("\n")}`;
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
        truncated: truncation.truncated || outputLimitReached,
        warnings: finalWarnings.length ? finalWarnings : undefined,
      };

      let text = truncation.content;

      if (truncation.truncated && !outputLimitReached) {
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

      if (outputLimitReached) {
        text +=
          `\n\n[Search incomplete: the output limit was reached; some paths or results were omitted.]`;
      }

      return {
        content: [{ type: "text", text }],
        details,
      };
    },
  });
}
