/** POST /api/relay/v1/register: a new anonymous AGENCY Cloud install (see functions/_lib/relay.ts). */
import { handleRegister } from "../../../_lib/relay";

export const onRequestPost = handleRegister;
