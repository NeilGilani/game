/**
 * Running Apple Shortcuts from the main process: `/usr/bin/shortcuts` with an argument vector (execFile, no shell),
 * so a name or an input can never change what runs. An input goes through a private temporary file
 * (`--input-path`), and a shortcut's text output comes back through another (`--output-path`). Both are deleted
 * straight after.
 */

import { execFile, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const SHORTCUTS_BIN = "/usr/bin/shortcuts";
export const RUN_TIMEOUT_MS = 30_000;
const MAX_OUTPUT = 4 * 1024;

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** Runs a program with arguments (never through a shell). Returns the child so Stop can end it. */
export type Exec = (
  file: string,
  args: string[],
  timeoutMs: number,
) => { child: ChildProcess | null; done: Promise<ExecResult> };

export const realExec: Exec = (file, args, timeoutMs) => {
  let child: ChildProcess | null = null;
  const done = new Promise<ExecResult>((resolve) => {
    child = execFile(
      file,
      args,
      { timeout: timeoutMs, maxBuffer: 256 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        const e = err as (NodeJS.ErrnoException & { killed?: boolean; code?: number | string }) | null;
        resolve({
          code: e ? (typeof e.code === "number" ? e.code : 1) : 0,
          stdout: String(stdout ?? ""),
          stderr: String(stderr ?? e?.message ?? ""),
          timedOut: Boolean(e?.killed),
        });
      },
    );
  });
  return { child, done };
};

/** The argument list for one run. The name is a separate argument; files carry the input and output. */
export function runArgs(name: string, inputPath: string | null, outputPath: string): string[] {
  const args = ["run", name];
  if (inputPath) args.push("--input-path", inputPath);
  args.push("--output-path", outputPath, "--output-type", "public.plain-text");
  return args;
}

/** A shortcut's output as one short line for the screen, or null when it said nothing. */
export function cleanOutput(raw: string): string | null {
  const line = raw
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return line ? line.slice(0, 40) : null;
}

/** What went wrong, in words a helper can act on. */
export function describeShortcutFailure(r: ExecResult, name: string): string {
  if (r.timedOut)
    return `The shortcut "${name}" took too long, so AGENCY stopped waiting. Check the device before trying again.`;
  const err = r.stderr.toLowerCase();
  if (/couldn.t find|not found|no shortcut/.test(err))
    return `There's no shortcut called "${name}" on this Mac. A helper can check its name in the Shortcuts app.`;
  if (/not allowed|permission|privacy/.test(err))
    return `macOS didn't let "${name}" run. A helper can open it once in the Shortcuts app and allow what it asks.`;
  return `The shortcut "${name}" didn't finish${r.code !== null ? ` (code ${r.code})` : ""}. Nothing more was tried.`;
}

export interface ShortcutRun {
  child: ChildProcess | null;
  done: Promise<{ ok: true; output: string | null } | { ok: false; error: string }>;
}

/** Run one shortcut with an optional fixed input. Never retries. */
export function runShortcut(exec: Exec, name: string, input: string | undefined): ShortcutRun {
  const dir = mkdtempSync(join(tmpdir(), "agency-home-"));
  const inputPath = input !== undefined ? join(dir, "input.txt") : null;
  const outputPath = join(dir, "output.txt");
  if (inputPath) writeFileSync(inputPath, input ?? "", { mode: 0o600 });
  const { child, done } = exec(SHORTCUTS_BIN, runArgs(name, inputPath, outputPath), RUN_TIMEOUT_MS);
  return {
    child,
    done: done
      .then((r) => {
        if (r.code !== 0) return { ok: false as const, error: describeShortcutFailure(r, name) };
        let out = "";
        try {
          out = readFileSync(outputPath, "utf8").slice(0, MAX_OUTPUT);
        } catch {
          /* the shortcut gave no output */
        }
        return { ok: true as const, output: cleanOutput(out) };
      })
      .finally(() => rmSync(dir, { recursive: true, force: true })),
  };
}

/** The names of the shortcuts on this Mac (`shortcuts list`). */
export async function listShortcuts(
  exec: Exec,
): Promise<{ ok: true; names: string[] } | { ok: false; error: string }> {
  const r = await exec(SHORTCUTS_BIN, ["list"], 15_000).done;
  if (r.code !== 0) return { ok: false, error: "AGENCY couldn't read the list of shortcuts on this Mac." };
  const names = r.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && l.length <= 100)
    .slice(0, 500);
  return { ok: true, names };
}
