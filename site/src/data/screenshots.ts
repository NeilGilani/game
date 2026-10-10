// Where the screenshots came from (written by scripts/capture-screenshots.mjs). Shown next to each one.
import raw from "../assets/screenshots/manifest.json";

export interface ShotManifest {
  source: string;
  commit: string;
  captured: string;
  viewport: string;
  shots: { file: string; alt: string; theme: "light" | "dark" }[];
}

export const manifest = raw as ShotManifest;
