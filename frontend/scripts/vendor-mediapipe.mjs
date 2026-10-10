// Copies MediaPipe's WebAssembly runtime from node_modules into public/ so the camera
// pipeline loads entirely from this machine (no CDN at runtime, works offline).
import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// npm workspaces hoist packages to the repository root, so look upward from frontend/.
function findSource() {
  for (let dir = root; ; dir = dirname(dir)) {
    const candidate = join(dir, "node_modules", "@mediapipe", "tasks-vision", "wasm");
    if (existsSync(candidate)) return candidate;
    if (dirname(dir) === dir) return join(root, "node_modules", "@mediapipe", "tasks-vision", "wasm");
  }
}
const source = findSource();
const target = join(root, "public", "mediapipe", "wasm");

if (!existsSync(source)) {
  console.error("MediaPipe is not installed. Run `npm install` at the repository root first.");
  process.exit(1);
}
mkdirSync(target, { recursive: true });
for (const file of readdirSync(source)) {
  copyFileSync(join(source, file), join(target, file));
}
const model = join(root, "public", "models", "face_landmarker.task");
if (!existsSync(model)) {
  console.warn("Warning: public/models/face_landmarker.task is missing. See README (Camera model).");
}
console.log(`MediaPipe runtime ready in public/mediapipe/wasm (${readdirSync(target).length} files).`);
