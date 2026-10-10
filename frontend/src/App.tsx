import { useEffect } from "react";
import { ConnectionBanner, Nav, TopBar } from "./components/Shell";
import { InputLayer } from "./input/InputLayer";
import { LifelineOverlay } from "./lifeline/LifelineOverlay";
import { LifelineProvider } from "./lifeline/LifelineProvider";
import { AgentProvider } from "./state/agent";
import { AnnouncerProvider } from "./state/announcer";
import { ConnectionProvider } from "./state/connection";
import { InputProvider } from "./state/input";
import { PreferencesProvider, usePreferences } from "./state/preferences";
import { navigate, useRoute, type Route } from "./state/router";
import { Approve } from "./screens/Approve";
import { Calibrate } from "./screens/Calibrate";
import { CameraSetup } from "./screens/CameraSetup";
import { ApprovalsList, CasesList, RecoveryView, TimelineView } from "./screens/CaseViews";
import { CaseWorkspace } from "./screens/CaseWorkspace";
import { CreateCase } from "./screens/CreateCase";
import { AppsScreen } from "./screens/Apps";
import { Errands } from "./screens/Errands";
import { FlowScreen } from "./screens/Flow";
import { Home } from "./screens/Home";
import { Onboarding } from "./screens/Onboarding";
import {
  HelperSettings,
  MemorySettings,
  SettingsHub,
  TalkPlaceholder,
  VoiceSettings,
} from "./screens/OsSettings";
import { TaskScreen } from "./screens/Task";
import { LifelineAlertView, LifelineHome, LifelineSetup } from "./screens/Lifeline";
import { PhoneSimulator } from "./screens/PhoneSimulator";
import { NewTask, Phrases } from "./screens/NewTask";
import { PreferencesView, SettingsView, StatusView } from "./screens/SettingsViews";
import { ONBOARDED_KEY, Welcome } from "./screens/Welcome";

function onboarded(): boolean {
  try {
    return localStorage.getItem(ONBOARDED_KEY) === "1";
  } catch {
    return true;
  }
}

function Screen({ route }: { route: Route }) {
  const [a, b, c] = route.segments;
  if (!a) return <Home />;
  if (a === "flow" && b) return <FlowScreen key={b} id={b} />;
  if (a === "task" && b) return <TaskScreen key={b} id={b} />;
  if (a === "apps") return <AppsScreen key={route.query.toString()} route={route} />;
  if (a === "talk") return <TalkPlaceholder />;
  if (a === "errands") return <Errands />;
  if (a === "onboarding") return <Onboarding />;
  if (a === "settings" && !b) return <SettingsHub />;
  if (a === "settings" && b === "voice") return <VoiceSettings />;
  if (a === "settings" && b === "memory") return <MemorySettings />;
  if (a === "settings" && b === "helper") return <HelperSettings />;
  if (a === "settings" && b === "connection") return <SettingsView />;
  if (a === "new" && !b) return <NewTask />;
  if (a === "new" && b === "phrases") return <Phrases />;
  if (a === "new" && b === "create") return <CreateCase key={route.query.toString()} route={route} />;
  if (a === "cases") return <CasesList />;
  if (a === "approvals") return <ApprovalsList />;
  if (a === "case" && b && !c) return <CaseWorkspace key={b} id={b} />;
  if (a === "case" && b && c === "approve") return <Approve key={b} id={b} />;
  if (a === "case" && b && c === "timeline") return <TimelineView key={b} id={b} />;
  if (a === "case" && b && c === "recovery") return <RecoveryView key={b} id={b} />;
  if (a === "lifeline" && !b) return <LifelineHome />;
  if (a === "lifeline" && b === "setup") return <LifelineSetup />;
  if (a === "lifeline" && b === "alert" && c) return <LifelineAlertView key={c} id={c} />;
  if (a === "camera") return <CameraSetup />;
  if (a === "preferences") return <PreferencesView />;
  if (a === "status") return <StatusView />;
  return (
    <div className="panel stack">
      <h1>That page doesn't exist</h1>
      <button
        className="btn btn-primary"
        style={{ alignSelf: "flex-start" }}
        onClick={() => navigate("/")}
        data-dwell
      >
        Go home
      </button>
    </div>
  );
}

function Shell() {
  const route = useRoute();
  useEffect(() => {
    if (route.path === "/" && !onboarded()) navigate("/welcome");
  }, [route.path]);
  useEffect(() => {
    document.getElementById("main")?.focus({ preventScroll: true });
    document.getElementById("main")?.scrollTo({ top: 0 });
  }, [route.path]);

  if (route.segments[0] === "welcome") {
    return (
      <>
        <Welcome />
        <LifelineOverlay />
        <InputLayer />
      </>
    );
  }
  if (route.segments[0] === "calibrate") {
    return (
      <>
        <Calibrate />
        <LifelineOverlay />
        <InputLayer />
      </>
    );
  }
  // Caregiver tools (cases, approvals, status) keep their side navigation; everything else is the full-width OS.
  const tools = ["new", "cases", "case", "approvals", "status", "errands"].includes(route.segments[0] ?? "");
  return (
    <div className={tools ? "shell" : "shell shell-os"}>
      <a
        className="sr-only"
        href="#main"
        onClick={(e) => {
          e.preventDefault();
          document.getElementById("main")?.focus();
        }}
      >
        Skip to content
      </a>
      <TopBar />
      {tools && <Nav route={route} />}
      <main className="main" id="main" tabIndex={-1}>
        <ConnectionBanner />
        {tools && <div style={{ height: 16 }} />}
        <Screen route={route} />
      </main>
      <LifelineOverlay />
      <InputLayer />
    </div>
  );
}

function WithAnnouncer() {
  const { prefs } = usePreferences();
  return (
    <AnnouncerProvider speak={prefs.speak_feedback}>
      <InputProvider>
        <LifelineProvider>
          <AgentProvider>
            <Shell />
          </AgentProvider>
        </LifelineProvider>
      </InputProvider>
    </AnnouncerProvider>
  );
}

export function App() {
  const route = useRoute();
  if (route.segments[0] === "phones") {
    // Stands in for the contacts' phones: none of the person's camera, alarm or heartbeat.
    return <PhoneSimulator />;
  }
  return (
    <ConnectionProvider>
      <PreferencesProvider>
        <WithAnnouncer />
      </PreferencesProvider>
    </ConnectionProvider>
  );
}
