/** Decorative stroke icons for the rail (same style as frontend/src/components/Icon.tsx). Text carries the meaning. */

const PATHS: Record<string, string> = {
  "overlay:help":
    "M12 8v5M12 16.5v.5M10.3 4.2L2.8 17.5A2 2 0 0 0 4.5 20.5h15a2 2 0 0 0 1.7-3L13.7 4.2a2 2 0 0 0-3.4 0z",
  "overlay:stop": "M6 6h12v12H6z",
  "overlay:home": "M3 11l9-7 9 7M5 10v10h5v-6h4v6h5V10",
  "overlay:keyboard": "M3 7h18v11H3zM7 11h.01M11 11h.01M15 11h.01M8 15h8",
  "overlay:more": "M5 12h.01M12 12h.01M19 12h.01",
  "overlay:pause": "M8 5v14M16 5v14",
  "overlay:resume": "M4 12a8 8 0 1 0 2.3-5.7M4 4v4h4",
};

export function RailIcon({ id, paused }: { id: string; paused: boolean }) {
  const d = PATHS[id === "overlay:pause" && paused ? "overlay:resume" : id];
  if (!d) return null;
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}
