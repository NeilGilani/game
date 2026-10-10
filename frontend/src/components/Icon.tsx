/** A small, consistent stroke icon set (no external assets). Icons are decorative: the text next to them carries meaning. */

const PATHS: Record<string, string> = {
  check: "M5 12.5l4.5 4.5L19 7.5",
  x: "M6 6l12 12M18 6L6 18",
  clock: "M12 7v5l3 2M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z",
  hand: "M8 13V6.5a1.5 1.5 0 0 1 3 0V12m0-6.5v-1a1.5 1.5 0 0 1 3 0V12m0-5.5a1.5 1.5 0 0 1 3 0V14c0 4-2.5 7-6.5 7-3 0-4.5-1.5-6-4l-1.8-3a1.5 1.5 0 0 1 2.4-1.8L8 13",
  question: "M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6V14M12 17.5v.5M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z",
  alert:
    "M12 8v5M12 16.5v.5M10.3 4.2L2.8 17.5A2 2 0 0 0 4.5 20.5h15a2 2 0 0 0 1.7-3L13.7 4.2a2 2 0 0 0-3.4 0z",
  pause: "M8 5v14M16 5v14",
  play: "M7 5l12 7-12 7z",
  stop: "M6 6h12v12H6z",
  camera:
    "M3 8a2 2 0 0 1 2-2h2.5l1.5-2h6l1.5 2H19a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM12 10a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7z",
  eye: "M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z",
  home: "M3 11l9-7 9 7M5 10v10h5v-6h4v6h5V10",
  plus: "M12 5v14M5 12h14",
  list: "M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01",
  gear: "M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM19 12a7 7 0 0 0-.1-1.2l2-1.6-2-3.4-2.4.9a7 7 0 0 0-2-1.2L14 3h-4l-.5 2.5a7 7 0 0 0-2 1.2l-2.4-.9-2 3.4 2 1.6A7 7 0 0 0 5 12c0 .4 0 .8.1 1.2l-2 1.6 2 3.4 2.4-.9a7 7 0 0 0 2 1.2L10 21h4l.5-2.5a7 7 0 0 0 2-1.2l2.4.9 2-3.4-2-1.6c.1-.4.1-.8.1-1.2z",
  wrench:
    "M14.5 6.5a4 4 0 0 0 5 5L21 13l-8 8-3.5-3.5 8-8M14.5 6.5L17 4a4 4 0 0 0-5 5l-8.5 8.5a1.5 1.5 0 0 0 0 2.1l1.4 1.4a1.5 1.5 0 0 0 2.1 0L15.5 12",
  calendar:
    "M4 6.5A1.5 1.5 0 0 1 5.5 5h13A1.5 1.5 0 0 1 20 6.5v12a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18.5zM4 10h16M8 3v4M16 3v4",
  document: "M7 3h7l5 5v12a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zM14 3v5h5M9 13h6M9 17h6",
  message: "M4 5h16v11H9l-5 4z",
  resume: "M4 12a8 8 0 1 0 2.3-5.7M4 4v4h4",
  info: "M12 11v6M12 7.5v.5M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z",
  left: "M15 5l-7 7 7 7",
  right: "M9 5l7 7-7 7",
  shield: "M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z",
  chip: "M8 8h8v8H8zM5 9h3M5 15h3M16 9h3M16 15h3M9 5v3M15 5v3M9 16v3M15 16v3",
  laptop: "M5 6h14v9H5zM3 18h18",
  offline: "M3 3l18 18M8.5 16.5a5 5 0 0 1 7 0M5 12.5a10 10 0 0 1 4.5-2.4M19 12.5a10 10 0 0 0-3-2M12 20h.01",
  refresh: "M20 12a8 8 0 1 1-2.3-5.7M20 4v4h-4",
  sparkle:
    "M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z",
  target: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM12 11.5v1",
  skip: "M5 5l9 7-9 7zM18 5v14",
  timeline: "M6 4v16M6 7h12M6 12h9M6 17h11",
  key: "M15 7a4 4 0 1 1-3.9 5H3v3h3v2h3v-2h2.1A4 4 0 0 1 15 7zM16 10.5h.01",
  head: "M12 3a6 6 0 0 1 6 6c0 2-.6 3.2-1.5 4.3V21h-9v-7.7C6.6 12.2 6 11 6 9a6 6 0 0 1 6-6z",
  blink: "M3 12c2.5 3 5.5 4.5 9 4.5s6.5-1.5 9-4.5M6 15l-1.5 2M12 16.5V19M18 15l1.5 2",
  pointer: "M5 3l13 8-6 1.5L9 19z",
  edit: "M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4",
  back: "M19 12H5M11 6l-6 6 6 6",
};

export function Icon({
  name,
  size = 24,
  label,
}: {
  name: keyof typeof PATHS | string;
  size?: number;
  label?: string;
}) {
  const d = PATHS[name] ?? PATHS.info!;
  return (
    <svg
      className="ico"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={label ? undefined : true}
      role={label ? "img" : undefined}
      aria-label={label}
      focusable="false"
    >
      <path d={d} />
    </svg>
  );
}

export function BrandMark() {
  return (
    <svg className="brand-mark" viewBox="0 0 64 64" aria-hidden="true" focusable="false">
      <rect width="64" height="64" rx="16" fill="var(--accent)" />
      <path
        d="M15 46 L32 15 L49 46"
        fill="none"
        stroke="var(--accent-ink)"
        strokeWidth="7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="32" cy="37.5" r="5.5" fill="var(--focus)" />
    </svg>
  );
}
