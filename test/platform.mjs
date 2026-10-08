import { existsSync } from "node:fs";

/**
 * The command that lists executables on `PATH`: Windows uses `where.exe`, everything else `which`.
 * The extension picks the same one, so a test that fakes a missing tgrep must answer this command.
 */
export const LIST_BINARY = process.platform === "win32" ? "where.exe" : "which";

/** Git Bash is pi's shell on Windows; a bare `bash` there may be WSL's, which cannot run these tests. */
const GIT_BASH = ["C:\\Program Files\\Git\\bin\\bash.exe", "C:\\Program Files (x86)\\Git\\bin\\bash.exe"];

/** A POSIX shell for tests that execute rewritten commands (`PI_TGREP_TEST_SHELL` overrides it). */
export const SHELL =
  process.platform === "win32"
    ? process.env.PI_TGREP_TEST_SHELL || GIT_BASH.find((candidate) => existsSync(candidate)) || "bash"
    : "/bin/sh";
