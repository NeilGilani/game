import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', error => errors.push(error.message));
page.on('response', response => {
  if (response.url().includes('/_next/') && response.status() >= 400)
    errors.push(`Asset ${response.status()}: ${response.url()}`);
});
const url = process.env.SYNAPSE_UI_URL || 'http://127.0.0.1:3000';
const prompts = ['Write a Python function to sort a list',
  'Explain diagnosis and treatment of a patient with diabetes'];
const vectors = [];
try {
  await page.goto(url);
  const manual = page.getByRole('checkbox', { name: 'Manual weights', exact: true });
  await manual.waitFor();
  assert.equal(await manual.isDisabled(), false);
  for (const prompt of prompts) {
    const intent = await page.request.post(`${url}/kernel/intent`, { data: { prompt } });
    assert.equal(intent.status(), 200);
    const expected = (await intent.json()).weights;
    await page.locator('#prompt').fill(prompt);
    await page.waitForFunction(expected => Object.entries(expected).every(([name, weight]) => {
      const card = Array.from(document.querySelectorAll('.expert-card')).find(el => el.classList.contains(name));
      return card && (weight > 0
        ? card.querySelector('.expert-relevance').textContent.includes(`${(weight * 100).toFixed(1)}%`)
        : !card.querySelector('input').checked);
    }), expected);
    vectors.push(expected);
  }
  assert.notDeepEqual(vectors[0], vectors[1]);
  await manual.check();
  const slider = page.getByRole('slider', { name: 'Code weight', exact: true });
  assert.equal(await slider.isDisabled(), false);
  await slider.fill('0.7');
  assert.match(await page.locator('.expert-card.coding .expert-relevance').innerText(), /70.0%/);
  const total = await page.locator('.weight-controls input').evaluateAll(inputs =>
    inputs.reduce((sum, input) => sum + Number(input.value), 0));
  assert.ok(Math.abs(total - 1) < 1e-6);
  // Verify the UI forwards the slider mixture. Generation is mocked here.
  let submitted;
  await page.route('**/api/compare', async route => {
    submitted = route.request().postDataJSON();
    await route.fulfill({ contentType: 'application/x-ndjson',
      body: JSON.stringify({ event: 'error', message: 'Browser payload check complete' }) + '\n' });
  });
  await page.getByRole('button', { name: 'Fuse & compare' }).click();
  await page.getByText('Browser payload check complete', { exact: true }).waitFor();
  assert.equal(submitted.weights.coding, .7);
  assert.ok(Math.abs(Object.values(submitted.weights).reduce((a, b) => a + b, 0) - 1) < 1e-6);
  await page.unroute('**/api/compare');
  await manual.uncheck();
  // Exercise the HTTP fallback and surface classifier failures.
  await page.routeWebSocket('**/ws/weights', ws => ws.close());
  await page.reload();
  const intentResponse = page.waitForResponse(r => r.url().endsWith('/kernel/intent') && r.status() === 200);
  await page.locator('#prompt').fill(prompts[0]);
  const fallback = await (await intentResponse).json();
  await page.waitForFunction(() => document.querySelector('.expert-card.coding .expert-relevance')?.textContent.includes('%'));
  await page.route('**/kernel/intent', route => route.fulfill({ status: 503,
    contentType: 'application/json', body: JSON.stringify({ detail: 'Sifter temporarily unavailable' }) }));
  await page.locator('#prompt').fill('Another prompt while the Sifter is unavailable');
  await page.getByRole('alert').filter({ hasText: 'Sifter temporarily unavailable' }).waitFor();
  await manual.check();
  assert.equal(await page.getByRole('slider', { name: 'Code weight', exact: true }).isDisabled(), false);
  assert.deepEqual(errors, []);
  const result = { passed: true, prompt_vectors: vectors, manual_payload: submitted,
    http_fallback_weights: fallback.weights, manual_after_sifter_failure: true,
    javascript_or_asset_errors: errors, generation: 'mocked for payload verification' };
  await writeFile('../artifacts/dynamic-weights-browser-check.json', JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result));
} finally { await browser.close(); }
