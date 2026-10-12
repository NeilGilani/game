/** POST /api/relay/v1/interactions (signed): one turn of the Mac agent on Gemini (functions/_lib/relay.ts). */
import { handleInteractions } from "../../../_lib/relay";

export const onRequestPost = handleInteractions;
