# pi-tgrep

A [Pi](https://pi.dev) extension that exposes Microsoft's
[`tgrep`](https://github.com/microsoft/tgrep) as a native agent tool with safe,
lazy repository indexing.

`tgrep` uses a trigram index and optional server to make repeated code searches
fast in large repositories. `pi-tgrep` decides when an index is allowed, starts
`tgrep serve` only when it is actually needed, and falls back to normal scanning
when automatic indexing would be unsafe or surprising.

## Requirements

- Pi `@earendil-works/pi-coding-agent >= 0.85.1`
- `tgrep` available on `PATH`
- `git` available on `PATH` for repository discovery

Install tgrep using an upstream-supported method:

```bash
brew install tgrep
```

Or use a prebuilt binary / build method documented by Microsoft tgrep.

## Install this Pi extension

From GitHub:

```bash
pi install git:github.com/skyland-zero/pi-tgrep
```

After publishing to npm:

```bash
pi install npm:pi-tgrep
```

Try it for one Pi session:

```bash
pi -e git:github.com/skyland-zero/pi-tgrep
```

## Automatic indexing policy

The Pi launch directory is the trust boundary. Discovery happens at session
start, but no index or server is created until the first indexed search.

### 1. Pi starts inside a Git repository

Example:

```text
C:\Code\MyApp\src> pi
```

`pi-tgrep` resolves the containing Git root:

```text
C:\Code\MyApp
```

The repository becomes eligible for lazy indexing. Its index lives at:

```text
C:\Code\MyApp\.tgrep
```

On the first indexed search, the extension starts:

```text
tgrep serve C:\Code\MyApp --index-path C:\Code\MyApp\.tgrep
```

`tgrep serve` builds the index in the background if it does not exist and keeps
it updated using tgrep's watcher/reconciliation behavior.

### 2. Pi starts in a workspace whose first-level children are Git repositories

Example:

```text
C:\Code> pi

C:\Code\App1\.git
C:\Code\App2\.git
C:\Code\notes\
```

Only first-level Git repositories are discovered. There is no recursive repo
hunt. Each repository gets an independent index under the Pi launch directory:

```text
C:\Code\.tgrep\
├── App1-<hash>\
└── App2-<hash>\
```

Servers are started lazily per repository when a search actually touches that
repository. A default search with no `paths` searches the discovered Git
repositories. An explicitly requested non-repository path such as `notes` is
searched with `--no-index`.

### 3. Pi starts from Home, a filesystem root, or a directory with no eligible Git repository

Examples:

```text
C:\Users\Jeff> pi
C:\> pi
/tmp/random> pi
```

No index and no tgrep server are created. Searches use:

```text
tgrep --no-index ...
```

This prevents accidental indexing of a home directory, drive root, download
folder, or another arbitrary tree.

### Safety invariants

- Home directories and filesystem roots are always scan-only.
- A tool call cannot expand the automatic-indexing scope discovered at Pi
  startup.
- Workspace discovery checks only direct children and does not follow symlinked
  directories.
- Search paths must stay inside the discovered repository root (repository mode)
  or Pi launch directory (workspace / scan-only mode).
- If a server cannot be started, the search explicitly uses `--no-index` rather
  than silently reading a potentially stale on-disk index.
- A search spanning more than 10 repositories does not auto-start all servers;
  it scans instead. Narrowing `paths` to one repository restores lazy indexing.

## Freshness

The default `freshness="indexed"` uses the tgrep server when the current search
is eligible. The server keeps its index close to the filesystem, but watcher
updates are asynchronous.

For a search that must see a just-written file immediately, use:

```text
tgrep(pattern="NewSymbol", fixed=true, freshness="current")
```

That forces `--no-index` for the query.

## Tool

The extension registers one native Pi tool named `tgrep`.

Important behavior:

- Always inserts `--` before the pattern, preventing `index`, `serve`, `status`,
  etc. from being parsed as subcommands.
- Defaults to smart-case matching (`-S`).
- Supports literal search, whole-word search, glob/type filters, context lines,
  per-file match limits, filename-only mode, count mode, invert matching, and
  multiline matching.
- Uses argument-array process spawning instead of shell interpolation.
- Honors Pi's abort signal.
- Caps captured output at 8 MiB per search path, 16 MiB per tool call, and
  20,000 lines. Larger searches stop with a warning so the query can be narrowed.
- Applies Pi's built-in visible-output truncation and saves the full captured
  result to a temporary file when that visible limit is reached.

### Agent-oriented examples

Find a symbol literally:

```text
tgrep(pattern="ExtensionAPI", fixed=true)
```

Search TypeScript with surrounding context:

```text
tgrep(pattern="registerTool", fileType="ts", context=3)
```

Find candidate files first:

```text
tgrep(pattern="createAgentSession", filesOnly=true)
```

Search only one workspace repository:

```text
tgrep(pattern="UserService", fixed=true, paths=["App1"])
```

Force a fresh filesystem scan after an edit:

```text
tgrep(pattern="NewSymbol", fixed=true, freshness="current")
```

## `.tgrep` and Git

Microsoft tgrep recommends keeping `.tgrep/` out of version control. Add this to
repositories where the index is stored at the repo root:

```gitignore
.tgrep/
```

Workspace-mode indexes live in the non-repository workspace parent, so they do
not normally affect a child repository's Git status.

## Development

```bash
npm install
npm run check
```

Run locally without installing the package:

```bash
pi -e ./extensions/tgrep.ts
```

## License

MIT.
