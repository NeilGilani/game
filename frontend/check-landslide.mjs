import { chromium, expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';

const prompt = 'Draft a legally binding Software License Agreement for a new AI-driven surgical robot, but write it as a medical prescription that a surgeon would read, ensuring it maintains strict legal enforceability while using clinical terminology to describe the technical constraints of the hardware.';
const balanced = process.argv.includes('--balanced');
const prefix = balanced ? 'landslide-balanced' : 'landslide';
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/Users/ray/Library/Caches/ms-playwright/chromium-1248/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('http://localhost:3000');
  const intentResponse = page.waitForResponse(response => response.url().endsWith('/kernel/intent') && response.request().postDataJSON()?.prompt === prompt);
  // Read the same classifier through HTTP, while the dashboard uses its live socket.
  let intent = await page.evaluate(async prompt => {
    const response = await fetch('/kernel/intent', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt }) });
    if (!response.ok) throw new Error(`Intent HTTP ${response.status}`);
    return response.json();
  }, prompt);
  await intentResponse;
  await page.locator('#prompt').fill(prompt);
  await expect(page.locator('.expert-card.legal .expert-relevance')).toContainText(`${(intent.weights.legal * 100).toFixed(1)}% contribution`);
  if (balanced) {
    await page.getByRole('checkbox', { name: 'Manual weights', exact: true }).check();
    for (const name of Object.keys(intent.weights).filter(name => !['coding', 'medical', 'legal'].includes(name))) {
      const checkbox = page.locator(`.expert-card.${name} input[type="checkbox"]`);
      if (await checkbox.isChecked()) await checkbox.uncheck();
    }
    intent = { ...intent, weights: Object.fromEntries(Object.keys(intent.weights).map(name => [name, ['coding', 'medical', 'legal'].includes(name) ? 1 / 3 : 0])), active_experts: ['coding', 'medical', 'legal'] };
  }
  const ui = {};
  for (const [name, weight] of Object.entries(intent.weights)) {
    const card = page.locator(`.expert-card.${name}`);
    if (weight > 0) {
      await expect(card).toHaveClass(/adapter-active/);
      await expect(card.locator('.expert-relevance')).toContainText(`${(weight * 100).toFixed(1)}% contribution`);
    } else await expect(card).toHaveClass(/adapter-idle/);
    ui[name] = { coefficient: weight > 0 ? await page.getByRole('slider', { name: `${await card.locator('h3').textContent()} weight` }).inputValue() : '0', display: await card.locator('.expert-relevance').textContent() };
  }
  await expect(page.locator('.fusion-beam')).toHaveCount(intent.active_experts.length);
  const animation = await page.locator('.fusion-beam').first().evaluate(element => getComputedStyle(element).animationName);
  expect(animation).toBe('neural-flow');
  await page.getByRole('combobox', { name: 'Generation token limit' }).selectOption('512');
  const compared = page.waitForResponse(response => response.url().endsWith('/api/compare'));
  await page.locator('button.run').click();
  await expect(page.locator('.audit')).toHaveCount(1, { timeout: 180000 });
  await expect(page.locator('.neural-core')).toHaveClass(/processing/);
  await page.locator('.neural-core').screenshot({ path: `../artifacts/${prefix}-core-processing.png` });
  await expect(page.locator('.phase')).toContainText('Comparison complete', { timeout: 240000 });
  const response = await compared;
  const events = (await response.text()).trim().split('\n').map(line => JSON.parse(line));
  await writeFile(`../artifacts/${prefix}-events.json`, JSON.stringify({ prompt, events }, null, 2));
  const byEvent = Object.fromEntries(events.map(event => [event.event, event]));
  const fusion = events.find(event => event.event === 'fusion');
  expect(byEvent.complete.base_restored).toBe(true);
  expect(fusion.adapter_forward_branches).toBe(0);
  expect(fusion.disk_writes).toBe(0);
  expect(fusion.device).toMatch(/^mps(?::0)?$/);
  for (const name of ['coding', 'medical', 'legal']) {
    expect(fusion.loaded_adapters).toContain(name);
    expect(fusion.layers.some(layer => layer.delta_norms[name] > 0)).toBe(true);
  }
  let coefficientError = 0;
  for (const [name, weight] of Object.entries(byEvent.fused.token_schedule?.[0]?.weights || byEvent.intent.weights)) {
    coefficientError = Math.max(coefficientError, Math.abs(Number(ui[name].coefficient) - weight), Math.abs(fusion.weights[name] - weight));
    expect(fusion.weights[name]).toBeCloseTo(weight, 7);
    if (weight > 0) expect(Number(ui[name].coefficient)).toBeCloseTo(weight, 7);
  }
  const sample = fusion.matrix_sample;
  let matrixError = 0;
  let changedSampleValues = 0;
  for (let row = 0; row < 6; row++) for (let col = 0; col < 6; col++) {
    const expected = sample.base[row][col] + Object.values(sample.contributions).reduce((total, contribution) => total + contribution[row][col], 0);
    matrixError = Math.max(matrixError, Math.abs(expected - sample.fused[row][col]));
    if (sample.base[row][col] !== sample.fused[row][col]) changedSampleValues++;
  }
  expect(matrixError).toBeLessThan(.002);
  expect(changedSampleValues).toBeGreaterThan(0);
  expect(byEvent.fused.text).not.toBe(byEvent.baseline.text);
  expect(errors).toEqual([]);
  await page.screenshot({ path: `../artifacts/${prefix}-comparison.png`, fullPage: true });
  const report = { prompt, mode: balanced ? 'manual balanced three-adapter trial' : 'automatic semantic intent', max_new_tokens: 512, events, ui, symmetry: { coefficient_max_error: coefficientError, sample_matrix_max_error: matrixError, changed_sample_values: changedSampleValues }, visualization: { beams: intent.active_experts.length, animation, processing_verified: true }, javascript_errors: errors, passed: true };
  await writeFile(`../artifacts/${prefix}-audit.json`, JSON.stringify(report, null, 2));
  for (const name of ['baseline', 'fused']) await writeFile(`../artifacts/${prefix}-${name}.txt`, byEvent[name].text);
  console.log(JSON.stringify({ passed: true, weights: fusion.weights, layers: fusion.layer_count, symmetry: report.symmetry, timing: byEvent.complete.timing, baseline: byEvent.baseline.text, fused: byEvent.fused.text }, null, 2));
} finally { await browser.close(); }
