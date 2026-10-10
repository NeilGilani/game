import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';

const baseURL = process.env.SYNAPSE_UI_URL || 'http://127.0.0.1:3000';
const browser = await chromium.launch({ headless: true,
  ...(process.env.SYNAPSE_BROWSER_PATH ? { executablePath: process.env.SYNAPSE_BROWSER_PATH } : {}) });
const checked = [];
try {
  const page = await browser.newPage();
  const response = await page.request.get(`${baseURL}/kernel/health`);
  assert.ok(response.ok());
  const health = await response.json();
  for (const name of ['coding', 'medical', 'legal']) {
    const adapter = health.vault.find(row => row.name === name);
    assert.ok(adapter.available, `${name} is unavailable`);
    assert.ok(adapter.path.startsWith('/'));
    assert.equal(adapter.weights_path, `${adapter.path}/adapter_model.safetensors`);
    assert.equal(adapter.config_path, `${adapter.path}/adapter_config.json`);
    assert.deepEqual(adapter.missing_files, []);
  }
  await page.goto(baseURL);
  for (const name of ['coding', 'medical', 'legal']) {
    await page.locator(`.expert-card.${name} .expert-bottom small`).filter({ hasText: 'r8 / 70 steps' }).waitFor();
    assert.match(await page.locator(`.expert-card.${name} .expert-bottom`).innerText(), /ON DISK|FACTORS CACHED/);
  }
  assert.ok(!(await page.locator('.vault-cards').innerText()).includes('Awaiting adapter'));
  checked.push('Real health resolves all three adapters to absolute safetensors paths');
  await mkdir('../artifacts', { recursive: true });
  await page.screenshot({ path: '../artifacts/vault-ready.png' });

  const metadataFree = { ...health, vault: health.vault.map(row => ({ ...row, metadata: null })) };
  await page.route('**/kernel/health', route => route.fulfill({ json: metadataFree }));
  await page.reload();
  await page.locator('.expert-card.coding .expert-bottom small').filter({ hasText: 'Adapter ready' }).waitFor();
  checked.push('Existing adapter without optional training metadata remains ready');

  await page.unroute('**/kernel/health');
  await page.route('**/kernel/health', route => route.fulfill({ json: {
    ...health, vault: health.vault.map(row => row.name === 'coding'
      ? { ...row, available: false, missing_files: ['adapter_model.safetensors'] } : row),
  } }));
  await page.reload();
  await page.locator('.expert-card.coding .expert-bottom small').filter({ hasText: 'Missing adapter files' }).waitFor();
  assert.match(await page.locator('.expert-card.coding .expert-bottom').innerText(), /FILES MISSING/);
  checked.push('Missing weights are shown as missing even when training metadata exists');

  await page.unroute('**/kernel/health');
  let attempts = 0;
  await page.route('**/kernel/health', route => ++attempts === 1
    ? route.fulfill({ status: 503, json: { detail: 'Kernel restarting' } })
    : route.fulfill({ json: health }));
  await page.reload();
  await page.locator('.expert-card.coding .expert-bottom small').filter({ hasText: 'Kernel offline' }).waitFor();
  await page.locator('.expert-card.coding .expert-bottom small').filter({ hasText: 'r8 / 70 steps' }).waitFor({ timeout: 12000 });
  checked.push('Transient health failure recovers automatically without a page reload');
  await writeFile('../artifacts/vault-check.json', JSON.stringify({ checked,
    adapters: health.vault.slice(0, 3), timestamp: new Date().toISOString() }, null, 2));
  console.log(checked.join('\n'));
} finally {
  await browser.close();
}
