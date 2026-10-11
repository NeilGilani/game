/**
 * Web demo: AGENCY in any browser, with no coordinator to install. The app's coordinator calls are
 * answered here, in the page, from responses recorded from the real coordinator (recorded.json:
 * its built-in demo profile, everything simulated), with their times moved to now. The camera, eye
 * tracking, Home, the flows and Lifeline's countdown all run as usual in this browser. Nothing is
 * sent anywhere: requests to the stand-in address never leave the page.
 *
 * Only in builds made with VITE_WEB_DEMO=1 (`make web-demo`), for the hosted demo link.
 */

import recorded from "./recorded.json";

/** A reserved address (.invalid never resolves), so a call the stand-in misses fails safely. */
export const WEB_DEMO_ORIGIN = "https://web-demo.agency.invalid";

type Json = unknown;
type Recorded = Record<string, Json> & { captured_at: number };
const rec = recorded as Recorded;

const ISO = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})/g;
const HELP = rec["POST /api/lifeline/help"] as { alert: { id: string; created_at: string } };
const ALERT_ID = HELP.alert.id;
const OTHER_ALERT_ID = (rec["POST /api/lifeline/help 2"] as { alert: { id: string } }).alert.id;
const CANCEL_WINDOW_MS =
  (((rec["GET /api/lifeline/settings"] as { cancel_window_s?: number }).cancel_window_s ?? 8) as number) *
  1000;

/** A recorded response with every timestamp moved by `shiftMs`, and one alert id throughout. */
function replay(value: Json, shiftMs: number): Json {
  const text = JSON.stringify(value)
    .replaceAll(OTHER_ALERT_ID, ALERT_ID)
    .replace(ISO, (m) => new Date(Date.parse(m) + shiftMs).toISOString());
  return JSON.parse(text) as Json;
}

type Lifeline = "idle" | "countdown" | "calling";

class StandIn {
  private lifeline: Lifeline = "idle";
  private helpAt = 0;
  private lastAlert: Json = null;
  private preferences = rec["GET /api/preferences"] as Record<string, Json>;
  private settings = rec["GET /api/lifeline/settings"] as Record<string, Json>;

  /** Recorded times, moved so "recorded at" reads as now. */
  private now(value: Json): Json {
    return replay(value, Date.now() - rec.captured_at * 1000);
  }

  /** Alert times, moved so the alert starts when the person asked for help. */
  private alert(value: Json): Json {
    return replay(value, this.helpAt - Date.parse(HELP.alert.created_at));
  }

  private tick(): void {
    // The real coordinator calls contacts once the cancel window has passed.
    if (this.lifeline === "countdown" && Date.now() - this.helpAt > CANCEL_WINDOW_MS)
      this.lifeline = "calling";
  }

  handle(method: string, path: string, body: Json): { status: number; body: Json } {
    this.tick();
    const ok = (b: Json) => ({ status: 200, body: b });
    const key = `${method} ${path}`;
    switch (key) {
      case "GET /api/health":
      case "GET /api/approvals":
      case "GET /api/cases":
      case "GET /api/activity":
      case "GET /api/memory/suggestions":
      case "GET /api/runtime":
      case "GET /api/synapse":
      case "GET /api/lifeline/report":
      case "GET /api/lifeline/outbox":
      case "GET /api/lifeline/alerts":
        return ok(this.now(rec[key]));
      case "GET /api/preferences":
        return ok(this.preferences);
      case "PUT /api/preferences":
        this.preferences = { ...this.preferences, ...(body as Record<string, Json>) };
        return ok(this.preferences);
      case "GET /api/lifeline/settings":
        return ok(this.settings);
      case "PUT /api/lifeline/settings":
        this.settings = { ...this.settings, ...(body as Record<string, Json>) };
        return ok(this.settings);
      case "GET /api/lifeline/status":
        return ok(this.status());
      case "POST /api/lifeline/heartbeat":
        return ok(this.now(rec["POST heartbeat"]));
      case "POST /api/lifeline/help":
        if (this.lifeline === "idle") {
          this.helpAt = Date.now();
          this.lifeline = "countdown";
        }
        this.lastAlert = this.alert((rec["POST /api/lifeline/help"] as { alert: Json }).alert);
        return ok({ alert: this.lastAlert, created: true });
      case "POST /api/lifeline/monitoring":
      case "POST /api/lifeline/checkin":
      case "POST /api/lifeline/demo/checkin-now":
        return ok(this.status());
    }
    const alertAction = path.match(/^\/api\/lifeline\/alerts\/[^/]+(?:\/(.+))?$/);
    if (alertAction) {
      const action = alertAction[1];
      if (method === "GET" && !action) return ok(this.currentAlert());
      if (action === "now") {
        this.lifeline = "calling";
        this.lastAlert = this.alert(rec["POST now"]);
      } else if (action === "cancel") {
        this.lifeline = "idle";
        this.lastAlert = this.alert(rec["POST cancel"]);
      } else if (action === "resolve") {
        this.lifeline = "idle";
        this.lastAlert = this.alert(rec["POST resolve"]);
      } else {
        this.lastAlert = this.currentAlert();
      }
      return ok(this.lastAlert);
    }
    return {
      status: 404,
      body: { detail: "This isn't available in the web demo. Run AGENCY on a Mac for everything." },
    };
  }

  private currentAlert(): Json {
    if (this.lifeline === "countdown") return this.alert(rec["alert_open"]);
    if (this.lifeline === "calling") return this.alert(rec["alert_calling"]);
    return this.lastAlert;
  }

  private status(): Json {
    if (this.lifeline === "countdown") return this.alert(rec["status_open"]);
    if (this.lifeline === "calling") return this.alert(rec["status_calling"]);
    return this.now(rec["status_idle"]);
  }
}

/** Point the app at the in-page stand-in and use the in-page demo agent, memory and apps. */
export function installWebDemo(): void {
  try {
    localStorage.setItem("agency.coordinator", WEB_DEMO_ORIGIN);
    localStorage.setItem("agency.fakes", "memory,agent,native");
  } catch {
    /* storage unavailable: the address below still routes every call to the stand-in */
  }
  const standIn = new StandIn();
  const realFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith(WEB_DEMO_ORIGIN)) return realFetch(input, init);
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    let body: Json = null;
    if (typeof init?.body === "string") {
      try {
        body = JSON.parse(init.body) as Json;
      } catch {
        body = null;
      }
    }
    const result = standIn.handle(method, new URL(url).pathname, body);
    return new Response(JSON.stringify(result.body), {
      status: result.status,
      headers: { "content-type": "application/json" },
    });
  };
}
