/**
 * Running Apple Shortcuts from the main process: `/usr/bin/shortcuts` with an argument list (execFile, no shell).
 *
 * - The shortcut's name always comes after "--", so no name can be read as an option.
 * - A value for the shortcut (a temperature, say) is written to a temporary file and passed with --input-path,
 *   because the shortcuts tool takes input only from files. It never goes into the command.
 * - Every run has a timeout, a small output limit, and can be stopped (Stop aborts it).
 */

import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const SHORTCUTS_BIN = "/usr/bin/shortcuts";
export const RUN_TIMEOUT_MS = 20_000;
export const LIST_TIMEOUT_MS = 10_000;

export interface ShortcutsResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
}

export type ShortcutsRunner = (
  args: string[],
  timeoutMs: number,
  signal?: AbortSignal,
) => Promise<ShortcutsResult>;

/** `shortcuts run [--input-path <file>] -- <name>`. */
export function runArgs(name: string, inputPath: string | null): string[] {
  return inputPath ? ["run", "--input-path", inputPath, "--", name] : ["run", "--", name];
}

export const LIST_ARGS = ["list"];

/** The real runner. Never rejects: failures come back as a result. */
export const runShortcuts: ShortcutsRunner = (args, timeoutMs, signal) =>
  new Promise((resolve) => {
    execFile(
      SHORTCUTS_BIN,
      args,
      { timeout: timeoutMs, maxBuffer: 256 * 1024, windowsHide: true, ...(signal ? { signal } : {}) },
      (err, stdout, stderr) => {
        const e = err as (NodeJS.ErrnoException & { killed?: boolean; code?: number | string }) | null;
        resolve({
          code: e ? (typeof e.code === "number" ? e.code : 1) : 0,
          stdout: String(stdout ?? ""),
          stderr: String(stderr ?? e?.message ?? ""),
          timedOut: Boolean(e?.killed) && !signal?.aborted,
          aborted: Boolean(signal?.aborted),
        });
      },
    );
  });

export interface InputFile {
  path: string;
  remove(): Promise<void>;
}

/** Writes a shortcut's input to a new private temporary folder, removed after the run. */
export async function writeInputFile(text: string): Promise<InputFile> {
  const dir = await mkdtemp(join(tmpdir(), "agency-home-"));
  const path = join(dir, "input.txt");
  await writeFile(path, text, { encoding: "utf8", mode: 0o600 });
  return { path, remove: () => rm(dir, { recursive: true, force: true }) };
}

/** The tool's failure in plain words, with what a helper can do. */
export function describeRunFailure(r: ShortcutsResult, shortcut: string): string {
  if (r.aborted) return "Stopped.";
  if (r.timedOut) return `"${shortcut}" took too long. AGENCY didn't try again.`;
  const err = r.stderr.toLowerCase();
  if (err.includes("couldn’t find shortcut") || err.includes("couldn't find shortcut"))
    return `There's no shortcut called "${shortcut}" on this Mac. A helper can check its exact name in the Shortcuts app.`;
  if (err.includes("not authorized") || err.includes("not allowed") || err.includes("permission"))
    return `macOS didn't allow "${shortcut}" to run. A helper can open it once in the Shortcuts app and allow what it asks.`;
  if (r.code === 127 || err.includes("enoent"))
    return "The Shortcuts tool isn't on this Mac (it needs macOS 12 or later).";
  return `"${shortcut}" didn't finish. Nothing more was tried.`;
}

/** Names from `shortcuts list`: one per line. */
export function parseList(stdout: string): string[] {
  return stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 500);
}
