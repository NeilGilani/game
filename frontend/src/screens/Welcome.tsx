import { BrandMark, Icon } from "../components/Icon";
import { AgencyFlow } from "../components/AgencyFlow";
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
        <div className="welcome-intro">
          <div className="eyebrow">Less effort. More independence.</div>
          <h1 className="hero-title">
            Your intention.
            <br />
            <span>Your independence.</span>
          </h1>
          <p className="welcome-lead">
            A repair arranged. An appointment moved. A message sent. Choose what you need with your eyes, a
            blink, or a switch. AGENCY takes care of the steps, with you in control.
          </p>
          <AgencyFlow />
        </div>
        <section className="stack" aria-labelledby="h-mode">
          <h2 id="h-mode">How would you like to control it?</h2>
          <ModePicker onPicked={(mode) => finish(MODE_LABELS[mode].camera ? "/camera" : "/")} />
          <p className="small muted">
            You can change this any time in Settings. Mouse and keyboard always keep working, for you or
            someone helping you.
          </p>
        </section>
        <div className="row welcome-footer">
          <button className="btn btn-quiet" onClick={() => finish("/")} data-dwell>
            <Icon name="right" /> Skip for now
          </button>
          <button className="btn" onClick={() => finish("/demo")} data-dwell>
            <Icon name="play" /> Explore the live demo
          </button>
          <span className="small muted">
            <Icon name="shield" size={18} /> Camera stays on your device.
          </span>
        </div>
      </div>
    </main>
  );
}
