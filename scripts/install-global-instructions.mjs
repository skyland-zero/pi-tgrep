import { appendFile, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const START_MARKER = "<!-- pi-tgrep:begin -->";
const END_MARKER = "<!-- pi-tgrep:end -->";
const RULE =
  "When the native `tgrep` tool is available, prefer it for source-code search. Use `fixed=true` for exact text or symbols, narrow broad searches with `paths`, `fileType`, or `glob`, and use `freshness=\"current\"` when recent edits must be visible; read `/skill:tgrep` for details.";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const agentDir = resolve(
  expandTilde(
    process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"),
  ),
);
const agentsPath = join(agentDir, "AGENTS.md");

function expandTilde(path) {
  if (path === "~") return homedir();
  if (path.startsWith("~/") || path.startsWith("~\\")) {
    return join(homedir(), path.slice(2));
  }
  return path;
}

function isPathInside(parent, child) {
  const rel = relative(resolve(parent), resolve(child));
  return (
    rel === "" ||
    (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
  );
}

async function canonicalPath(path) {
  try {
    return await realpath(path);
  } catch {
    return resolve(path);
  }
}

async function isPiGlobalPackage() {
  const canonicalPackageRoot = await canonicalPath(packageRoot);
  const canonicalAgentDir = await canonicalPath(agentDir);
  const candidateRoots = [join(canonicalAgentDir, "git"), join(canonicalAgentDir, "npm")];
  if (process.env.PI_PACKAGE_DIR) {
    candidateRoots.push(expandTilde(process.env.PI_PACKAGE_DIR));
  }

  const roots = await Promise.all(candidateRoots.map(canonicalPath));
  return roots.some((root) => isPathInside(root, canonicalPackageRoot));
}

async function readAgentsFile() {
  try {
    return await readFile(agentsPath, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return "";
    }
    throw error;
  }
}

async function installRule(force) {
  if (process.env.PI_TGREP_SKIP_GLOBAL_RULE === "1") return;
  if (!force && !(await isPiGlobalPackage())) return;

  await mkdir(dirname(agentsPath), { recursive: true });
  const existing = await readAgentsFile();
  const hasStart = existing.includes(START_MARKER);
  const hasEnd = existing.includes(END_MARKER);

  if (hasStart && hasEnd) return;
  if (hasStart || hasEnd) {
    console.warn(`pi-tgrep: found an incomplete managed block in ${agentsPath}; left it unchanged.`);
    return;
  }
  if (existing.includes(RULE)) return;

  const newline = existing.includes("\r\n") ? "\r\n" : "\n";
  const separator =
    existing.length > 0 && !existing.endsWith("\n") && !existing.endsWith("\r")
      ? newline
      : "";
  const block = [START_MARKER, RULE, END_MARKER].join(newline);
  await appendFile(agentsPath, `${separator}${block}${newline}`, "utf8");
  console.log(`pi-tgrep: added the tgrep usage rule to ${agentsPath}`);
}

async function removeRule() {
  const existing = await readAgentsFile();
  const start = existing.indexOf(START_MARKER);
  if (start < 0) return;

  const end = existing.indexOf(END_MARKER, start + START_MARKER.length);
  if (end < 0) {
    console.warn(`pi-tgrep: found an incomplete managed block in ${agentsPath}; left it unchanged.`);
    return;
  }

  let endExclusive = end + END_MARKER.length;
  if (existing.startsWith("\r\n", endExclusive)) endExclusive += 2;
  else if (existing[endExclusive] === "\n" || existing[endExclusive] === "\r") endExclusive++;

  const updated = existing.slice(0, start) + existing.slice(endExclusive);
  await writeFile(agentsPath, updated, "utf8");
  console.log(`pi-tgrep: removed the managed tgrep usage rule from ${agentsPath}`);
}

try {
  const action = process.argv[2];
  if (action === "--remove") {
    await removeRule();
  } else if (action === "--force") {
    await installRule(true);
  } else if (action) {
    console.warn("Usage: node scripts/install-global-instructions.mjs [--force|--remove]");
  } else {
    await installRule(false);
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  // A global instruction write should not break package installation.
  console.warn(`pi-tgrep: could not update ${agentsPath}: ${message}`);
}
