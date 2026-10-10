import { chromium, expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';

const prompt = 'Draft a legally binding Software License Agreement for a new AI-driven surgical robot, but write it as a medical prescription that a surgeon would read, ensuring it maintains strict legal enforceability while using clinical terminology to describe the technical constraints of the hardware.';
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/Users/ray/Library/Caches/ms-playwright/chromium-1248/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing', headless: true });
let page;
try {
  page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error' && /hydration|hydrated|uncaught/i.test(message.text())) errors.push(message.text()); });
  await page.request.post('http://localhost:3000/kernel/network/mock', { data: { state: 'OPTIMAL' } });
  await page.goto('http://localhost:3000');
  await expect(page.locator('.connection')).toContainText('LOCAL KERNEL');
  await page.locator('#prompt').fill(prompt);
  await page.getByRole('combobox', { name: 'Generation token limit' }).selectOption('32');
  await expect(page.locator('.fusion-mode')).toHaveText('Ultra-Fusion');
  await expect(page.locator('button.run')).toBeEnabled();
  const responsePromise = page.waitForResponse(response => response.url().endsWith('/kernel/compare'));
  await page.locator('button.run').click();
  await expect(page.locator('.fusion-budget>.subtle')).toContainText('Token', { timeout: 90000 });
  for (const [state, mode, cap, button] of [
    ['CONGESTED', 'Lean-Fusion', .4, 'Trigger congestion'],
    ['CRITICAL', 'Critical-Fusion', .1, 'Trigger critical'],
    ['OFFLINE', 'Safe-Mode', .1, 'Disconnect network'],
    ['OPTIMAL', 'Ultra-Fusion', 1, 'Restore network'],
  ]) {
    const control = page.getByRole('button', { name: button, exact: true });
    await expect(control).toBeEnabled();
    await control.click();
    await expect(page.locator('.fusion-mode')).toHaveText(mode, { timeout: 45000 });
    await expect(page.locator('.budget-total')).toContainText(`${cap.toFixed(3)} / ${cap.toFixed(3)}`);
    if (state === 'CRITICAL' || state === 'OFFLINE') await expect(page.locator('.fusion-beam')).toHaveCount(1);
    await page.screenshot({ path: `../artifacts/token-budget-${state.toLowerCase()}.png`, fullPage: true });
    console.log(`${state}: ${mode} applied live during decoding; cap ${cap}.`);
  }
  await expect(page.locator('.phase')).toContainText('Comparison complete', { timeout: 180000 });
  const response = await responsePromise;
  const events = (await response.text()).trim().split('\n').map(line => JSON.parse(line));
  const data = Object.fromEntries(events.map(event => [event.event, event]));
  expect(data.error).toBeUndefined();
  expect(data.fused.token_level).toBe(true);
  expect(data.fused.tokens).toBe(32);
  expect(data.complete.base_restored).toBe(true);
  const steps = events.filter(event => event.event === 'token_fusion');
  expect(steps).toHaveLength(32);
  expect(events.filter(event => event.event === 'token')).toHaveLength(32);
  const states = [...new Set(steps.map(step => step.network.state))];
  for (const state of ['OPTIMAL', 'CONGESTED', 'CRITICAL', 'OFFLINE']) expect(states).toContain(state);
  expect(data.fused.token_schedule.map(step => step.weights)).toEqual(steps.map(step => step.weights));
  let audit;
  for (const event of events) {
    if (event.event === 'fusion') {
      audit = event;
      expect(audit.device).toMatch(/^mps/);
      expect(audit.adapter_forward_branches).toBe(0);
      expect(audit.disk_writes).toBe(0);
      expect(audit.layers.some(layer => Object.values(layer.delta_norms).some(value => value > 0))).toBe(true);
    }
    if (event.event !== 'token_fusion') continue;
    const sum = Object.values(event.weights).reduce((a,b) => a+b, 0);
    expect(sum).toBeCloseTo(event.network_cap, 6);
    expect(audit.weights).toEqual(event.weights);
    expect(audit.loaded_adapters).toEqual(event.active_experts);
    if (event.network.state === 'CRITICAL') {
      expect(event.active_experts).toHaveLength(1);
      expect(Object.values(event.weights).filter(value => value > 0)).toEqual([.1]);
    } else if (event.network.state === 'OFFLINE') {
      expect(event.active_experts).toEqual(['generalist']);
    } else {
      const totalIdeal = Object.values(event.ideal_weights).reduce((a,b) => a+b, 0);
      for (const name of event.adapter_order) expect(event.weights[name]).toBeCloseTo(event.ideal_weights[name] / totalIdeal * event.network_cap, 7);
    }
    if (event.kernel_updated) expect(event.cache_action).toBe('rebuild');
  }
  const final = steps.at(-1);
  // After completion the preview returns to prompt-only intent, while the
  // retained ledger keeps every actual generated-token vector unchanged.
  await expect(page.locator('.token-ledger summary')).toContainText('32 TOKENS');
  await expect(page.locator('.fusion-budget>.subtle')).toContainText('Preview');
  expect(data.fused.final_audit.token_index).toBe(31);
  expect(data.fused.final_audit.weights).toEqual(final.weights);
  await page.locator('.token-ledger summary').click();
  await expect(page.locator('.token-ledger tbody tr')).toHaveCount(32);
  const lastRow = page.locator('.token-ledger tbody tr').last();
  for (const [name, value] of Object.entries(final.weights).filter(([,value]) => value > 0)) {
    await expect(lastRow).toContainText(String(value));
  }
  await expect(page.locator('.output pre')).toHaveCount(2);
  expect(data.complete.timing.fused_total_ms).toBeGreaterThanOrEqual(data.complete.timing.fusion_ms + data.complete.timing.fused_generation_ms + data.complete.timing.restore_ms);
  await page.screenshot({ path: '../artifacts/token-budget-complete.png', fullPage: true });
  const noJs = await browser.newPage({ javaScriptEnabled: false });
  await noJs.goto('http://localhost:3000');
  await expect(noJs.locator('.connection')).toContainText('LOCAL KERNEL');
  await expect(noJs.locator('.fusion-budget')).toContainText('1.000 / 1.000');
  await noJs.close();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
  const report = { passed: true, prompt, states, javascript_errors: errors, token_count: steps.length,
    cache_rebuilds: data.fused.cache_rebuilds, cache_reuses: data.fused.cache_reuses,
    kernel_updates: data.fused.kernel_updates, timing: data.complete.timing, events };
  await writeFile('../artifacts/token-budget-check.json', JSON.stringify(report, null, 2));
  await writeFile('../artifacts/token-budget-outputs.txt', `PROMPT\n${prompt}\n\nSTANDARD AI\n${data.baseline.text}\n\nFUSED AI\n${data.fused.text}\n`);
  console.log(`PASS: ${steps.length} real GPU tokens; live network transitions; exact caps and kernel coefficients; restored base; streamed outputs; SSR and mobile. ${data.fused.kernel_updates} updates, ${data.fused.cache_rebuilds} cache rebuilds, ${data.fused.cache_reuses} reuses.`);
} finally {
  if (page) await page.request.post('http://localhost:3000/kernel/network/mock', { data: { state: 'OPTIMAL' } }).catch(() => {});
  await browser.close();
}
