/** My day's screens under /day. */
import "./daily.css";
import type { Route } from "../state/router";
import { AskHelp, Tell } from "./Help";
import { HomeScreen } from "./HomeScreen";
import { MyDayHub, Today } from "./MyDay";
import { Routines } from "./Routines";

export function DailyRoute({ route }: { route: Route }) {
  const page = route.segments[1];
  if (!page) return <MyDayHub />;
  if (page === "today") return <Today />;
  if (page === "routines") return <Routines />;
  if (page === "home") return <HomeScreen />;
  if (page === "help") return <AskHelp />;
  if (page === "tell") return <Tell key={route.query.toString()} />;
  return <MyDayHub />;
}
