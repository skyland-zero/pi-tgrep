---
name: tgrep
description: Use the Pi tgrep tool or Microsoft's tgrep CLI to search source code for symbols, exact text, usages, candidate files, file types, or counts. Load when locating code or choosing between indexed and current filesystem results.
license: MIT
compatibility: Requires the pi-tgrep package for the native Pi tool; raw CLI use requires Microsoft tgrep on PATH.
---

# Search Code with tgrep

## Prefer the Pi tool

When the native `tgrep` tool is available, use it instead of invoking the CLI
directly. The extension discovers the allowed repository scope, starts a server
lazily, and falls back to a fresh filesystem scan if the server is unavailable.
Do not manually build or start indexes for searches through this tool.

Start with a literal search for symbols or text the user typed:

```text
tgrep(pattern="parseConfig", fixed=true)
tgrep(pattern="registerTool", fixed=true, fileType="ts", context=3)
```

Use regex when the match itself varies. Narrow broad searches early with
`fileType`, `glob`, or `paths`; `maxMatchesPerFile` limits returned matches but
does not make the search scope smaller.

```text
tgrep(pattern="TODO|FIXME", glob=["*.ts"], paths=["extensions"])
tgrep(pattern="Server", fileType="rust", filesOnly=true)
tgrep(pattern="deprecated", count=true)
```

`filesOnly=true` and `count=true` cannot be combined. Use `context=2` or
`context=3` when surrounding lines will help identify the right result.

## Matching options

- `fixed=true` treats the pattern literally. Otherwise the pattern is a regex.
- Smart case is on by default. Use `ignoreCase=true` to force case-insensitive
  matching, or `smartCase=false` to disable smart case.
- `wholeWord=true` matches whole words only.
- `fileType` accepts one tgrep type such as `ts`, `rust`, or `py`.
- `glob` accepts one or more file globs, such as `["*.ts", "*.tsx"]`.
- `context` accepts 0–20 lines; `maxMatchesPerFile` accepts 1–1000.
- `invert=true` returns non-matching lines; `multiline=true` allows matches to
  cross line boundaries.

## Paths and repository scope

`paths` is an array. Relative paths start at Pi's launch directory; absolute
paths are accepted only inside the boundary discovered when the session
started. Do not try to search outside that boundary.

With no `paths`, a session inside a Git repository searches that repository. A
workspace session searches its discovered direct-child Git repositories. A
home directory, filesystem root, or plain non-Git directory is scan-only. A
search across more than 10 repositories scans files rather than starting every
server; narrow `paths` to one repository when indexed search is useful.

## Freshness and output limits

The default `freshness="indexed"` uses the tgrep server when available. Its
watcher applies changes asynchronously. Use `freshness="current"` after a very
recent edit or file creation that must be visible immediately; it forces
`--no-index` and reads the current filesystem.

Search capture is capped at 8 MiB per path, 16 MiB per call, and 20,000 lines.
If the tool reports that a limit was reached, treat the result as incomplete
and narrow the query instead of assuming omitted paths had no matches. The
visible response is also limited by Pi's standard output truncation limits.

## Raw CLI fallback

Use the CLI only when the Pi tool is unavailable and `tgrep` is on `PATH`. Put
all flags before `--`, then the pattern, then the search root. Always include
`--`; quoting alone does not prevent words such as `status` or `serve` from
being parsed as subcommands.

```bash
tgrep -F -- "parseConfig" .
tgrep -t rust -C 2 -- "handle" .
tgrep -l -- "impl .* for Server" .
tgrep --no-index -F -- "NEW_SYMBOL" .
```

The CLI returns 0 when it finds matches, 1 when it finds none, and 2 on an
error. An on-disk index without a running server can be stale; use `--no-index`
when the latest filesystem contents matter. For the full CLI reference, see
[Microsoft tgrep's agent guide](https://github.com/microsoft/tgrep/blob/main/AGENTS.md)
and [README](https://github.com/microsoft/tgrep/blob/main/README.md).
