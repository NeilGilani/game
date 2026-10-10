/**
 * Sends Lifeline heartbeats from a worker. Browsers heavily throttle timers on the main thread
 * of a page that has been in the background for a while, which would look like the
 * interface freezing and could set off a false watchdog alert. Worker timers aren't throttled
 * that way. The main thread keeps the payload current.
 */

interface Config {
  base: string;
  token: string;
  intervalMs: number;
  body: Record<string, unknown>;
  running: boolean;
}

const config: Config = { base: "", token: "", intervalMs: 5000, body: {}, running: false };
let timer: ReturnType<typeof setInterval> | null = null;

async function send(): Promise<void> {
  if (!config.running || !config.base) return;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (config.token) headers["X-Agency-Token"] = config.token;
  const controller = new AbortController();
  const abort = setTimeout(() => controller.abort(), 4000);
  try {
    const res = await fetch(`${config.base}/api/lifeline/heartbeat`, {
      method: "POST",
      headers,
      body: JSON.stringify(config.body),
      signal: controller.signal,
    });
    postMessage({ ok: res.ok, status: res.status, at: Date.now() });
  } catch {
    postMessage({ ok: false, status: 0, at: Date.now() });
  } finally {
    clearTimeout(abort);
  }
}

function restart(): void {
  if (timer !== null) clearInterval(timer);
  timer = config.running ? setInterval(() => void send(), config.intervalMs) : null;
}

onmessage = (event: MessageEvent<Partial<Config> & { now?: boolean }>) => {
  const { now, ...changes } = event.data;
  const restartNeeded =
    (changes.running !== undefined && changes.running !== config.running) ||
    (changes.intervalMs !== undefined && changes.intervalMs !== config.intervalMs);
  Object.assign(config, changes);
  if (restartNeeded) restart();
  if (now) void send();
};
