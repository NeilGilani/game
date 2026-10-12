/**
 * Papers on real documents in a plain browser: a helper opens a PDF, the person has a letter explained (the coordinator
 * here has no cloud model, so the honest basics), fills in a form from saved details and signs it in one place. Every
 * saved copy is downloaded and read back. Turning Gemini off in Settings means nothing is sent at all.
 */
import { readFileSync } from "node:fs";
import { type Page, expect, test } from "@playwright/test";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { Coordinator } from "./backend";

const coordinator = new Coordinator();
test.beforeAll(async () => coordinator.start());
test.afterAll(async () => coordinator.stop());
test.beforeEach(async ({ context }) => {
  await context.addInitScript(() => {
    localStorage.setItem("agency.onboarded", "1");
    localStorage.setItem("agency.fakes", "memory,agent,native");
    localStorage.setItem(
      "agency.papers.details",
      JSON.stringify({ fullName: "Ada Lovelace", preferredName: "Ada", phone: "+1 555 0100" }),
    );
  });
});

async function letter(): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const p = pdf.addPage([612, 792]);
  [
    "Lane County Water Utility",
    "Dear Ada Lovelace,",
    "Your water bill for September is $86.40. Please pay by November 15, 2026.",
    "If payment is not received, a late fee of $12.00 will be added.",
  ].forEach((l, i) => p.drawText(l, { x: 64, y: 740 - i * 22, size: 12, font }));
  return Buffer.from(await pdf.save());
}

async function form(): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const p = pdf.addPage([612, 792]);
  const f = pdf.getForm();
  p.drawText("Library card application", { x: 64, y: 740, size: 16, font });
  f.createTextField("full_name").addToPage(p, { x: 64, y: 672, width: 300, height: 22 });
  f.createTextField("phone").addToPage(p, { x: 64, y: 622, width: 300, height: 22 });
  f.createCheckBox("large_print").addToPage(p, { x: 64, y: 578, width: 16, height: 16 });
  p.drawText("Signature: ______________________", { x: 64, y: 200, size: 12, font });
  return Buffer.from(await pdf.save());
}

const pick = (page: Page, name: string | RegExp) => page.getByRole("button", { name }).first().click();

async function open(page: Page, action: string, name: string, bytes: Buffer) {
  await page.goto("/#/flow/papers");
  await pick(page, action);
  await page
    .locator('input[type="file"]')
    .setInputFiles({ name, mimeType: "application/pdf", buffer: bytes });
  await pick(page, new RegExp(`^${name.replace(".pdf", "")}`));
}

test("explain a letter: say what is sent first, then only facts with their lines", async ({ page }) => {
  const sent: string[] = [];
  page.on("request", (r) => r.url().includes("/api/assist/letter") && sent.push(r.postData() ?? ""));
  await open(page, "Explain a letter", "Water bill.pdf", await letter());
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "This letter's text will be sent to Gemini to explain it. Nothing else.",
  );
  expect(sent).toHaveLength(0); // nothing before the yes
  await pick(page, /Yes, explain it/);
  const explained = page.getByTestId("papers-explained");
  // This coordinator has no cloud model: the basics, and it says so.
  await expect(explained).toContainText("Gemini isn't set up");
  await expect(explained).toContainText("Possible deadline: November 15, 2026");
  await expect(explained).toContainText("From the letter:");
  expect(sent).toHaveLength(1);
  expect(JSON.parse(sent[0]!)).toEqual({ text: expect.stringContaining("Lane County Water Utility") });

  // A helper turns Gemini off: nothing is sent at all.
  await page.goto("/#/settings/papers");
  await pick(page, /Explain letters with Gemini/);
  await open(page, "Explain a letter", "Water bill.pdf", await letter());
  await pick(page, /Show me the basics/);
  await expect(page.getByTestId("papers-explained")).toContainText("turned off in Settings");
  expect(sent).toHaveLength(1);
});

test("fill in a form from saved details, check it, save a new copy", async ({ page }) => {
  await open(page, "Fill in a form", "Library card form.pdf", await form());
  await expect(page.getByTestId("papers-field")).toContainText("Your saved full name");
  await pick(page, /^Ada Lovelace/);
  await pick(page, /^\+1 555 0100/);
  await pick(page, /Yes, tick it/);
  const review = page.getByTestId("papers-review");
  await expect(review).toContainText("Ada Lovelace");
  await expect(review).toContainText("Ticked");
  await pick(page, /Save a filled copy/);
  const confirm = page.getByRole("button", { name: /Yes, save the copy/ });
  await expect(confirm).toBeEnabled({ timeout: 5000 });
  const download = page.waitForEvent("download");
  await confirm.click();
  const file = await download;
  expect(file.suggestedFilename()).toBe("Library card form-filled.pdf");
  await expect(page.getByTestId("papers-saved")).toContainText("Saved. A caregiver can send it.");
  const filled = (await PDFDocument.load(readFileSync((await file.path())!))).getForm();
  expect(filled.getTextField("full_name").getText()).toBe("Ada Lovelace");
  expect(filled.getTextField("phone").getText()).toBe("+1 555 0100");
  expect(filled.getCheckBox("large_print").isChecked()).toBe(true);
});

test("sign in one chosen place, after two deliberate yeses; Stop ends it", async ({ page }) => {
  await open(page, "Sign a document", "Library card form.pdf", await form());
  await pick(page, /Next to "Signature"/);
  await pick(page, /Your typed name: Ada Lovelace/);
  await expect(page.getByTestId("papers-sign-confirm")).toContainText("What signing means");
  await pick(page, /Yes, I want to sign/);
  const sign = page.getByRole("button", { name: /Sign it now/ });
  await expect(sign).toBeEnabled({ timeout: 5000 });
  const download = page.waitForEvent("download");
  await sign.click();
  const file = await download;
  expect(file.suggestedFilename()).toBe("Library card form-signed.pdf");
  await expect(page.getByTestId("papers-saved")).toContainText("Only page 1 was signed");
  const signed = await PDFDocument.load(readFileSync((await file.path())!));
  expect(signed.getPageCount()).toBe(1);

  // Stop at the last check: nothing is signed or saved.
  await open(page, "Sign a document", "Library card form.pdf", await form());
  await pick(page, /Next to "Signature"/);
  await pick(page, /Your typed name: Ada Lovelace/);
  await pick(page, /Yes, I want to sign/);
  let downloads = 0;
  page.on("download", () => downloads++);
  await pick(page, /^Stop$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Stopped. Nothing more was done.");
  expect(downloads).toBe(0);
});
