import { chromium } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

// Weights use the real API and WebSocket proxy. Comparison rendering replays
// historical inference evidence; this check does not run or claim new inference.
const fixture = JSON.parse(await readFile('../artifacts/tensor-pivot-comparison.json', 'utf8'));
const events = Array.isArray(fixture.events) ? fixture.events :
  Object.values(fixture.events);
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
await page.addInitScript(() => {
  window.__weightSockets = [];
  const OriginalWebSocket = window.WebSocket;
  window.WebSocket = class extends OriginalWebSocket {
    constructor(...args) { super(...args); window.__weightSockets.push(this); }
  };
});
const url = process.env.SYNAPSE_UI_URL || 'http://127.0.0.1:3015';
try {
  await page.goto(url);
  await page.getByText('● WebSocket live').waitFor({ timeout: 15000 });
  const socketsBefore = await page.evaluate(() => window.__weightSockets.length);
  await page.evaluate(() => window.__weightSockets.at(-1).close());
  await page.waitForFunction(count => window.__weightSockets.length > count &&
    window.__weightSockets.at(-1).readyState === WebSocket.OPEN, socketsBefore);
  await page.getByText('● WebSocket live').waitFor();
  await page.waitForFunction(() => !document.querySelector('button.run').disabled);
  await page.locator('#prompt').fill('Write a Python function to validate JSON');
  await page.waitForFunction(() => document.querySelector('.expert-card.coding .expert-relevance')?.textContent.includes('% contribution'));
  await page.waitForTimeout(600);
  const before = await page.locator('.expert-card.coding .expert-relevance').innerText();
  await page.locator('#prompt').fill('Explain medical clinical consent and legal obligations');
  await page.waitForFunction(old => document.querySelector('.expert-card.coding .expert-relevance')?.textContent !== old, before);
  assert.ok(await page.locator('.fusion-beam').count() >= 2);
  await page.getByRole('checkbox', { name: 'Manual weights', exact: true }).check();
  const coding = page.getByRole('checkbox', { name: 'Include Code in fusion', exact: true });
  if (!await coding.isChecked()) await coding.check();
  await page.getByRole('slider', { name: 'Code weight', exact: true }).fill('0.5');
  assert.match(await page.locator('.expert-card.coding .expert-relevance').innerText(), /50.0%/);
  const vector = await page.locator('.weight-controls input').evaluateAll(sliders => sliders.reduce((sum, el) => sum + Number(el.value), 0));
  assert.ok(Math.abs(vector - 1) < .015);
  await page.getByRole('checkbox', { name: 'Manual weights', exact: true }).uncheck();
  await page.route('**/api/compare', route => route.fulfill({
    contentType: 'application/x-ndjson', body: events.map(e => JSON.stringify(e)).join('\n') + '\n',
  }));
  await page.getByRole('button', { name: 'Fuse & compare' }).click();
  await page.getByText('✓ BASE WEIGHTS RESTORED').waitFor();
  assert.equal(await page.locator('.output pre').count(), 2);
  await page.getByRole('heading', { name: 'Standard AI', exact: true }).waitFor();
  await page.getByRole('heading', { name: 'Fused AI', exact: true }).waitFor();
  await page.screenshot({ path: '../artifacts/visualizer-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: '../artifacts/visualizer-mobile.png', fullPage: true });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(await page.locator('.fusion-beam').first().evaluate(el => getComputedStyle(el).animationName), 'none');
  assert.deepEqual(errors, []);
  const result = { status: 'passed', real_websocket_weights: true, reconnect: true, comparison: 'historical fixture replay',
    mobile_overflow: false, reduced_motion: true, javascript_errors: errors };
  await writeFile('../artifacts/visualizer-check.json', JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result));
} finally { await browser.close(); }
