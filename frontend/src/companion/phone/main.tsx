/** Entry for the caregiver's phone companion (companion.html), served by AGENCY's phone server. */
import "@fontsource/atkinson-hyperlegible/400.css";
import "@fontsource/atkinson-hyperlegible/700.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { PhoneApp } from "./PhoneApp";
import "./phone.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <PhoneApp />
  </StrictMode>,
);
