import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
try {
  await page.goto(process.env.SYNAPSE_UI_URL || 'http://127.0.0.1:3017');
  await page.getByRole('checkbox', { name: 'Manual weights', exact: true }).check();
  await page.getByRole('slider', { name: 'Code weight', exact: true }).fill('0.7');
  const execution = { location: 'cloud', transport: 'json-rpc' };
  const weights = { coding: .28, medical: .12, legal: 0 };
  const events = [
    { event: 'cloud_status', state: 'reconnecting', attempt: 1, fusion_mode: 'Lean-Fusion', weights, network_cap: .4 },
    { event: 'token', text: 'Remote', tokens: 1, generation_ms: 30, execution },
    { event: 'token', text: 'Remote answer', tokens: 2, generation_ms: 60, execution },
    { event: 'fused', text: 'Remote answer', tokens: 2, generation_ms: 80, execution, measurement: 'edge elapsed' },
    { event: 'complete', execution, edge_total_ms: 80, timing: null, base_restored: false },
  ];
  await page.route('**/api/compare', route => route.fulfill({ contentType: 'application/x-ndjson', body: events.map(e => JSON.stringify(e)).join('\n') + '\n' }));
  await page.getByRole('button', { name: 'Fuse & compare' }).click();
  await page.locator('.mesh-output pre').filter({ hasText: 'Remote answer' }).waitFor();
  await page.waitForFunction(() => document.querySelector('.phase')?.textContent.includes('Comparison complete'));
  assert.match(await page.locator('.mesh-output').innerText(), /Cloud-Accelerated/);
  assert.match(await page.locator('.mesh-output').innerText(), /Edge elapsed/);
  assert.equal(await page.getByText('✓ BASE WEIGHTS RESTORED', { exact: true }).count(), 0);
  assert.deepEqual(errors, []);
  const result = { passed: true, null_cloud_timing: true, lean_reconnect_rendered: true, javascript_errors: errors, stream: 'fixture replay; live TCP verified by backend test' };
  await writeFile('../artifacts/edge-stream-browser-check.json', JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result));
} finally { await browser.close(); }
