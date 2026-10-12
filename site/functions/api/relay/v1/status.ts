/** GET /api/relay/v1/status (signed): whether this install is known and AGENCY Cloud is on. No tokens spent. */
import { handleStatus } from "../../../_lib/relay";

export const onRequestGet = handleStatus;
