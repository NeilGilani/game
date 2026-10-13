/** Entry point of AGENCY.app's main process. */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { app, protocol } from "electron";
import { AgencyApp } from "./app";
import { applyAiDefaults } from "./ai";
import { applyDotenv } from "./dotenv";
import { resolvePaths } from "./paths";
import { SCHEME } from "./protocol";

// Must run before "ready".
protocol.registerSchemesAsPrivileged([
  {
    scheme: SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, codeCache: true },
  },
]);

app.setName("AGENCY");
// ~/Library/Application Support/AGENCY (tests use their own directory).
const userData = process.env.AGENCY_USER_DATA || join(app.getPath("appData"), "AGENCY");
app.setPath("userData", userData);
app.setPath("sessionData", join(userData, "session"));
const logDir = process.env.AGENCY_USER_DATA
  ? join(userData, "logs")
  : join(app.getPath("home"), "Library", "Logs", "AGENCY");

const test = process.env.AGENCY_TEST === "1";
// Tests never save AGENCY Browser's downloads into the real Downloads folder.
if (test) app.setPath("downloads", join(userData, "Downloads"));
applyAiDefaults(process.env, test);

// Development (`make os-dev`): the repository's .env, so the agent gets the same Gemini key as the coordinator.
if (!app.isPackaged && !test) {
  const dotenv = resolve(app.getAppPath(), "..", "..", ".env");
  if (existsSync(dotenv)) applyDotenv(readFileSync(dotenv, "utf8"), process.env);
}
if (!test && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  let agency: AgencyApp | null = null;

  // Opening AGENCY again brings its window back, even if the person had closed it.
  app.on("second-instance", () => agency?.showShell());

  app.whenReady().then(async () => {
    const paths = resolvePaths({
      packaged: app.isPackaged,
      appDir: app.getAppPath(),
      resourcesDir: process.resourcesPath,
      execPath: process.execPath,
    });
    agency = new AgencyApp({
      paths,
      userData,
      logDir,
      windowed: process.env.AGENCY_WINDOWED === "1" || test,
      test,
      skipOnboarding: process.env.AGENCY_SKIP_ONBOARDING === "1",
      shellDevUrl: process.env.AGENCY_SHELL_URL || null,
      coordinatorUrl: process.env.AGENCY_COORDINATOR_URL || null,
      coordinatorToken: process.env.AGENCY_COORDINATOR_TOKEN || null,
    });
    if (test) (globalThis as { __agency?: AgencyApp }).__agency = agency;
    await agency.start();
  });

  // AGENCY is the person's home: closing every window doesn't quit it (Cmd-Q or the menu does).
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  let quitting = false;
  app.on("before-quit", (event) => {
    if (quitting || !agency) return;
    event.preventDefault();
    quitting = true;
    void agency.shutdown().finally(() => app.quit());
  });
}
