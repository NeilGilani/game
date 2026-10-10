/** Device-local storage for the word predictor. Wrapped so blocked storage never breaks Talk. */
import { EMPTY_STATE, Predictor, type PredictorState } from "./predict";

const KEY = "agency.talk.predictor";
let shared: Predictor | null = null;

export function predictor(): Predictor {
  if (shared) return shared;
  let state: PredictorState = EMPTY_STATE;
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) state = JSON.parse(raw) as PredictorState;
  } catch {
    /* ignore */
  }
  shared = new Predictor(state?.version === 1 ? state : EMPTY_STATE);
  return shared;
}

export function persistPredictor(): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(predictor().snapshot()));
  } catch {
    /* ignore */
  }
}

export function resetPredictor(): void {
  shared = new Predictor(EMPTY_STATE);
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
