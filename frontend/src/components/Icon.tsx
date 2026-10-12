/** Original AGENCY artwork. Text labels carry meaning; the sculpture is decorative.
 * Gradients live in each SVG with unique IDs. No raster downloads, fonts or filters. */
import { useId } from "react";

const paths: Record<string, string> = {
  check: "M5 12.5 9.5 17 19 7",
  food: "M5 3v6m3-6v6M3 3v5c0 3 7 3 7 0V3M6.5 11v10M18 3c-4 3-4 8 0 9h2V3h-2Zm2 9v9",
  bag: "M5 8h14l1 13H4L5 8Zm3 0V6a4 4 0 0 1 8 0v2",
  globe: "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM3 12h18M12 3c5 5 5 13 0 18-5-5-5-13 0-18Z",
  grid: "M3 3h7v7H3V3Zm11 0h7v7h-7V3ZM3 14h7v7H3v-7Zm11 0h7v7h-7v-7Z",
  speak: "M4 4h14a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-8l-5 4v-4H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Zm3 5h8m-8 4h5",
  x: "m5 5 14 14M19 5 5 19",
  clock: "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM12 6v6l4 2",
  hand: "M7 12V5a2 2 0 0 1 4 0v7-8a2 2 0 0 1 4 0v8-6a2 2 0 0 1 4 0v8-3a2 2 0 0 1 4 0v4c0 9-10 10-14 5l-6-7c-1-2 2-4 4-1l2 2",
  question: "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM9 8c0-4 7-4 6 0-.5 2-3 2-3 5m0 4h.01",
  alert: "m12 3 10 18H2L12 3Zm0 6v5m0 3h.01",
  pause: "M7 4v16M17 4v16",
  play: "m7 3 14 9-14 9V3Z",
  stop: "M5 5h14v14H5V5Z",
  camera: "M3 7h5l2-3h5l2 3h4v13H3V7Zm13 6a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z",
  eye: "M2 12C7 2 17 2 22 12 17 22 7 22 2 12Zm14 0a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z",
  home: "m2 11 10-8 10 8M5 9v12h14V9M9 21v-8h6v8",
  plus: "M12 3v18M3 12h18",
  list: "M8 5h13M8 12h13M8 19h13M3 5h.1M3 12h.1M3 19h.1",
  gear: "m9 3 1-2h4l1 2 3 2 2-.3 2 3-1.3 2v4l1.3 2-2 3-2-.3-3 2-1 2h-4l-1-2-3-2-2 .3-2-3 1.3-2v-4L2 8l2-3 2 .3L9 3Zm7 9a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z",
  wrench: "M14 3a6 6 0 0 0-6 8L2 17a3 3 0 0 0 5 5l7-7a6 6 0 0 0 8-6l-5 3-4-4 3-5h-2Z",
  calendar: "M3 6h18v15H3V6Zm4-4v7m10-7v7M3 11h18m-14 4h3m4 0h3m-10 3h3",
  document: "M5 2h9l5 5v15H5V2Zm9 0v6h5M9 12h6m-6 4h6",
  message: "M12 3c-12 0-12 15-3 17l-5 2 1-6C-1 2 18-2 21 9c2 8-4 12-9 12M7 10h10M7 14h6",
  resume: "M3 9a9 9 0 1 1 0 7M3 3v6h6m3-3v6l4 2",
  info: "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM12 11v6m0-10h.01",
  left: "m15 4-8 8 8 8",
  right: "m9 4 8 8-8 8",
  shield: "m12 2 9 4v7c0 5-6 8-9 9-3-1-9-4-9-9V6l9-4Zm-4 10 3 3 5-6",
  chip: "M6 6h12v12H6V6Zm3 3h6v6H9V9ZM9 2v4m6-4v4M9 18v4m6-4v4M2 9h4m-4 6h4m12-6h4m-4 6h4",
  laptop: "M4 3h16v13H4V3ZM2 16h20v4H2v-4Z",
  offline: "M2 8c5-5 15-5 20 0M6 12c3-3 9-3 12 0m-7 6h2M3 3l18 18",
  refresh: "M3 9a9 9 0 0 1 16-5l2 3m0-5v5h-5M21 15A9 9 0 0 1 5 20l-2-3m0 5v-5h5",
  sparkle: "m12 2 3 7 7 3-7 3-3 7-3-7-7-3 7-3 3-7Zm8 0v4m-2-2h4",
  target: "M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0Zm-5 0a5 5 0 1 1-10 0 5 5 0 0 1 10 0Zm-5 0h.01",
  skip: "m3 4 13 8-13 8V4ZM20 4v16",
  timeline: "M3 4h18M3 12h18M3 20h18M7 2v4m8 4v4m-4 4v4",
  keyboard: "M2 5h20v14H2V5ZM6 9h.1m4 0h.1m4 0h.1m4 0h.1M6 13h.1m4 0h.1m4 0h.1m4 0h.1M7 16h10",
  head: "M7 3H3v4m14-4h4v4M3 17v4h4m14-4v4h-4M8 9h.1m7 0h.1M9 15c2 2 4 2 6 0",
  blink: "M2 9c5 8 15 8 20 0M5 13l-2 4m6-2-1 4m7-4 1 4m3-6 2 4",
  pointer: "m4 2 16 12-8 1-4 7L4 2Z",
  edit: "m3 17 13-13 4 4L7 21H3v-4Zm10-10 4 4",
  back: "M21 12H3m7-7-7 7 7 7",
  bell: "M7 18H3l3-4V8a6 6 0 0 1 12 0v6l3 4H7Zm2 3h6",
  mute: "M3 3l18 18M6 9v5l-3 4h14M11 2a6 6 0 0 1 7 6v4m-9 9h6",
  down: "m4 8 8 8 8-8",
  lifeline: "M12 21C-5 11 4-3 12 6 20-3 29 11 12 21ZM4 12h4l2-4 4 8 2-4h4",
  phone: "m4 3 4-1 3 6-4 3c1 3 3 5 6 6l3-4 6 3-1 4c-1 5-9 2-14-3S0 4 4 3Z",
  watch: "M20 12a8 8 0 1 1-16 0 8 8 0 0 1 16 0Zm-8-5v5l3 2M6 2 2 6m16-4 4 4M6 19l-2 3m14-3 2 3",
  name: "M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0ZM3 22v-3c0-9 18-9 18 0v3H3Z",
  badge: "m12 2 3 2 4 1 1 4 2 3-2 3-1 4-4 1-3 2-3-2-4-1-1-4-2-3 2-3 1-4 4-1 3-2Zm0 5v6m0 4h.01",
  music: "M10 17V4l11-2v13M10 8l11-2M10 17c0 6-8 6-8 2 0-3 5-4 8-2Zm11-2c0 6-8 6-8 2 0-3 5-4 8-2Z",
  tv: "M2 7h20v15H2V7Zm6-6 4 6 4-6m-6 11 6 3-6 3v-6Z",
  news: "M5 3h17v19H4c-2 0-2-4-2-6V8h3V3Zm3 4h5v5H8V7Zm8 0h3m-3 4h3M8 16h11m-11 3h11",
  weather:
    "M13 5V2m5 5 2-2M9 7 7 5m14 7h2M17 12a5 5 0 0 0-9-3M7 21c-8 0-8-9-2-9 2-7 12-5 12 2 7 0 6 7 0 7H7Z",
  book: "M12 5C8 2 4 2 2 3v17c4-2 7-1 10 1 3-2 6-3 10-1V3c-2-1-6-1-10 2Zm0 0v16",
  mail: "M2 4h20v16H2V4Zm0 0 10 9L22 4",
  photo: "M2 3h20v18H2V3Zm0 15 6-7 5 5 3-3 6 6M17 7h.01",
};
// AGENCY Browser's controls.
Object.assign(paths, {
  up: "m4 16 8-8 8 8",
  "page-up": "m6 12 6-6 6 6M6 19l6-6 6 6",
  "page-down": "m6 5 6 6 6-6M6 12l6 6 6-6",
  lock: "M6 11h12v10H6V11Zm3 0V8a3 3 0 0 1 6 0v3",
  star: "m12 2 3 7 7 .6-5.4 4.6L18.2 21 12 17.3 5.8 21l1.6-6.8L2 9.6 9 9l3-7Z",
  tabs: "M3 8h13v13H3V8Zm4-4h14v13",
  search: "m16 16 6 6M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z",
  "zoom-in": "m16 16 6 6M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0ZM10 6v8M6 10h8",
  "zoom-out": "m16 16 6 6M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0ZM6 10h8",
  captions: "M2 5h20v14H2V5Zm8 5.5a2.5 2.5 0 1 0 0 3m8-3a2.5 2.5 0 1 0 0 3",
  expand: "M3 9V3h6m12 6V3h-6M3 15v6h6m12-6v6h-6",
  popup: "M3 3h18v18H3V3Zm10 4 4 4m0-4-4 4",
  volume: "M3 9h4l5-5v16l-5-5H3V9Zm13-1a5 5 0 0 1 0 8m3-11a9 9 0 0 1 0 14",
  more: "M5 12h.1M12 12h.1M19 12h.1",
  labels: "M3 4h9v7H3V4Zm9 9h9v7h-9v-7ZM6 7.5h3m6 9h3",
});
paths.key = paths.keyboard!;
paths.voice = "M3 10v4m4-7v10m5-15v20m5-16v12m4-8v4";

const palettes: Record<string, [string, string, string]> = {
  voice: ["#c4dfff", "#6b9ada", "#3a4c94"],
  speak: ["#8af1dd", "#188b90", "#053d55"],
  message: ["#a3f5b3", "#31a164", "#09574f"],
  phone: ["#b4f3c6", "#42ad7a", "#10616e"],
  food: ["#ffd5a4", "#e88856", "#a44055"],
  bag: ["#eed3ff", "#a678da", "#5141a0"],
  globe: ["#a1eaff", "#468edc", "#263fa0"],
  play: ["#ffb9d5", "#d8578e", "#84295f"],
  document: ["#c6e8ff", "#6d9fd3", "#3b527f"],
  grid: ["#d7d0ff", "#817de0", "#45429b"],
  gear: ["#e2e8f3", "#8393ae", "#39445e"],
  wrench: ["#e1d7ff", "#9987ce", "#565386"],
  lifeline: ["#ffb6c5", "#df5a73", "#952744"],
  eye: ["#b6f1ff", "#51b5ce", "#27607d"],
  home: ["#c9e9ff", "#579ce5", "#304aa0"],
  keyboard: ["#e3e9f6", "#98a5bd", "#47536d"],
  name: ["#eedaff", "#ae89df", "#615095"],
  shield: ["#baedec", "#4fa3a7", "#2b5e80"],
};

function Glyph({ name }: { name: string }) {
  return <path d={paths[name] ?? paths.info} />;
}

/** Feature-specific sculpture silhouettes, rendered in the same lighting environment. */
function Sculpture({
  name,
  metal,
  sphere,
  light,
  dark,
}: {
  name: string;
  metal: string;
  sphere: string;
  light: string;
  dark: string;
}) {
  if (name === "globe")
    return (
      <>
        <circle cx="49" cy="50" r="27" fill={dark} opacity=".3" />
        <circle cx="47" cy="45" r="27" fill={sphere} stroke={light} strokeWidth="1" />
        <ellipse cx="47" cy="45" rx="12" ry="27" stroke="white" strokeWidth="2" strokeOpacity=".85" />
        <ellipse cx="47" cy="45" rx="26" ry="10" stroke="white" strokeWidth="2" strokeOpacity=".85" />
        <path
          d="M24 32c8-11 22-14 32-9"
          stroke="white"
          strokeWidth="3"
          strokeOpacity=".65"
          strokeLinecap="round"
        />
      </>
    );
  if (name === "bag")
    return (
      <>
        <path d="M28 37h41l4 38H24l4-38Z" fill={dark} opacity=".35" />
        <path d="M25 33h41l4 37H21l4-37Z" fill={metal} stroke="white" strokeOpacity=".6" />
        <path
          d="M34 37V29c0-15 22-15 22 0v8"
          stroke={dark}
          strokeWidth="6"
          strokeLinecap="round"
          opacity=".2"
        />
        <path d="M34 34V26c0-15 22-15 22 0v8" stroke={metal} strokeWidth="5" strokeLinecap="round" />
        <path d="M28 40h32l2 22H26l2-22Z" fill={light} opacity=".25" />
      </>
    );
  if (name === "food")
    return (
      <>
        <ellipse cx="48" cy="51" rx="23" ry="25" fill={dark} opacity=".35" />
        <circle cx="47" cy="45" r="24" fill={metal} stroke="white" />
        <circle cx="47" cy="45" r="17" stroke={light} strokeWidth="2" />
        <path
          d="M21 26v14m-5-14v13c0 6 10 6 10 0V26M21 44v24M75 25c-8 8-8 17 0 19v24m0-43v19"
          stroke={dark}
          strokeWidth="4"
          strokeLinecap="round"
          opacity=".3"
        />
        <path
          d="M19 23v14m-5-14v13c0 6 10 6 10 0V23M19 41v24M73 22c-8 8-8 17 0 19v24m0-43v19"
          stroke={metal}
          strokeWidth="3.5"
          strokeLinecap="round"
        />
      </>
    );
  if (name === "eye")
    return (
      <>
        <path d="M17 49c16-27 46-27 62 0-16 27-46 27-62 0Z" fill={dark} opacity=".3" />
        <path d="M16 45c16-27 46-27 62 0-16 27-46 27-62 0Z" fill={metal} stroke="white" />
        <circle cx="47" cy="45" r="15" fill={sphere} stroke={light} />
        <circle cx="47" cy="45" r="7" fill={dark} />
        <circle cx="43" cy="40" r="3.5" fill="white" opacity=".9" />
      </>
    );
  if (name === "play")
    return (
      <>
        <circle cx="48" cy="49" r="28" fill={dark} opacity=".3" />
        <circle cx="47" cy="45" r="28" fill={sphere} stroke={light} strokeOpacity=".65" />
        <path d="m39 29 23 16-23 16V29Z" fill={metal} stroke="white" strokeWidth="2" strokeLinejoin="round" />
      </>
    );
  if (name === "lifeline")
    return (
      <>
        <path d="M48 76C-2 44 25 10 48 33 71 10 98 44 48 76Z" fill={dark} opacity=".35" />
        <path d="M47 70C-3 38 24 4 47 27 70 4 97 38 47 70Z" fill={metal} stroke="white" strokeOpacity=".6" />
        <path
          d="M24 46h13l5-11 9 23 6-12h13"
          stroke={dark}
          strokeWidth="3.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </>
    );
  if (name === "voice")
    return (
      <>
        <rect
          x="19"
          y="24"
          width="58"
          height="48"
          rx="17"
          fill={dark}
          opacity=".18"
          stroke={light}
          strokeOpacity=".4"
        />
        <path
          d="M27 42v10m10-17v24m10-32v40m10-33v26m10-17v8"
          stroke={metal}
          strokeWidth="5"
          strokeLinecap="round"
        />
      </>
    );
  const filled = ["phone", "wrench", "shield", "name"].includes(name);
  return (
    <>
      <g
        transform="translate(25 26) scale(1.94)"
        fill={filled ? dark : "none"}
        stroke={dark}
        strokeWidth="2.3"
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity=".42"
      >
        <Glyph name={name} />
      </g>
      <g
        transform="translate(24 22) scale(1.94)"
        fill={filled ? metal : "none"}
        stroke={metal}
        strokeWidth={filled ? "1.1" : "2.3"}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <Glyph name={name} />
      </g>
    </>
  );
}

/** Flat, original glyphs for small controls; dimensional artwork at feature sizes. */
export function Icon({
  name,
  size = 24,
  label,
  flat = false,
}: {
  name: string;
  size?: number;
  label?: string;
  /** Always the flat glyph, at any size (AGENCY Browser's controls). */
  flat?: boolean;
}) {
  if (
    !flat &&
    size >= 28 &&
    !["check", "x", "pause", "stop", "bell", "left", "right", "back", "plus"].includes(name)
  ) {
    return <AppIcon name={name} size={size} label={label} />;
  }
  return (
    <svg
      className="ico"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={label ? undefined : true}
      role={label ? "img" : undefined}
      aria-label={label}
      focusable="false"
    >
      <Glyph name={name} />
    </svg>
  );
}

export function AppIcon({ name, size = 80, label }: { name: string; size?: number; label?: string }) {
  const id = `art-${useId().replace(/:/g, "")}`;
  const [light, mid, dark] = palettes[name] ?? ["#d5dfff", "#889dd9", "#455c9a"];
  const ref = (part: string) => `url(#${id}-${part})`;
  return (
    <svg
      className="ico app-art"
      data-art={name}
      width={size}
      height={size}
      viewBox="0 0 96 96"
      fill="none"
      aria-hidden={label ? undefined : true}
      role={label ? "img" : undefined}
      aria-label={label}
      focusable="false"
    >
      <defs>
        <linearGradient id={`${id}-body`} x1="17" y1="7" x2="77" y2="89" gradientUnits="userSpaceOnUse">
          <stop stopColor={light} />
          <stop offset=".48" stopColor={mid} />
          <stop offset="1" stopColor={dark} />
        </linearGradient>
        <linearGradient id={`${id}-edge`} x1="21" y1="7" x2="75" y2="87" gradientUnits="userSpaceOnUse">
          <stop stopColor="white" stopOpacity=".92" />
          <stop offset=".5" stopColor="white" stopOpacity=".08" />
          <stop offset="1" stopColor="white" stopOpacity=".4" />
        </linearGradient>
        <linearGradient id={`${id}-metal`} x1="32" y1="24" x2="65" y2="73" gradientUnits="userSpaceOnUse">
          <stop stopColor="#fff" />
          <stop offset=".4" stopColor="#f6faff" />
          <stop offset=".72" stopColor={light} />
          <stop offset="1" stopColor="#fff" />
        </linearGradient>
        <radialGradient
          id={`${id}-light`}
          cx="0"
          cy="0"
          r="1"
          gradientTransform="translate(31 18) rotate(55) scale(62 51)"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="white" stopOpacity=".55" />
          <stop offset="1" stopColor="white" stopOpacity="0" />
        </radialGradient>
        <radialGradient id={`${id}-sphere`} cx=".3" cy=".2" r=".85">
          <stop stopColor="white" stopOpacity=".95" />
          <stop offset=".3" stopColor={light} />
          <stop offset=".7" stopColor={mid} />
          <stop offset="1" stopColor={dark} />
        </radialGradient>
      </defs>
      <g className="app-art-sculpture">
        <rect x="10" y="13" width="76" height="78" rx="23" fill={dark} opacity=".15" />
        <rect
          x="8"
          y="7"
          width="80"
          height="80"
          rx="24"
          fill={ref("body")}
          stroke={ref("edge")}
          strokeWidth="1.5"
        />
        <rect
          x="12"
          y="11"
          width="72"
          height="72"
          rx="20"
          fill={ref("light")}
          stroke={ref("edge")}
          strokeWidth=".7"
        />
        <path
          d="M21 22c13-12 34-11 51-4"
          stroke="white"
          strokeOpacity=".32"
          strokeWidth="2"
          strokeLinecap="round"
        />
        {name === "speak" || name === "message" ? (
          <>
            <path d="M32 34h40v27c0 5-4 9-9 9h-9l-9 8v-8h-4c-5 0-9-4-9-9V34Z" fill={dark} opacity=".32" />
            <path
              d="M25 28h38c5 0 9 4 9 9v21c0 5-4 9-9 9H43L29 77V67h-4c-5 0-9-4-9-9V37c0-5 4-9 9-9Z"
              fill={ref("metal")}
              stroke="white"
              strokeOpacity=".6"
            />
            <path d="M29 42h28m-28 9h20" stroke={dark} strokeWidth="4" strokeLinecap="round" opacity=".8" />
          </>
        ) : name === "document" ? (
          <>
            <path d="M32 22h26l14 14v42H32V22Z" fill={dark} opacity=".28" />
            <path d="M27 18h27l14 14v43H27V18Z" fill={ref("metal")} stroke="white" strokeOpacity=".8" />
            <path d="M54 18v15h14" fill={light} stroke={mid} strokeWidth="1" />
            <path d="M37 44h20m-20 10h20m-20 10h13" stroke={mid} strokeWidth="3" strokeLinecap="round" />
          </>
        ) : name === "grid" ? (
          <>
            <rect x="27" y="29" width="49" height="47" rx="12" fill={dark} opacity=".3" />
            <rect x="20" y="22" width="53" height="51" rx="13" fill={ref("metal")} stroke="white" />
            {[
              [29, 31],
              [49, 31],
              [29, 51],
              [49, 51],
            ].map(([x, y], i) => (
              <rect
                key={i}
                x={x}
                y={y}
                width="13"
                height="13"
                rx="4"
                fill={i === 0 ? mid : dark}
                opacity={i === 0 ? 0.9 : 0.55}
              />
            ))}
          </>
        ) : name === "gear" ? (
          <>
            <g
              transform="translate(24 25) scale(2)"
              stroke={dark}
              strokeWidth="2.8"
              strokeLinejoin="round"
              opacity=".45"
            >
              <Glyph name={name} />
            </g>
            <g
              transform="translate(24 21) scale(2)"
              stroke={ref("metal")}
              strokeWidth="2.8"
              strokeLinejoin="round"
            >
              <Glyph name={name} />
            </g>
            <circle cx="48" cy="45" r="9" fill={dark} stroke={light} strokeWidth="1.5" />
            <circle cx="48" cy="45" r="5" fill={ref("body")} stroke={ref("edge")} />
          </>
        ) : (
          <Sculpture name={name} metal={ref("metal")} sphere={ref("sphere")} light={light} dark={dark} />
        )}
        <path
          d="M25 79c15 5 32 5 46-1"
          stroke="white"
          strokeWidth="1"
          strokeOpacity=".2"
          strokeLinecap="round"
        />
      </g>
      <g
        className="app-art-contrast"
        transform="translate(20 20) scale(2.33)"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <Glyph name={name} />
      </g>
    </svg>
  );
}

export function BrandMark() {
  return (
    <svg className="brand-mark" viewBox="0 0 64 64" fill="none" aria-hidden="true" focusable="false">
      <rect x="1" y="1" width="62" height="62" rx="20" fill="var(--accent)" />
      <path
        d="M15 46 32 16l17 30M23 35h18"
        stroke="var(--accent-ink)"
        strokeWidth="5.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M13 12c8-7 24-8 37-1"
        stroke="var(--accent-ink)"
        strokeOpacity=".4"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}
