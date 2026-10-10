/**
 * Developer installer: `npm run install-host`. Pairs and registers the native host for the browsers on
 * this Mac, pointing at this checkout's build. AGENCY.app does the same at first run with its own paths.
 */

import { resolve } from "node:path";
import { tokenFingerprint } from "../auth.ts";
import { EXTENSION_ID, ensurePairing, installNativeHost } from "./install.ts";

const config = ensurePairing();
const hostScript = resolve(process.argv[1] ?? "", "..", "host.cjs");
const { launcher, manifests } = installNativeHost({ configPath: config.configPath, hostScript, runtime: process.execPath });
const code = await tokenFingerprint(config.token);
console.log(`Native host launcher: ${launcher}`);
for (const m of manifests) console.log(`Host manifest:        ${m}`);
console.log(`Pairing file:         ${config.configPath}`);
console.log(`Pairing code:         ${code}`);
console.log(`Extension ID:         ${EXTENSION_ID}`);
console.log(`Next: chrome://extensions > Developer mode > Load unpacked > ${resolve(hostScript, "..", "extension")}`);
