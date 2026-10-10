import { chromium, expect } from '@playwright/test';

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || '/Users/ray/Library/Caches/ms-playwright/chromium-1248/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  headless: true,
});
try {
  const page = await browser.newPage();
  let offline = true;
  await page.route('**/kernel/health', route => offline
    ? route.fulfill({ status: 503, contentType: 'application/json', body: '{"detail":"Simulated outage"}' })
    : route.continue());
  await page.goto('http://127.0.0.1:3000');
  const status = page.locator('.connection');
  const run = page.getByRole('button', { name: /Fuse & compare/i });
  await expect(status).toContainText('KERNEL OFFLINE');
  await expect(run).toBeDisabled();
  offline = false;
  await expect(status).toContainText('LOCAL KERNEL', { timeout: 15000 });
  await expect(run).toBeEnabled({ timeout: 15000 });
  offline = true;
  await expect(status).toContainText('KERNEL OFFLINE', { timeout: 15000 });
  await expect(run).toBeDisabled();
  offline = false;
  await expect(status).toContainText('LOCAL KERNEL', { timeout: 15000 });
  await expect(run).toBeEnabled({ timeout: 15000 });
  await page.route('**/kernel/compare', route => route.fulfill({ status: 500, body: 'Simulated inference failure' }));
  await run.click();
  await expect(page.locator('.error[role="alert"]')).toContainText('Kernel request failed (500).');
  await page.getByRole('button', { name: 'Refresh kernel status' }).click();
  await expect(status).toContainText('LOCAL KERNEL');
  await expect(page.locator('.error[role="alert"]')).toContainText('Kernel request failed (500).');
  console.log('PASS: startup recovery, outage detection, automatic reconnection, button readiness, and inference error preservation.');
} finally {
  await browser.close();
}
