// Packages AGENCY.app into a .dmg with electron-builder.
//   node scripts/dist.mjs [--arch arm64|x64|universal] [--dir]
// Signs and notarizes only when the secrets exist:
//   CSC_LINK + CSC_KEY_PASSWORD                         Developer ID Application certificate (.p12, base64 or path)
//   APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID   notarization
// Without them the app is ad-hoc signed, without hardened runtime, and the docs explain the Gatekeeper steps.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Arch, Platform, build } from "electron-builder";

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repo = resolve(desktop, "..", "..");
const argv = process.argv.slice(2);
const archArg = argv.includes("--arch") ? argv[argv.indexOf("--arch") + 1] : process.arch;
const dirOnly = argv.includes("--dir");
const pkg = JSON.parse(readFileSync(join(desktop, "package.json"), "utf8"));

const signing = Boolean(process.env.CSC_LINK);
const notarizing =
  signing && ["APPLE_ID", "APPLE_APP_SPECIFIC_PASSWORD", "APPLE_TEAM_ID"].every((k) => process.env[k]);

// Other packages are optional: include what has been built, and say what is missing.
const optional = [
  { from: join(repo, "frontend", "dist"), to: "shell", what: "interface (frontend)", required: true },
  { from: join(repo, "os", "overlay", "dist"), to: "overlay", what: "overlay (os/overlay)" },
  { from: join(repo, "os", "gaze", "dist"), to: "gaze", what: "gaze engine (os/gaze)" },
  { from: join(repo, "os", "agent", "dist"), to: "agent", what: "agent (os/agent)" },
  { from: join(repo, "os", "browser-bridge", "dist"), to: "bridge", what: "AGENCY Bridge host (os/browser-bridge)" },
  {
    from: join(repo, "os", "sidecar", "dist", "agency-coordinator"),
    to: "sidecar/agency-coordinator",
    what: "coordinator sidecar (make sidecar)",
    required: true,
  },
];
const extraResources = [];
for (const o of optional) {
  if (existsSync(o.from)) extraResources.push({ from: o.from, to: o.to });
  else if (o.required) throw new Error(`Missing ${o.what}: ${o.from}`);
  else console.warn(`Not included (not built): ${o.what}; the app uses its built-in fallback.`);
}

const nativeCandidates = [
  process.env.AGENCY_NATIVE_PATH,
  join(repo, "os", "native-macos", ".build", "apple", "Products", "Release", "agency-native"),
  join(repo, "os", "native-macos", ".build", "release", "agency-native"),
].filter(Boolean);
const nativeBin = nativeCandidates.find((p) => existsSync(p));
const extraFiles = nativeBin ? [{ from: nativeBin, to: "MacOS/agency-native" }] : [];
if (!nativeBin)
  console.warn(
    "Not included (not built): agency-native (os/native-macos); eye control works inside AGENCY only.",
  );

/** @type {import("electron-builder").Configuration} */
const config = {
  appId: "io.github.neilgilani.agency",
  productName: "AGENCY",
  copyright: "AGENCY contributors",
  directories: { output: "dist", buildResources: "build" },
  files: ["out/**/*", "fakes/**/*", "package.json", "!out/**/*.map"],
  asar: true,
  extraResources,
  extraFiles,
  extraMetadata: { main: "out/main/index.cjs" },
  mac: {
    category: "public.app-category.productivity",
    icon: "build/icon.icns",
    minimumSystemVersion: "13.0",
    target: [{ target: dirOnly ? "dir" : "dmg", arch: [archArg] }],
    identity: signing ? undefined : "-",
    hardenedRuntime: signing,
    gatekeeperAssess: false,
    entitlements: "build/entitlements.mac.plist",
    entitlementsInherit: "build/entitlements.mac.inherit.plist",
    notarize: notarizing,
    extendInfo: {
      NSCameraUsageDescription:
        "AGENCY uses the camera to follow your eyes. The picture stays on this Mac and is never saved or sent.",
      NSMicrophoneUsageDescription:
        "AGENCY uses the microphone during calls so you can hear and answer the other person.",
      NSSpeechRecognitionUsageDescription:
        "AGENCY turns what the other person says on a call into words on your screen, on this Mac.",
      NSAppleEventsUsageDescription:
        "AGENCY uses Messages to send the texts you approve, to your saved people, from your own number.",
      NSCalendarsFullAccessUsageDescription:
        "AGENCY shows today's Calendar events in My day. It only reads them, on this Mac, and never saves or sends them.",
      NSCalendarsUsageDescription:
        "AGENCY shows today's Calendar events in My day. It only reads them, on this Mac, and never saves or sends them.",
      LSApplicationCategoryType: "public.app-category.productivity",
    },
  },
  dmg: {
    title: "AGENCY ${version}",
    icon: "build/icon.icns",
    // background.png plus background@2x.png (Retina) from build/, made by scripts/make-assets.mjs.
    background: "build/background.png",
    window: { width: 660, height: 420 },
    iconSize: 112,
    contents: [
      { x: 170, y: 210, type: "file" },
      { x: 490, y: 210, type: "link", path: "/Applications" },
    ],
    artifactName: "AGENCY-${version}-${arch}.dmg",
  },
  publish: null,
};

console.log(
  `Packaging AGENCY ${pkg.version} for ${archArg}: ${signing ? "signed" : "ad-hoc signed (unsigned)"}, ${notarizing ? "notarized" : "not notarized"}`,
);
const arch = { arm64: Arch.arm64, x64: Arch.x64, universal: Arch.universal }[archArg];
if (arch === undefined) throw new Error(`Unknown arch ${archArg}`);
await build({
  targets: Platform.MAC.createTarget(dirOnly ? "dir" : "dmg", arch),
  config,
  projectDir: desktop,
});
