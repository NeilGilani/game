/** My day inside the shell (#/day/...): today, care reminders, the home and asking for help. */
import "./daily.css";
import { AskHelp } from "./AskHelp";
import { CareRoutines } from "./CareRoutines";
import { HomeTiles } from "./HomeTiles";
import { MyDay } from "./MyDay";
import { RemindMe } from "./RemindMe";

export function DailyRoute({ segments }: { segments: string[] }) {
  const [a = ""] = segments;
  if (a === "care") return <CareRoutines />;
  if (a === "home") return <HomeTiles />;
  if (a === "help") return <AskHelp />;
  if (a === "remind") return <RemindMe />;
  return <MyDay />;
}
