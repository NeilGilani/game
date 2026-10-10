import { chromium, expect } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/Users/ray/Library/Caches/ms-playwright/chromium-1248/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing', headless: true });
try {
  const page = await browser.newPage();
  await page.request.post('http://localhost:3000/kernel/network/mock', { data: { state: 'OPTIMAL' } });
  await page.goto('http://localhost:3000');
  await expect(page.locator('.fusion-mode')).toHaveText('Ultra-Fusion');
  await page.getByRole('checkbox', { name: 'Manual weights', exact: true }).check();
  const clinical = page.getByRole('slider', { name: 'Clinical weight', exact: true });
  await clinical.press('End');
  for (let index = 0; index < 20; index++) await clinical.press('ArrowLeft');
  await expect(page.locator('.expert-card.medical .expert-relevance')).toContainText('80.0% contribution');
  const requested = Number(await clinical.inputValue());
  await page.getByRole('button', { name: 'Trigger congestion', exact: true }).click();
  await expect(page.locator('.fusion-mode')).toHaveText('Lean-Fusion');
  await expect(page.locator('.expert-card.medical .expert-relevance')).toContainText('32.0% contribution');
  await expect(clinical).toBeDisabled();
  await page.getByRole('button', { name: 'Trigger critical', exact: true }).click();
  await expect(page.locator('.fusion-mode')).toHaveText('Critical-Fusion');
  await expect(page.locator('.budget-equation')).toContainText('argmax');
  await expect(page.locator('.expert-card.medical .expert-relevance')).toContainText('10.0% contribution');
  await page.getByRole('button', { name: 'Disconnect network', exact: true }).click();
  await expect(page.locator('.fusion-mode')).toHaveText('Safe-Mode');
  await expect(page.locator('.expert-card.generalist .expert-relevance')).toContainText('10.0% contribution');
  await page.getByRole('button', { name: 'Restore network', exact: true }).click();
  await expect(page.locator('.fusion-mode')).toHaveText('Ultra-Fusion');
  await expect(page.locator('.expert-card.medical .expert-relevance')).toContainText('80.0% contribution');
  expect(Number(await clinical.inputValue())).toBeCloseTo(requested, 6);
  const report = JSON.parse(await readFile('../artifacts/network-fusion-check.json', 'utf8'));
  report.manual_mixture_preserved = true;
  await writeFile('../artifacts/network-fusion-check.json', JSON.stringify(report, null, 2));
  console.log('PASS: manual 80% clinical intent spends 32% under congestion, 10% alone when critical, 10% generalist while offline, and restores to 80% after network recovery.');
} finally { await browser.close(); }
