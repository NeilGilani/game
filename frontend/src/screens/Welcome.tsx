import { BrandMark, Icon } from "../components/Icon";
import { MODE_LABELS } from "../state/input";
import { navigate } from "../state/router";
import { ModePicker } from "./SettingsViews";

export const ONBOARDED_KEY = "agency.onboarded";

function finish(path: string) {
  try {
    localStorage.setItem(ONBOARDED_KEY, "1");
  } catch {
    /* ignore */
  }
  navigate(path);
}

export function Welcome() {
  return (
    <main className="welcome">
      <div className="welcome-card">
        <div className="row" style={{ gap: 18 }}>
          <BrandMark />
          <span style={{ fontWeight: 700, letterSpacing: "0.2em", fontSize: "1.3rem" }}>AGENCY</span>
        </div>
        <div>
          <h1 className="hero-title">You say what you want done. AGENCY carries it through.</h1>
          <p style={{ fontSize: "1.2rem", maxWidth: "60ch" }}>
            Choose a goal with a few deliberate selections, using your eyes, a small head movement, a blink or
            a single switch. AGENCY plans the steps, asks before anything important, checks every result, and
            remembers where things stand.
          </p>
        </div>
        <section className="stack" aria-labelledby="h-mode">
          <h2 id="h-mode">How would you like to control it?</h2>
          <ModePicker onPicked={(mode) => finish(MODE_LABELS[mode].camera ? "/camera" : "/")} />
          <p className="small muted">
            You can change this any time in Settings. Mouse and keyboard always keep working, for you or
            someone helping you.
          </p>
        </section>
        <button
          className="btn btn-quiet"
          style={{ alignSelf: "flex-start" }}
          onClick={() => finish("/")}
          data-dwell
        >
          <Icon name="right" /> Skip for now
        </button>
      </div>
    </main>
  );
}
