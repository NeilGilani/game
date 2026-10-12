/**
 * Keeps the shell connected to AGENCY Browser wherever the person is: its events arrive even while another screen
 * is showing, and when the assistant opens a page for a task the person is watching, the browser comes to the front
 * with that task beside the page.
 */
import { useEffect, useRef } from "react";
import { useAgent } from "../state/agent";
import { navigate } from "../state/router";
import { isFinished } from "../state/tasks";
import { onShowBrowser, startBrowserStore } from "./store";

export function BrowserLink() {
  const agent = useAgent();
  const tasks = useRef(agent.tasks);
  tasks.current = agent.tasks;

  useEffect(() => startBrowserStore(), []);

  useEffect(
    () =>
      onShowBrowser(() => {
        const route = window.location.hash.replace(/^#/, "");
        if (route.startsWith("/internet")) return;
        // Only from the screen of a task that is running now: never away from Lifeline, Talk or anything else.
        const m = /^\/task\/([^/?]+)/.exec(route);
        const t = m ? tasks.current.find((x) => x.id === decodeURIComponent(m[1]!)) : undefined;
        if (t && !isFinished(t)) navigate(`/internet?task=${encodeURIComponent(t.id)}`);
      }),
    [],
  );
  return null;
}
