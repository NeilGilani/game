/**
 * Big video controls: the page's main video (the biggest one playing or on screen), its state for the shell, and
 * play/pause, 10 seconds back or forward, captions, and filling the view for AGENCY's big-screen mode.
 */

import type { VideoState } from "@agency/contracts";
import { isVisible } from "../../../browser-bridge/src/extension/page/dom.ts";

const MIN_AREA = 160 * 90;

export function primaryVideo(): HTMLVideoElement | null {
  let best: { v: HTMLVideoElement; score: number } | null = null;
  for (const v of document.querySelectorAll("video")) {
    const r = v.getBoundingClientRect();
    const a = r.width * r.height;
    if (a < MIN_AREA || !isVisible(v)) continue;
    const score = a * (v.paused ? 1 : 4);
    if (!best || score > best.score) best = { v, score };
  }
  return best?.v ?? null;
}

function youtubeCaptions(): HTMLElement | null {
  return document.querySelector<HTMLElement>(".ytp-subtitles-button");
}

function captionsOf(v: HTMLVideoElement): VideoState["captions"] {
  const yt = youtubeCaptions();
  if (yt && isVisible(yt)) return yt.getAttribute("aria-pressed") === "true" ? "on" : "off";
  const tracks = [...v.textTracks].filter((t) => t.kind === "subtitles" || t.kind === "captions");
  if (!tracks.length) return null;
  return tracks.some((t) => t.mode === "showing") ? "on" : "off";
}

export function videoState(): VideoState | null {
  const v = primaryVideo();
  if (!v) return null;
  return {
    playing: !v.paused && !v.ended,
    time: Number.isFinite(v.currentTime) ? Math.round(v.currentTime) : 0,
    duration: Number.isFinite(v.duration) ? Math.round(v.duration) : 0,
    captions: captionsOf(v),
  };
}

/** Where the video is, for a real click on it when the page won't play without one. */
export function videoCenter(): { x: number; y: number } | null {
  const v = primaryVideo();
  if (!v) return null;
  const r = v.getBoundingClientRect();
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
}

/** Play or pause. "blocked": the page needs a real click before it plays (main sends one). */
export async function playPause(): Promise<"playing" | "paused" | "blocked" | "none"> {
  const v = primaryVideo();
  if (!v) return "none";
  if (!v.paused && !v.ended) {
    v.pause();
    return "paused";
  }
  try {
    await v.play();
    return "playing";
  } catch {
    return "blocked";
  }
}

export function seek(seconds: number): void {
  const v = primaryVideo();
  if (!v) return;
  const end = Number.isFinite(v.duration) ? v.duration : Infinity;
  v.currentTime = Math.max(0, Math.min(end, v.currentTime + seconds));
}

export function toggleCaptions(): void {
  const yt = youtubeCaptions();
  if (yt && isVisible(yt)) {
    yt.click();
    return;
  }
  const v = primaryVideo();
  if (!v) return;
  const tracks = [...v.textTracks].filter((t) => t.kind === "subtitles" || t.kind === "captions");
  const on = tracks.some((t) => t.mode === "showing");
  tracks.forEach((t, i) => (t.mode = on ? "hidden" : i === 0 ? "showing" : "hidden"));
}

let filled: { v: HTMLVideoElement; style: string } | null = null;

const FILL =
  "position:fixed !important;inset:0 !important;width:100vw !important;height:100vh !important;" +
  "max-width:none !important;max-height:none !important;z-index:2147483646 !important;" +
  "background:#000 !important;object-fit:contain !important;margin:0 !important;transform:none !important;";

/** Big screen: the video fills the page view (the shell hides its own controls around it). */
export function fillView(on: boolean): void {
  if (!on) {
    if (filled?.v.isConnected) filled.v.setAttribute("style", filled.style);
    filled = null;
    return;
  }
  const v = primaryVideo();
  if (!v || filled?.v === v) return;
  if (filled) fillView(false);
  filled = { v, style: v.getAttribute("style") ?? "" };
  v.setAttribute("style", `${filled.style};${FILL}`);
}

/** Report the main video's state when it changes (play, pause, seek, captions), at most twice a second. */
export function watchVideo(report: (state: VideoState | null) => void): void {
  let last = "";
  let timer = 0;
  const check = () => {
    timer = 0;
    const s = videoState();
    const key = JSON.stringify(s && { ...s, time: Math.floor(s.time / 5) });
    if (key === last) return;
    last = key;
    report(s);
  };
  const soon = () => {
    if (!timer) timer = window.setTimeout(check, 500);
  };
  for (const type of ["play", "pause", "ended", "loadedmetadata", "emptied", "seeked", "durationchange"])
    addEventListener(type, soon, true);
  addEventListener("load", soon);
  // Videos added later (players build themselves after load) and caption buttons changing.
  window.setInterval(soon, 2500);
}
