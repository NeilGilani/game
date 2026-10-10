// Builds the extension (dist/extension), the native host (dist/host.cjs) and the installer (dist/install.mjs).
import { build } from "esbuild";
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
const ext = join(dist, "extension");
rmSync(dist, { recursive: true, force: true });
mkdirSync(ext, { recursive: true });

const common = { bundle: true, target: "chrome116", logLevel: "warning", legalComments: "none" };
await build({ ...common, entryPoints: [join(root, "src/extension/background.ts")], outfile: join(ext, "background.js"), format: "esm" });
for (const name of ["content", "allow", "options"])
  await build({ ...common, entryPoints: [join(root, `src/extension/${name}.ts`)], outfile: join(ext, `${name}.js`), format: "iife" });
for (const f of ["manifest.json", "allow.html", "options.html", "pages.css"]) cpSync(join(root, "extension", f), join(ext, f));
writeFileSync(join(ext, "icon128.png"), icon(128));

const node = { bundle: true, platform: "node", target: "node20", format: "cjs", logLevel: "warning" };
await build({ ...node, entryPoints: [join(root, "src/host/main.ts")], outfile: join(dist, "host.cjs") });
await build({ ...node, entryPoints: [join(root, "src/app/install-cli.ts")], outfile: join(dist, "install.mjs"), format: "esm" });
console.log("Built dist/extension, dist/host.cjs and dist/install.mjs");

/** A plain icon (navy square, amber eye ring) as a PNG, so the build needs no image files. */
function icon(size) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  const c = size / 2;
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - c + 0.5, y - c + 0.5) / c;
      const ring = d > 0.55 && d < 0.8;
      const pupil = d < 0.28;
      const [r, g, b] = ring ? [252, 163, 17] : pupil ? [255, 255, 255] : [20, 33, 61];
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = 255;
    }
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let k = n;
    for (let i = 0; i < 8; i++) k = k & 1 ? 0xedb88320 ^ (k >>> 1) : k >>> 1;
    return k >>> 0;
  });
  const crc = (buf) => {
    let k = 0xffffffff;
    for (const b of buf) k = crcTable[(k ^ b) & 0xff] ^ (k >>> 8);
    return (k ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const cs = Buffer.alloc(4);
    cs.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, cs]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
