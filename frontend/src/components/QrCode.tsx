import qrcode from "qrcode-generator";
import { useMemo } from "react";

/**
 * A QR code drawn as SVG (no images, no innerHTML). Always dark on white with a quiet zone,
 * whatever the theme, so phone cameras can read it.
 */
export function QrCode({ value, size = 168, label }: { value: string; size?: number; label: string }) {
  const { n, d } = useMemo(() => {
    const qr = qrcode(0, "M");
    qr.addData(value);
    qr.make();
    const count = qr.getModuleCount();
    let path = "";
    for (let r = 0; r < count; r++) {
      for (let c = 0; c < count; c++) if (qr.isDark(r, c)) path += `M${c + 4} ${r + 4}h1v1h-1z`;
    }
    return { n: count + 8, d: path };
  }, [value]);
  return (
    <svg className="qr" viewBox={`0 0 ${n} ${n}`} width={size} height={size} role="img" aria-label={label}>
      <rect width={n} height={n} fill="#ffffff" />
      <path d={d} fill="#000000" shapeRendering="crispEdges" />
    </svg>
  );
}
