import { chromium, expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';

const prompt = 'Draft a legally binding Software License Agreement for a new AI-driven surgical robot, but write it as a medical prescription that a surgeon would read, ensuring it maintains strict legal enforceability while using clinical terminology to describe the technical constraints of the hardware.';
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/Users/ray/Library/Caches/ms-playwright/chromium-1248/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing', headless: true });
const results = [];
let page;
try {
  page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error' && /hydration|hydrated|uncaught/i.test(message.text())) errors.push(message.text()); });
  await page.goto('http://localhost:3000');
  await expect(page.locator('.connection')).toContainText('LOCAL KERNEL');
  await page.locator('#prompt').fill(prompt);
  await page.getByRole('combobox', { name: 'Generation token limit' }).selectOption('16');
  for (const [state, mode, button] of [
    ['OPTIMAL', 'Ultra-Fusion', 'Restore network'],
    ['CONGESTED', 'Lean-Fusion', 'Trigger congestion'],
    ['CRITICAL', 'Critical-Fusion', 'Trigger critical'],
    ['OFFLINE', 'Safe-Mode', 'Disconnect network'],
  ]) {
    await page.getByRole('button', { name: button, exact: true }).click();
    await expect(page.locator('.network-state')).toHaveText(state);
    await expect(page.locator('.fusion-mode')).toHaveText(mode, { timeout: 20000 });
    const intent = await page.evaluate(async prompt => {
      const response = await fetch('/kernel/intent', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt }) });
      if (!response.ok) throw new Error(`Intent HTTP ${response.status}`);
      return response.json();
    }, prompt);
    expect(intent.fusion_mode).toBe(mode);
    await expect(page.locator('.fusion-beam')).toHaveCount(intent.active_experts.length);
    if (state === 'OPTIMAL') for (const name of ['coding', 'medical', 'legal']) expect(intent.weights[name]).toBeGreaterThan(0);
    if (state === 'CONGESTED') {
      expect(intent.active_experts.length).toBeGreaterThan(1);
      expect(Object.values(intent.weights).reduce((a,b) => a+b,0)).toBeCloseTo(.4, 6);
    }
    if (state === 'CRITICAL') { expect(intent.active_experts).toEqual(['legal']); expect(intent.weights.legal).toBe(.1); }
    if (state === 'OFFLINE') {
      expect(intent.active_experts).toEqual(['generalist']);
      expect(intent.weights.generalist).toBe(.1);
      expect(intent.ideal_weights.generalist).toBe(1);
      await expect(page.locator('.expert-card.generalist')).toHaveClass(/adapter-active/);
    }
    for (const name of intent.active_experts) {
      const card = page.locator(`.expert-card.${name}`);
      await expect(card.locator('.expert-relevance')).toContainText(`${(intent.weights[name] * 100).toFixed(1)}% contribution`);
    }
    const responsePromise = page.waitForResponse(response => response.url().endsWith('/kernel/compare'));
    await expect(page.locator('button.run')).toBeEnabled();
    await page.locator('button.run').click();
    await expect(page.getByRole('button', { name: 'Trigger congestion', exact: true })).toBeEnabled();
    await expect(page.locator('.phase')).toContainText('Comparison complete', { timeout: 180000 });
    const response = await responsePromise;
    const events = (await response.text()).trim().split('\n').map(line => JSON.parse(line));
    const data = Object.fromEntries(events.map(event => [event.event, event]));
    expect(data.error).toBeUndefined();
    expect(data.network.network.state).toBe(state);
    expect(data.fusion.fusion_mode).toBe(mode);
    expect(data.fusion.network.state).toBe(state);
    const lastStep = data.fused.token_schedule.at(-1);
    expect(data.fusion.loaded_adapters).toEqual(lastStep.active_experts);
    expect(data.fusion.device).toMatch(/^mps/);
    expect(data.fusion.adapter_forward_branches).toBe(0);
    expect(data.fusion.disk_writes).toBe(0);
    expect(data.complete.base_restored).toBe(true);
    for (const name of lastStep.active_experts) {
      expect(data.fusion.layers.some(layer => layer.delta_norms[name] > 0)).toBe(true);
      expect(data.fusion.weights[name]).toBeCloseTo(lastStep.weights[name], 6);
    }
    if (state === 'OFFLINE') {
      expect(data.fusion.factor_pairs_loaded).toBe(0);
      expect(data.fusion.factor_cache_hits).toBeGreaterThan(0);
    }
    await expect(page.locator('.output pre')).toHaveCount(2);
    await page.screenshot({ path: `../artifacts/network-${state.toLowerCase()}.png`, fullPage: true });
    results.push({ state, mode, weights: data.fusion.weights, active_adapters: data.fusion.loaded_adapters, matrix_count: data.fusion.layer_count, events });
    console.log(`${state}: ${mode}, ${data.fusion.loaded_adapters.length} adapters, ${data.fusion.layer_count} matrices, real GPU comparison completed.`);
  }
  // Restoring the link restores the full vector without editing the prompt.
  await page.getByRole('button', { name: 'Restore network', exact: true }).click();
  await expect(page.locator('.fusion-mode')).toHaveText('Ultra-Fusion');
  await expect(page.locator('.fusion-beam')).toHaveCount(results[0].active_adapters.length);
  await expect(page.locator('.core-topline')).toContainText('WEIGHT PREVIEW');
  // Manual intent is retained underneath network overrides, not fed back from
  // the one-hot applied vector. This catches a destructive Lean→Ultra loop.
  await page.getByRole('checkbox', { name: 'Manual weights', exact: true }).check();
  const clinical = page.getByRole('slider', { name: 'Clinical weight', exact: true });
  await clinical.press('End');
  for (let index = 0; index < 20; index++) await clinical.press('ArrowLeft');
  await expect(page.locator('.expert-card.medical .expert-relevance')).toContainText('80.0% contribution');
  const requested = Number(await clinical.inputValue());
  await page.getByRole('button', { name: 'Trigger congestion', exact: true }).click();
  await expect(page.locator('.fusion-mode')).toHaveText('Lean-Fusion');
  await expect(page.locator('.expert-card.medical .expert-relevance')).toContainText('32.0% contribution');
  await page.getByRole('button', { name: 'Restore network', exact: true }).click();
  await expect(page.locator('.fusion-mode')).toHaveText('Ultra-Fusion');
  await expect(page.locator('.expert-card.medical .expert-relevance')).toContainText('80.0% contribution');
  expect(Number(await clinical.inputValue())).toBeCloseTo(requested, 6);
  const noJs = await browser.newPage({ javaScriptEnabled: false });
  await noJs.goto('http://localhost:3000');
  await expect(noJs.locator('.network-state')).toHaveText('OPTIMAL');
  await expect(noJs.locator('.fusion-mode')).toHaveText('Ultra-Fusion');
  await expect(noJs.locator('.telemetry-strip')).toContainText('1.000 applied / 1.00 cap');
  await noJs.close();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
  await writeFile('../artifacts/network-fusion-check.json', JSON.stringify({ passed: true, prompt, modes: results, javascript_errors: errors, network_recovery: true, manual_mixture_preserved: true, server_rendered_network_state: true }, null, 2));
  console.log('PASS: all four modes, cached offline factors, real GPU fusion, network recovery, server HTML, and mobile layout.');
} finally {
  if (page) await page.request.post('http://localhost:3000/kernel/network/mock', { data: { state: 'OPTIMAL' } }).catch(() => {});
  await browser.close();
}
