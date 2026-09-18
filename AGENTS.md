# AGENTS.md

## Purpose

This repository contains a single Pi extension that wraps Microsoft's `tgrep`
CLI as a structured, agent-friendly code search tool.

## Compatibility

Target the current Pi extension API from:

- `@earendil-works/pi-coding-agent >= 0.85.1`

Keep the development dependency pinned to the current tested Pi version and
raise the peer minimum only when an API change requires it.

## Automatic indexing contract

The Pi launch directory is the trust boundary.

At `session_start`:

1. Resolve the launch directory.
2. Never auto-index a filesystem root or the user's home directory.
3. If the launch directory is inside a Git repository, resolve its Git root and
   register that one repository as index-eligible.
4. Otherwise inspect direct child directories only. A child is eligible only
   when it has `.git` and resolves to itself via `git rev-parse --show-toplevel`.
5. Do not recurse below the first level and do not follow symlinked directories.
6. Discovery must not create an index or start a server.

On the first indexed search that touches an eligible repository:

1. Check `tgrep status <root> --index-path <index>`.
2. If needed, start detached `tgrep serve <root> --index-path <index>`.
3. Wait briefly for the server.
4. If the server is unavailable, force `--no-index`; never silently use a stale
   disk-only index after startup failure.

Index locations:

- Repository mode: `<git-root>/.tgrep`
- Workspace mode: `<launch-root>/.tgrep/<repo-name>-<path-hash>`

A search spanning more than 10 repositories must not auto-start all servers.
Use filesystem scans unless the caller narrows the path.

## tgrep command construction

Follow these rules:

1. Never invoke through a shell. Use `spawn()` and argument arrays.
2. Put all flags before `--`.
3. Always put `--` immediately before the pattern.
4. Put search roots after the pattern.
5. Prefer `-F` for literal/symbol searches.
6. Keep smart-case as the default unless the caller explicitly requests
   case-insensitive matching or disables smart-case.
7. Reject incompatible output modes instead of guessing.
8. Keep tool output bounded using Pi's current truncation helpers.
9. Use `--no-index` for `freshness=current`.
10. Search paths must remain inside the discovery boundary established at Pi
    session start.

## tgrep semantics to preserve

`tgrep serve` auto-builds a missing index and watches for changes. Searches
resolve through the running server first, then a disk index, then a filesystem
scan. Since a disk-only index can be stale, startup failure must explicitly
force `--no-index`.

Do not implement index building or file watching inside this extension; defer
those responsibilities to tgrep.

## Validation

Before release:

```bash
npm install
npm run check
```

Also test these launch scenarios with `tgrep` on PATH:

- inside a Git repository root
- inside a nested directory of a Git repository
- workspace parent containing multiple direct-child Git repositories
- user home directory
- filesystem root
- plain non-Git directory
