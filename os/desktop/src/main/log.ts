/** Small file logger: one file per process name, rotated at 2 MB, never logs secrets or gaze samples. */

import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";

const MAX_BYTES = 2 * 1024 * 1024;

export type LogLevel = "info" | "warn" | "error";

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  /** Raw output lines from a child process. */
  raw(line: string): void;
}

let logDir: string | null = null;

export function setLogDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
  logDir = dir;
}

function write(name: string, line: string): void {
  if (!logDir) return;
  const file = join(logDir, `${name}.log`);
  try {
    if (existsSync(file) && statSync(file).size > MAX_BYTES) renameSync(file, `${file}.1`);
    appendFileSync(file, line + "\n");
  } catch {
    // Logging must never break the app.
  }
}

export function createLogger(name: string, echo = process.env.AGENCY_LOG_ECHO !== "0"): Logger {
  const emit = (level: LogLevel, message: string) => {
    const line = `${new Date().toISOString()} ${level.toUpperCase()} [${name}] ${message}`;
    write(name, line);
    if (echo) (level === "error" ? console.error : console.log)(line);
  };
  return {
    info: (m) => emit("info", m),
    warn: (m) => emit("warn", m),
    error: (m) => emit("error", m),
    raw: (line) => write(name, line),
  };
}
