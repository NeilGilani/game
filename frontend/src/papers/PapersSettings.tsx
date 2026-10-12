/**
 * Settings, Papers (for a helper): the one folder Papers may use (Mac app), whether letters may be explained with
 * Gemini, the person's details for forms, and their signature picture. Everything is kept on this computer.
 */
import { useEffect, useRef, useState } from "react";
import { Icon } from "../components/Icon";
import { Page } from "../components/Shell";
import { useAnnounce } from "../state/announcer";
import { navigate } from "../state/router";
import { Toggle } from "../screens/SettingsViews";
import type { Profile } from "../../../os/tasks/src/profile";
import type { PapersFolderChoice } from "../../../os/contracts/src/host";
import {
  currentFolder,
  onFolderChange,
  papersApi,
  plainError,
  refreshFolder,
  setCurrentFolder,
} from "./source";
import {
  MAX_SIGNATURE_BYTES,
  cloudExplainAllowed,
  loadDetails,
  loadSignature,
  saveDetails,
  saveSignature,
  setCloudExplain,
} from "./store";

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

function flatten(p: Profile | null): Flat {
  return {
    fullName: p?.fullName ?? "",
    preferredName: p?.preferredName ?? "",
    dateOfBirth: p?.dateOfBirth ?? "",
    phone: p?.phone ?? "",
    email: p?.email ?? "",
    line1: p?.address?.line1 ?? "",
    line2: p?.address?.line2 ?? "",
    city: p?.address?.city ?? "",
    region: p?.address?.region ?? "",
    postalCode: p?.address?.postalCode ?? "",
  };
}

const FIELDS: { key: keyof Flat; label: string; type?: string; autoComplete: string }[] = [
  { key: "fullName", label: "Full name", autoComplete: "name" },
  { key: "preferredName", label: "Preferred name", autoComplete: "nickname" },
  { key: "dateOfBirth", label: "Date of birth (as forms should show it)", autoComplete: "bday" },
  { key: "phone", label: "Phone", type: "tel", autoComplete: "tel" },
  { key: "email", label: "Email", type: "email", autoComplete: "email" },
  { key: "line1", label: "Street address", autoComplete: "address-line1" },
  { key: "line2", label: "Apartment, unit (optional)", autoComplete: "address-line2" },
  { key: "city", label: "City", autoComplete: "address-level2" },
  { key: "region", label: "State", autoComplete: "address-level1" },
  { key: "postalCode", label: "ZIP code", autoComplete: "postal-code" },
];

export function PapersSettings() {
  const announce = useAnnounce();
  const api = papersApi();
  const [folder, setFolder] = useState(currentFolder());
  const [folderError, setFolderError] = useState<string | null>(null);
  const [cloud, setCloud] = useState(cloudExplainAllowed());
  const [form, setForm] = useState<Flat>(() => flatten(loadDetails()));
  const [savedNote, setSavedNote] = useState<string | null>(null);
  const [signature, setSignature] = useState(loadSignature());
  const [sigError, setSigError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void refreshFolder().then(setFolder);
    return onFolderChange(() => setFolder(currentFolder()));
  }, []);

  const choose = async (choice: PapersFolderChoice) => {
    if (!api) return;
    setFolderError(null);
    try {
      const f = await api.chooseFolder(choice);
      setCurrentFolder(f);
      if (f) announce(`Papers uses ${f.display}.`);
    } catch (err) {
      setFolderError(plainError(err));
    }
  };

  const save = () => {
    const f = form;
    const clean = saveDetails({
      fullName: f.fullName,
      preferredName: f.preferredName,
      dateOfBirth: f.dateOfBirth,
      phone: f.phone,
      email: f.email,
      address: { line1: f.line1, line2: f.line2, city: f.city, region: f.region, postalCode: f.postalCode },
    });
    setForm(flatten(clean));
    setSavedNote(clean ? "Saved on this computer." : "Nothing saved: all the boxes are empty.");
    announce("Details saved.");
  };

  const onSignature = (file: File | undefined) => {
    setSigError(null);
    if (!file) return;
    if (!/^image\/(png|jpeg)$/.test(file.type))
      return setSigError("Choose a PNG or JPEG picture of the signature.");
    if (file.size > MAX_SIGNATURE_BYTES) return setSigError("That picture is too big. Use one under 400 KB.");
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result ?? "");
      saveSignature(url);
      setSignature(loadSignature());
    };
    reader.readAsDataURL(file);
  };

  return (
    <Page label="Papers settings">
      <div className="page-head">
        <div>
          <div className="eyebrow">Settings · For a helper</div>
          <h1>Papers</h1>
          <p>Letters, forms and signatures. Everything here stays on this computer.</p>
        </div>
        <button className="btn" onClick={() => navigate("/settings/helper")} data-dwell>
          <Icon name="back" /> Back
        </button>
      </div>

      <section className="stack" aria-label="Folder">
        <h2>
          <Icon name="document" /> The Papers folder
        </h2>
        {api ? (
          <>
            <p>
              {folder
                ? `Papers shows the PDFs and photos in ${folder.display}, newest first, and saves filled and signed copies there. Nothing else on the computer is opened.`
                : "No folder is chosen yet, so Papers shows practice documents. Choose the folder where letters and forms are saved."}
            </p>
            <div className="row">
              <button className="btn" onClick={() => void choose("papers")} data-dwell>
                Use Documents, AGENCY Papers
              </button>
              <button className="btn" onClick={() => void choose("downloads")} data-dwell>
                Use Downloads
              </button>
              <button className="btn" onClick={() => void choose("pick")} data-dwell>
                Choose a folder…
              </button>
              {folder && (
                <button
                  className="btn"
                  onClick={() =>
                    void api
                      .clearFolder()
                      .then(() => setCurrentFolder(null))
                      .catch((err: unknown) => setFolderError(plainError(err)))
                  }
                  data-dwell
                >
                  Stop using a folder
                </button>
              )}
            </div>
            {folderError && (
              <p className="papers-error" role="alert">
                {folderError}
              </p>
            )}
          </>
        ) : (
          <p>
            In a web browser, AGENCY can't see the computer's folders. On the Papers screen a helper opens
            each document with the file picker, or drops it on the screen; filled and signed copies are
            downloaded.
          </p>
        )}
      </section>

      <section className="stack" aria-label="Explaining letters">
        <h2>
          <Icon name="sparkle" /> Explaining letters
        </h2>
        <Toggle
          label="Explain letters with Gemini"
          value={cloud}
          onChange={(v) => {
            setCloudExplain(v);
            setCloud(v);
          }}
          help={
            cloud
              ? "Only a letter's text is sent, and only after the person agrees on screen each time"
              : "Nothing is sent. AGENCY shows basic dates and amounts found on this computer"
          }
        />
      </section>

      <section className="stack" aria-label="Details for forms">
        <h2>
          <Icon name="name" /> Details for forms
        </h2>
        <p>
          Papers offers these as answers when a form asks for them; the person picks each one and checks them
          all before anything is saved. Leave out anything they wouldn't want used. Never add passwords, card
          or ID numbers: AGENCY doesn't fill those.
        </p>
        <form
          className="grid grid-2"
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
        >
          {FIELDS.map((f) => (
            <label key={f.key} className="field">
              <strong>{f.label}</strong>
              <input
                type={f.type ?? "text"}
                autoComplete={f.autoComplete}
                maxLength={200}
                value={form[f.key]}
                onChange={(e) => setForm({ ...form, [f.key]: e.target.value })}
              />
            </label>
          ))}
          <div className="row">
            <button className="btn btn-primary" type="submit" data-dwell>
              <Icon name="check" /> Save details
            </button>
            <button
              className="btn"
              type="button"
              onClick={() => {
                saveDetails(null);
                setForm(flatten(null));
                setSavedNote("Forgotten.");
              }}
              data-dwell
            >
              Forget these details
            </button>
            {savedNote && (
              <span className="muted" role="status">
                {savedNote}
              </span>
            )}
          </div>
        </form>
      </section>

      <section className="stack" aria-label="Signature">
        <h2>
          <Icon name="edit" /> Signature
        </h2>
        <p>
          A picture of the person's signature (PNG or JPEG, under 400 KB), used only when they sign a document
          and confirm it twice. Without one, Papers offers their typed name, clearly marked as a typed
          signature.
        </p>
        {signature && <img className="papers-signature-preview" src={signature} alt="The saved signature" />}
        <div className="row">
          <button className="btn" onClick={() => fileRef.current?.click()} data-dwell>
            {signature ? "Choose another picture" : "Add a signature picture"}
          </button>
          {signature && (
            <button
              className="btn"
              onClick={() => {
                saveSignature(null);
                setSignature(null);
              }}
              data-dwell
            >
              Remove it
            </button>
          )}
        </div>
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg"
          className="sr-only"
          aria-label="Choose a signature picture"
          onChange={(e) => {
            onSignature(e.target.files?.[0]);
            e.target.value = "";
          }}
        />
        {sigError && (
          <p className="papers-error" role="alert">
            {sigError}
          </p>
        )}
      </section>
    </Page>
  );
}
