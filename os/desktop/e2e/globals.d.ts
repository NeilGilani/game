import type { AgencyApi } from "@agency/contracts";

declare global {
  interface Window {
    agency: AgencyApi;
  }
}
