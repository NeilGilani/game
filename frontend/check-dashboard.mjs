import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const browser = await chromium.launch({ headless: true,
  ...(process.env.SYNAPSE_BROWSER_PATH ? { executablePath: process.env.SYNAPSE_BROWSER_PATH } : {}) });
const page = await browser.newPage({ viewport: { width: 1440, height: 1080 } });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const baseURL = process.env.SYNAPSE_UI_URL || 'http://127.0.0.1:3000';
await mkdir('../artifacts', { recursive: true });
try {
  await page.goto(baseURL);
  await page.getByRole('button', { name: 'Fuse & compare' }).waitFor();
  await page.waitForFunction(() => !document.querySelector('button.run')?.disabled);
  // Preserve the original three-expert quality comparison as a regression check.
  await page.getByRole('checkbox', { name: 'Manual weights' }).check();
  const cloudSelections = page.locator('.vault-cards .expert-card[class*=hub_] input');
  for (const checkbox of await cloudSelections.all()) if (await checkbox.isChecked()) await checkbox.uncheck();
  await page.screenshot({ path: '../artifacts/dashboard-desktop.png', fullPage: true });
  await page.getByRole('checkbox', { name: 'Manual weights' }).check();
  await page.getByRole('slider', { name: 'Code weight' }).fill('0.5');
  const manual = await page.getByRole('slider', { name: 'Code weight' }).inputValue();
  assert.equal(Number(manual), .5);
  await page.getByRole('checkbox', { name: 'Manual weights' }).uncheck();
  await page.getByRole('combobox', { name: 'Choose a proof prompt' }).selectOption('retention-code');
  assert.match(await page.locator('#prompt').inputValue(), /legal hold/);
  await page.getByRole('combobox', { name: 'Generation token limit' }).selectOption('128');
  await page.getByRole('combobox', { name: 'Choose a proof prompt' }).selectOption('health-audit');
  await page.getByRole('combobox', { name: 'Generation token limit' }).selectOption('512');
  const observed = [];
  await page.exposeFunction('recordPhase', phase => observed.push(phase));
  await page.evaluate(() => {
    new MutationObserver(() => window.recordPhase(document.querySelector('.phase')?.textContent))
      .observe(document.querySelector('.phase'), { childList: true, characterData: true, subtree: true });
  });
  const streamResponse = page.waitForResponse(response => response.url().endsWith('/kernel/compare'));
  await page.getByRole('button', { name: 'Fuse & compare' }).click();
  await page.waitForFunction(() => document.body.textContent.includes('✓ BASE WEIGHTS RESTORED') || document.querySelector('.error[role="alert"]'), null, { timeout: 240000 });
  if (await page.locator('.error[role="alert"]').count()) throw new Error(await page.locator('.error[role="alert"]').innerText());
  assert.equal(await page.locator('.output pre').count(), 2);
  assert.ok(observed.some(p => p.includes('Generating with fused weights')));
  await page.getByText('Inspect the actual matrix changes').click();
  const events = (await (await streamResponse).text()).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(events.map(e => e.event), ['intent', 'loading', 'baseline', 'fusion', 'fused', 'complete']);
  const audit = events.find(e => e.event === 'fusion');
  const matrixRows = await page.locator('tbody tr').count();
  assert.equal(matrixRows, audit.layer_count);
  assert.ok(matrixRows > 0);
  assert.ok(audit.layers.some(layer => Object.values(layer.delta_norms).filter(norm => norm > 0).length >= 2));
  for (let row=0; row<6; row++) for (let column=0; column<6; column++) {
    const sample = audit.matrix_sample;
    const sum = sample.base[row][column] + Object.values(sample.contributions).reduce((sum, matrix) => sum + matrix[row][column], 0);
    assert.ok(Math.abs(sum-sample.fused[row][column]) < 2e-3, 'Half precision sample does not match the fusion equation');
  }
  assert.equal(errors.length, 0, errors.join('\n'));
  await page.screenshot({ path: '../artifacts/dashboard-comparison.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  assert.equal(overflow, false, 'Mobile layout overflows the viewport');
  await page.screenshot({ path: '../artifacts/dashboard-mobile.png', fullPage: true });
  const result = { status: 'passed', javascript_errors: errors, observed_phases: observed,
    real_generation: true, matrix_rows: matrixRows, device: audit.device, mobile_overflow: overflow };
  await writeFile('../artifacts/browser-check.json', JSON.stringify(result, null, 2)+'\n');
  console.log(JSON.stringify(result));
} finally { await browser.close(); }
