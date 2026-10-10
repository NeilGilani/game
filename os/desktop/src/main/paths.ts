/**
 * Where everything lives, in development (the repository) and in the packaged app (Contents/Resources).
 * Environment overrides exist for tests and for pointing at a work-in-progress package.
 */

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { HOST_ENTRIES } from "@agency/contracts";

export interface Paths {
  packaged: boolean;
  /** os/desktop in development, app.asar in production. */
  appDir: string;
  repoDir: string | null;
  resourcesDir: string;
  preload: string;
  /** Built-in pages: fallback overlay, onboarding, gaze placeholder. */
  hostRenderer: string;
  shellDir: string | null;
  /** `entry` is the page path inside `dir`, served as agency://overlay/<entry>. */
  overlayDir: { dir: string; entry: string; builtin: boolean };
  /** `entry` is the engine page inside `dir`, served as agency://gaze/<entry>. */
  gazeDir: { dir: string; entry: string };
  agent: { entry: string; fake: boolean } | null;
  native: { command: string; args: string[]; fake: boolean } | null;
  sidecar: { command: string; args: string[]; cwd: string } | null;
}

const env = (name: string): string | undefined => process.env[name] || undefined;

function firstExisting(...candidates: (string | null | undefined)[]): string | null {
  for (const c of candidates) if (c && existsSync(c)) return c;
  return null;
}

export function resolvePaths(opts: {
  packaged: boolean;
  appDir: string;
  resourcesDir: string;
  execPath: string;
}): Paths {
  const { packaged, appDir, resourcesDir } = opts;
  const repoDir = packaged ? null : resolve(appDir, "..", "..");
  const repo = (p: string) => (repoDir ? join(repoDir, p) : null);
  const res = (p: string) => join(resourcesDir, p);
  const out = join(appDir, "out");
  const allowFakes = !packaged || env("AGENCY_ALLOW_FAKES") === "1";

  const shellIndex = firstExisting(
    env("AGENCY_SHELL_DIR") && join(env("AGENCY_SHELL_DIR")!, "index.html"),
    packaged ? res("shell/index.html") : repo(HOST_ENTRIES.shell),
  );

  const overlayIndex = firstExisting(
    env("AGENCY_OVERLAY_DIR") && join(env("AGENCY_OVERLAY_DIR")!, "index.html"),
    packaged ? res("overlay/index.html") : repo(HOST_ENTRIES.overlay),
  );

  const gazeIndex = firstExisting(
    env("AGENCY_GAZE_DIR") && join(env("AGENCY_GAZE_DIR")!, "engine.html"),
    packaged ? res("gaze/engine.html") : repo(HOST_ENTRIES.gaze),
  );

  let agent: Paths["agent"] = null;
  const agentEntry = firstExisting(
    env("AGENCY_AGENT_ENTRY"),
    packaged ? res("agent/agent-utility.mjs") : repo(HOST_ENTRIES.agent),
  );
  if (agentEntry) agent = { entry: agentEntry, fake: agentEntry.includes("fake-agent") };
  else if (allowFakes && env("AGENCY_NO_FAKES") !== "1")
    agent = { entry: join(appDir, "fakes", "fake-agent.cjs"), fake: true };

  let native: Paths["native"] = null;
  const nativeBin = firstExisting(
    env("AGENCY_NATIVE_PATH"),
    packaged ? join(resourcesDir, "..", "MacOS", "agency-native") : repo(HOST_ENTRIES.native),
  );
  if (nativeBin && nativeBin.endsWith(".cjs"))
    native = { command: opts.execPath, args: [nativeBin], fake: true };
  else if (nativeBin) native = { command: nativeBin, args: [], fake: false };
  else if (allowFakes && env("AGENCY_NO_FAKES") !== "1")
    native = { command: opts.execPath, args: [join(appDir, "fakes", "fake-native.cjs")], fake: true };

  let sidecar: Paths["sidecar"] = null;
  if (packaged) {
    const bin = res("sidecar/agency-coordinator/agency-coordinator");
    if (existsSync(bin)) sidecar = { command: bin, args: [], cwd: res("sidecar") };
  } else if (repoDir) {
    const py = firstExisting(env("AGENCY_PYTHON"), join(repoDir, "backend", ".venv", "bin", "python"));
    if (py) sidecar = { command: py, args: ["-m", "agency"], cwd: join(repoDir, "backend") };
  }

  return {
    packaged,
    appDir,
    repoDir,
    resourcesDir,
    preload: join(out, "preload", "index.cjs"),
    hostRenderer: join(out, "renderer"),
    shellDir: shellIndex ? resolve(shellIndex, "..") : null,
    overlayDir: overlayIndex
      ? { dir: resolve(overlayIndex, ".."), entry: "index.html", builtin: false }
      : { dir: join(out, "renderer"), entry: "overlay/index.html", builtin: true },
    // A package-built engine page wins; otherwise the built-in page that hosts @agency/gaze.
    gazeDir: gazeIndex
      ? { dir: resolve(gazeIndex, ".."), entry: "engine.html" }
      : { dir: join(out, "renderer"), entry: "gaze/engine.html" },
    agent,
    native,
    sidecar,
  };
}
