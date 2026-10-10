import { chromium, expect } from '@playwright/test';
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/Users/ray/Library/Caches/ms-playwright/chromium-1248/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing', headless: true });
try {
  const source = await browser.newPage({ javaScriptEnabled: false });
  await source.goto('http://localhost:3000');
  await expect(source.locator('.connection')).toContainText('LOCAL KERNEL');
  await expect(source.locator('.telemetry-strip')).toContainText('/ 6 installed');
  await expect(source.locator('.telemetry-strip')).toContainText('1.000 applied / 1.00 cap');
  await expect(source.locator('.telemetry-strip')).toContainText('Loaded from kernel');
  await expect(source.locator('.vault-cards')).not.toContainText('CHECKING FILES');
  await expect(source.locator('.vault-cards')).not.toContainText('Checking adapters');
  await source.close();
  for (const host of ['localhost', '127.0.0.1']) {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('requestfailed', request => {
      if (request.url().includes('/_next/static/')) errors.push(`Failed asset: ${request.url()}`);
    });
    page.on('response', response => {
      if (response.url().includes('/_next/static/') && response.status() >= 400) errors.push(`Asset HTTP ${response.status()}: ${response.url()}`);
    });
    await page.goto(`http://${host}:3000`);
    await expect(page.locator('.connection')).toContainText('LOCAL KERNEL', { timeout: 30000 });
    await expect(page.locator('button.run')).toBeEnabled({ timeout: 30000 });
    await expect(page.locator('.telemetry-strip')).toContainText('WebSocket live', { timeout: 30000 });
    await expect(page.locator('.telemetry-strip')).toContainText('/ 6 installed');
    await expect(page.locator('.telemetry-strip')).toContainText('1.000 applied / 1.00 cap');
    if (errors.length) throw new Error(errors.join('\n'));
    await page.close();
  }

  const fallback = await browser.newPage();
  await fallback.routeWebSocket('**/kernel/ws/weights', () => {});
  await fallback.goto('http://localhost:3000');
  await expect(fallback.locator('.connection')).toContainText('LOCAL KERNEL');
  await expect(fallback.locator('button.run')).toBeEnabled({ timeout: 20000 });
  const nextPrompt = 'Write a Python sorting function with unit tests.';
  const updated = fallback.waitForResponse(response => response.url().endsWith('/kernel/intent') && response.request().method() === 'POST' && response.request().postDataJSON().prompt === nextPrompt);
  await fallback.locator('#prompt').fill(nextPrompt);
  const intentResponse = await updated;
  expect(intentResponse.ok()).toBe(true);
  const intent = await intentResponse.json();
  await expect(fallback.locator('.expert-card.coding .expert-relevance')).toContainText(`${(intent.weights.coding * 100).toFixed(1)}% contribution`);
  await expect(fallback.locator('.telemetry-strip')).toContainText('Kernel weights loaded');
  await expect(fallback.locator('.telemetry-strip')).toContainText('1.000 applied / 1.00 cap');
  console.log('PASS: initial HTML already contains real kernel health, six adapters, and normalized weights with JavaScript disabled; both hosts hydrate, connect over WebSocket, and enable fusion; stalled WebSocket retains HTTP weights.');
} finally { await browser.close(); }
