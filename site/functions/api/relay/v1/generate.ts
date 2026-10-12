/** POST /api/relay/v1/generate (signed): one JSON-mode Gemini answer for the coordinator (functions/_lib/relay.ts). */
import { handleGenerate } from "../../../_lib/relay";

export const onRequestPost = handleGenerate;
