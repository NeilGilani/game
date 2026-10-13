/**
 * Applying a carer's change to what the Mac keeps itself (Talk phrases, details for forms, favourite sites, the
 * Papers folder), and reading those back so the phone edits what is really there.
 *
 * Pure apart from the storage and Mac app interfaces passed in, so it is tested without a browser.
 */
import { STARTER_BOARDS, type PhraseBoard } from "../../../os/tasks/src/index";
import type { Profile } from "../../../os/tasks/src/profile";
import type { PapersFolder, PapersFolderChoice } from "../../../os/contracts/src/host";
import type { Favourite } from "../../../os/contracts/src/browser";
import { cleanDetails } from "../papers/store";
import type { CompanionChange, MacSnapshot } from "./macApi";

/** The same keys Talk and Papers use (frontend/src/talk/storage.ts, frontend/src/papers/store.ts). */
export const BOARDS_KEY = "agency.talk.boards";
export const DETAILS_KEY = "agency.papers.details";
/** The Talk board carers fill from their phones. */
export const CARERS_BOARD = "carers";
export const CARERS_TITLE = "From your carers";

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface MacParts {
  storage: KeyValueStore;
  browser: { favourites(): Promise<Favourite[]>; setFavourites(f: Favourite[]): Promise<Favourite[]> } | null;
  papers: { chooseFolder(choice: PapersFolderChoice): Promise<PapersFolder | null> } | null;
  folder: () => PapersFolder | null;
}

export interface ApplyResult {
  ok: boolean;
  reason: string;
}

type Flat = Record<
  | "fullName"
  | "preferredName"
  | "dateOfBirth"
  | "phone"
  | "email"
  | "line1"
  | "line2"
  | "city"
  | "region"
  | "postalCode",
  string
>;

function readJson<T>(store: KeyValueStore, key: string, fallback: T): T {
  try {
    const raw = store.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function readBoards(store: KeyValueStore): PhraseBoard[] {
  const boards = readJson<unknown>(store, BOARDS_KEY, STARTER_BOARDS);
  return Array.isArray(boards) ? (boards as PhraseBoard[]) : STARTER_BOARDS;
}

/** The carers' board replaced (or removed when empty), every other board left as it was. */
export function withCarersPhrases(boards: PhraseBoard[], phrases: string[]): PhraseBoard[] {
  const others = boards.filter((b) => b.id !== CARERS_BOARD);
  if (phrases.length === 0) return others;
  const board = { id: CARERS_BOARD, title: CARERS_TITLE, phrases };
  const at = boards.findIndex((b) => b.id === CARERS_BOARD);
  if (at < 0) return [...others, board];
  return boards.map((b) => (b.id === CARERS_BOARD ? board : b));
}

export function detailsFromFlat(f: Partial<Flat>): Profile | null {
  return cleanDetails({
    fullName: f.fullName ?? "",
    preferredName: f.preferredName ?? "",
    dateOfBirth: f.dateOfBirth ?? "",
    phone: f.phone ?? "",
    email: f.email ?? "",
    address: {
      line1: f.line1 ?? "",
      line2: f.line2 ?? "",
      city: f.city ?? "",
      region: f.region ?? "",
      postalCode: f.postalCode ?? "",
    },
  });
}

export function flatFromDetails(p: Profile | null): Flat | null {
  if (!p) return null;
  return {
    fullName: p.fullName ?? "",
    preferredName: p.preferredName ?? "",
    dateOfBirth: p.dateOfBirth ?? "",
    phone: p.phone ?? "",
    email: p.email ?? "",
    line1: p.address?.line1 ?? "",
    line2: p.address?.line2 ?? "",
    city: p.address?.city ?? "",
    region: p.address?.region ?? "",
    postalCode: p.address?.postalCode ?? "",
  };
}

function plain(err: unknown): string {
  return err instanceof Error && err.message ? err.message.slice(0, 180) : "It didn't work.";
}

export async function applyChange(change: CompanionChange, mac: MacParts): Promise<ApplyResult> {
  const p = change.payload ?? {};
  try {
    switch (change.kind) {
      case "phrases": {
        const phrases = Array.isArray(p.phrases)
          ? p.phrases.filter((x): x is string => typeof x === "string")
          : [];
        mac.storage.setItem(BOARDS_KEY, JSON.stringify(withCarersPhrases(readBoards(mac.storage), phrases)));
        return { ok: true, reason: "" };
      }
      case "details": {
        const clean = detailsFromFlat((p.details ?? {}) as Partial<Flat>);
        if (clean) mac.storage.setItem(DETAILS_KEY, JSON.stringify(clean));
        else mac.storage.removeItem(DETAILS_KEY);
        return { ok: true, reason: "" };
      }
      case "favourites": {
        if (!mac.browser)
          return {
            ok: false,
            reason: "Favourite sites are kept by the AGENCY Mac app, which isn't running here.",
          };
        const list = Array.isArray(p.favourites) ? (p.favourites as { title: string; url: string }[]) : [];
        const stamp = Date.now().toString(36);
        await mac.browser.setFavourites(
          list.map((f, i) => ({ id: `fav-${stamp}-${i}`, title: f.title, url: f.url })),
        );
        return { ok: true, reason: "" };
      }
      case "papers_folder": {
        if (!mac.papers)
          return {
            ok: false,
            reason: "The Papers folder is chosen in the AGENCY Mac app, which isn't running here.",
          };
        const choice = p.folder === "downloads" ? "downloads" : "papers";
        const folder = await mac.papers.chooseFolder(choice);
        return folder ? { ok: true, reason: "" } : { ok: false, reason: "The folder couldn't be used." };
      }
      default:
        return { ok: false, reason: "The Mac doesn't keep that." };
    }
  } catch (err) {
    return { ok: false, reason: plain(err) };
  }
}

export async function readSnapshot(mac: MacParts): Promise<MacSnapshot> {
  const carers = readBoards(mac.storage).find((b) => b.id === CARERS_BOARD);
  let favourites: { title: string; url: string }[] = [];
  if (mac.browser) {
    try {
      favourites = (await mac.browser.favourites()).map((f) => ({ title: f.title, url: f.url }));
    } catch {
      favourites = [];
    }
  }
  const folder = mac.folder();
  const raw = readJson<Partial<Profile> | null>(mac.storage, DETAILS_KEY, null);
  return {
    phrases: carers?.phrases ?? [],
    favourites: favourites.slice(0, 48),
    papers_folder: folder ? { display: folder.display } : null,
    details: flatFromDetails(raw ? cleanDetails(raw) : null),
  };
}

/** What changed, for the screen and to be read aloud: "Jordan added 2 phrases to Talk." */
export function noticeFor(change: CompanionChange): string {
  return `${change.author}: ${change.summary}`;
}
