import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
const prompt = 'Draft a legally binding Software License Agreement for a new AI-driven surgical robot, but write it as a medical prescription that a surgeon would read, ensuring it maintains strict legal enforceability while using clinical terminology to describe the technical constraints of the hardware.';
const browser = await chromium.launch({ executablePath: process.env.SYNAPSE_BROWSER_PATH });
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
const errors = []; page.on('pageerror', e => errors.push(e.message));
try {
  await page.goto('http://127.0.0.1:3000');
  await page.waitForFunction(() => !document.querySelector('button.run')?.disabled, null, { timeout: 60000 });
  await page.locator('#prompt').fill(prompt);
  await page.waitForFunction(() => document.querySelector('.legal .expert-relevance')?.textContent.includes('46.9'), null, { timeout: 30000 });
  const chineseCheckbox = page.getByRole('checkbox', { name: 'Include chinese-text-correction-1.5b-lora in fusion', exact: true });
  assert.equal(await chineseCheckbox.isChecked(), false);
  assert.equal(await chineseCheckbox.isDisabled(), true);
  await page.getByLabel('Generation token limit').selectOption('512');
  const request = page.waitForResponse(r => r.url().endsWith('/api/compare'));
  const wallStart = performance.now();
  await page.getByRole('button', { name: 'Fuse & compare' }).click();
  await page.waitForFunction(() => document.querySelector('.status-tag')?.textContent.includes('RESTORED') || document.querySelector('.error[role=alert]'), null, { timeout: 240000 });
  if (await page.locator('.error[role=alert]').count()) throw new Error(await page.locator('.error[role=alert]').first().innerText());
  const clientWallMs = performance.now() - wallStart;
  const events = (await (await request).text()).trim().split('\n').map(line => JSON.parse(line));
  const intent = events.find(e => e.event === 'intent');
  const audit = events.find(e => e.event === 'fusion');
  const complete = events.find(e => e.event === 'complete');
  const timing = complete.timing;
  const chinese = Object.keys(intent.weights).find(name => name !== 'coding' && name !== 'legal' && name !== 'medical' && intent.excluded[name]?.includes('Chinese'));
  assert.ok(chinese); assert.equal(intent.weights[chinese], 0);
  assert.ok(!audit.loaded_adapters.includes(chinese));
  assert.equal(audit.compute_dtype, 'float16'); assert.equal(audit.base_dtype, 'float16');
  assert.equal(audit.adapter_forward_branches, 0); assert.equal(audit.disk_writes, 0);
  assert.ok(audit.lazy_loading); assert.ok(audit.factor_pairs_loaded > 0);
  assert.ok(audit.layers.some(row => Object.values(row.delta_norms).filter(v => v > 0).length >= 3));
  assert.ok(timing.fused_total_ms >= timing.fusion_ms + timing.fused_generation_ms + timing.restore_ms);
  assert.ok(timing.comparison_wall_ms >= timing.baseline_total_ms + timing.fused_total_ms);
  assert.ok(Math.abs(clientWallMs - timing.comparison_wall_ms) < 2500);
  const displayed = await page.locator('.mesh-output .output-stats strong').innerText();
  assert.equal(displayed, `${(timing.fused_total_ms / 1000).toFixed(2)} s pipeline`);
  assert.ok((await page.locator('.mesh-output .output-breakdown').innerText()).includes('Fusion overhead'));
  await page.getByText('Inspect the actual matrix changes').click();
  await page.screenshot({ path: '../artifacts/tensor-pivot-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: '../artifacts/tensor-pivot-mobile.png', fullPage: true });
  // A prompt change changes participating experts, without changing the base.
  await page.locator('#prompt').fill('Correct Chinese spelling and grammar.');
  await page.waitForFunction(() => Array.from(document.querySelectorAll('.expert-card')).find(card => card.className.includes('hub_6a3f9e02cc1f'))?.querySelector('input')?.checked, null, { timeout: 30000 });
  assert.equal(await chineseCheckbox.isChecked(), true);
  // Manual mixtures remain an explicit user override, not automatic selection.
  await page.getByLabel('Manual weights').check();
  assert.equal(await chineseCheckbox.isDisabled(), false);
  assert.equal(errors.length, 0, errors.join('\n'));
  await fs.writeFile('../artifacts/tensor-pivot-comparison.json', JSON.stringify({ prompt, events }, null, 2));
  const result = { passed: true, prompt, engine: 'raw-tensor-fusion', precision: audit.compute_dtype,
    activeExperts: intent.active_experts, chineseExcluded: true, dynamicPromptChanges: true,
    layers: audit.layer_count, clientWallMs, timing, mobileOverflow: false, javascriptErrors: errors };
  await fs.writeFile('../artifacts/tensor-pivot-browser-check.json', JSON.stringify(result, null, 2));
  console.log(result);
} finally { await browser.close(); }
