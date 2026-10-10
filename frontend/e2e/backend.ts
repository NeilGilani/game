/** Starts and stops a real AGENCY coordinator (FastAPI + SQLite) for end-to-end tests. */
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const BACKEND = "http://127.0.0.1:8765";
const backendDir = resolve(import.meta.dirname, "..", "..", "backend");

export class Coordinator {
  private proc: ChildProcess | null = null;
  readonly dbPath: string;

  constructor() {
    this.dbPath = join(mkdtempSync(join(tmpdir(), "agency-e2e-")), "agency.db");
  }

  async start(): Promise<void> {
    this.proc = spawn(join(backendDir, ".venv", "bin", "uvicorn"), ["agency.main:app", "--host", "127.0.0.1", "--port", "8765"], {
      cwd: backendDir,
      env: {
        ...process.env,
        AGENCY_DB_PATH: this.dbPath,
        AGENCY_STEP_DELAY_MS: "120",
        AGENCY_REASONING: "deterministic",
        AGENCY_FRONTEND_DIST: "/nonexistent",
      },
      stdio: "ignore",
    });
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      try {
        const r = await fetch(`${BACKEND}/api/health`);
        if (r.ok) return;
      } catch {
        /* not up yet */
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error("coordinator did not start");
  }

  async stop(): Promise<void> {
    const p = this.proc;
    if (!p) return;
    await new Promise<void>((done) => {
      p.once("exit", () => done());
      p.kill("SIGTERM");
      setTimeout(() => {
        p.kill("SIGKILL");
        done();
      }, 5000);
    });
    this.proc = null;
  }

  async api<T>(path: string, init?: RequestInit): Promise<T> {
    const r = await fetch(`${BACKEND}${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    });
    if (!r.ok) throw new Error(`${path}: ${r.status}`);
    return (await r.json()) as T;
  }
}
