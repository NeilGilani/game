/**
 * Browser benchmark page: the real WebcamProvider (MediaPipe Face Landmarker) and GazeEngine,
 * run for a while, measuring frames per second, landmark detection time, engine time per
 * frame and camera-to-event latency. Used by e2e/engine.spec.ts with Chromium's fake camera.
 * Query: ?delegate=GPU|CPU&seconds=10&fps=30
 */

import { GazeEngine } from "../../src/engine";
import { mediapipeLandmarker } from "../../src/providers/mediapipe";
import { WebcamProvider } from "../../src/providers/webcam";
import { singleDisplay } from "../../src/screen";

const q = new URLSearchParams(location.search);
const delegate = (q.get("delegate") as "GPU" | "CPU" | null) ?? undefined;
const seconds = Number(q.get("seconds") ?? 10);
const targetFps = Number(q.get("fps") ?? 30);
const status = document.getElementById("status")!;

declare global {
  interface Window {
    __bench?: unknown;
  }
}

async function main() {
  const engine = new GazeEngine({ screen: singleDisplay(1470, 956), clock: () => performance.now() });
  const camera = new WebcamProvider(mediapipeLandmarker("/", delegate));
  camera.setTargetFps(targetFps);
  let faces = 0;
  let frames = 0;
  let blinkEvents = 0;
  const engineMs: number[] = [];
  const latency: number[] = [];
  engine.onDetail((d) => {
    frames++;
    if (d.face) faces++;
    if (d.latencyMs !== null) latency.push(d.latencyMs);
  });
  engine.on((e) => {
    if (e.type === "blink") blinkEvents++;
  });
  const t0 = performance.now();
  await engine.attach({
    id: camera.id,
    kind: camera.kind,
    start: (onFrame) =>
      camera.start((f) => {
        const a = performance.now();
        onFrame(f);
        engineMs.push(performance.now() - a);
      }),
    stop: () => camera.stop(),
    setTargetFps: (fps) => camera.setTargetFps(Math.min(fps, targetFps)),
    stats: () => camera.stats(),
  });
  if (camera.status !== "running") {
    window.__bench = { error: camera.error ?? camera.status };
    status.textContent = `Error: ${camera.error}`;
    return;
  }
  const loadMs = performance.now() - t0;
  status.textContent = "Running";
  // Warm up (first frames include shader compilation), then measure.
  await new Promise((r) => setTimeout(r, 2000));
  frames = 0;
  faces = 0;
  engineMs.length = 0;
  latency.length = 0;
  const detect: number[] = [];
  const perFrameDetect: number[] = [];
  const cameraFps: number[] = [];
  const sampler = setInterval(() => {
    const st = camera.stats();
    if (st.detectMs !== null) perFrameDetect.push(st.detectMs);
    if (st.cameraFps !== undefined) cameraFps.push(st.cameraFps);
  }, 100);
  const start = performance.now();
  const timer = setInterval(() => {
    const d = camera.stats().detectMs;
    if (d !== null) detect.push(d);
  }, 500);
  await new Promise((r) => setTimeout(r, seconds * 1000));
  clearInterval(timer);
  clearInterval(sampler);
  const elapsed = (performance.now() - start) / 1000;
  const pct = (v: number[], p: number) => {
    const s = [...v].sort((a, b) => a - b);
    return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))]! : null;
  };
  window.__bench = {
    delegate: camera.stats().delegate,
    loadMs,
    seconds: elapsed,
    fps: frames / elapsed,
    faceFraction: frames ? faces / frames : 0,
    detectMsMean: detect.length ? detect.reduce((a, b) => a + b, 0) / detect.length : null,
    detectMsP50: pct(perFrameDetect, 0.5),
    cameraFpsP50: pct(cameraFps, 0.5),
    webgl: webglRenderer(),
    engineMsP50: pct(engineMs, 0.5),
    engineMsP95: pct(engineMs, 0.95),
    latencyMsP50: pct(latency, 0.5),
    latencyMsP95: pct(latency, 0.95),
    latencySamples: latency.length,
    blinkEvents,
    video: { width: camera.video.videoWidth, height: camera.video.videoHeight },
    userAgent: navigator.userAgent,
  };
  status.textContent = "Done";
  camera.stop();
}

/** Which GPU (or software renderer) WebGL uses here: tells a real GPU from SwiftShader. */
function webglRenderer(): string | null {
  try {
    const gl = document.createElement("canvas").getContext("webgl2");
    if (!gl) return null;
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    return String(gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER));
  } catch {
    return null;
  }
}

main().catch((err) => {
  window.__bench = { error: String(err) };
});
