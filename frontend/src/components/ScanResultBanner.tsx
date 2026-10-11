import { useEffect, useState } from "react";
import { Icon } from "./Icon";

/** Which eye model the pointer now uses, and how accurate, from the eye scan that just finished. */
export interface ScanResult {
  model: string;
  /** How accurate, and how that was found ("measured error about 52 px on 3 check dots"). */
  error: string;
}

const EVENT = "agency:scan-result";
const SHOW_MS = 10_000;
/** The scan runs full-screen, outside the page that shows the banner: keep the result until Home mounts. */
let latest: { result: ScanResult; at: number } | null = null;

export function showScanResult(result: ScanResult): void {
  latest = { result, at: Date.now() };
  window.dispatchEvent(new Event(EVENT));
}

/**
 * The eye scan's result, floating over Home for a few seconds: no screen to wait on or dismiss,
 * nothing to select, and nothing moves under the eyes when it goes.
 */
export function ScanResultBanner() {
  const [result, setResult] = useState<ScanResult | null>(null);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const sync = () => {
      clearTimeout(timer);
      const left = latest ? SHOW_MS - (Date.now() - latest.at) : 0;
      if (!latest || left <= 0) {
        setResult(null);
        return;
      }
      setResult(latest.result);
      timer = setTimeout(sync, left);
    };
    sync();
    window.addEventListener(EVENT, sync);
    return () => {
      window.removeEventListener(EVENT, sync);
      clearTimeout(timer);
    };
  }, []);
  if (!result) return null;
  return (
    <div className="banner banner-ok banner-float" role="status">
      <Icon name="check" />
      <span>
        Eye scan done. Eye model: {result.model}{" "}
        {result.error.charAt(0).toUpperCase() + result.error.slice(1)}.
      </span>
    </div>
  );
}
