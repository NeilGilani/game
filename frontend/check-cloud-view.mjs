import { chromium, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import assert from 'node:assert/strict';

// An isolated delayed HTTP cluster stub tests real transport measurements;
// saved model events test rendering. This does not contact a real Outshift GPU.
const fixture = JSON.parse(await readFile('../artifacts/tensor-pivot-comparison.json', 'utf8'));
let healthStatus = 200;
let executionLocation = 'cloud';
let compareRequests = 0;
const network = { state: 'OPTIMAL', source: 'mock', network_cap: 1, revision: 0, utilization: .1, latency_ms: 9999, sampled_at: 0, detail: 'Test telemetry', latency_kind: 'Management latency fixture' };
const intent = { weights: { coding: .4, medical: .3, legal: .3 }, ideal_weights: { coding: .4, medical: .3, legal: .3 }, active_experts: ['coding', 'medical', 'legal'], evidence: {}, excluded: {}, network, fusion_mode: 'Ultra-Fusion', network_cap: 1 };
const cluster = createServer(async (req, res) => {
  if (req.url === '/health') {
    await new Promise(resolve => setTimeout(resolve, 85));
    res.writeHead(healthStatus, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ status: 'ready', device: 'cuda', base_model: 'test/base', network, vault: ['coding', 'medical', 'legal'].map(name => ({ name, label: { coding: 'Code', medical: 'Clinical', legal: 'Legal' }[name], source: 'local', available: true, loaded: true, metadata: { rank: 8 } })) }));
  }
  if (req.url === '/compare') {
    compareRequests++;
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
    const events = fixture.events.map(event => ({ ...event,
      ...(event.event === 'fusion' ? { fusion_mode: 'Ultra-Fusion' } : {}),
      ...(['fused', 'complete'].includes(event.event) ? { execution: { location: executionLocation } } : {}),
    }));
    return res.end(events.map(event => JSON.stringify(event)).join('\n') + '\n');
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(req.url === '/intent' ? intent : req.url === '/network' ? network : req.url?.startsWith('/catalog') ? { models: [], items: [] } : []));
});
cluster.listen(0, '127.0.0.1');
await once(cluster, 'listening');
const cloudUrl = `http://127.0.0.1:${cluster.address().port}`;
const uiPort = Number(process.env.SYNAPSE_TEST_UI_PORT || 3017);
const previewArgs = ['node_modules/next/dist/bin/next', 'dev', '--webpack', '--hostname', '127.0.0.1', '--port', String(uiPort)];
let ui = spawn(process.execPath, previewArgs, { env: { ...process.env, SYNAPSE_CLOUD_API_URL: cloudUrl, SYNAPSE_API_URL: cloudUrl }, stdio: 'ignore' });
const url = `http://127.0.0.1:${uiPort}`;
let browser;
try {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${url}/api/cloud-status`)).ok) break; } catch {}
    if (ui.exitCode !== null) throw new Error('Preview failed to start');
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(url);
  await expect(page.locator('.connection')).toContainText('ONLINE · OUTSHIFT CLUSTER');
  await expect(page.locator('.cloud-state')).toHaveText('Connected');
  const health = await (await page.request.get(`${url}/api/cloud-status`)).json();
  assert.ok(health.health_rtt_ms >= 80, 'RTT must measure the real delayed health response');
  assert.notEqual(health.health_rtt_ms, network.latency_ms, 'Do not reuse management latency');
  await expect(page.locator('.data-packet')).toHaveCount(2);
  await expect(page.locator('button.run')).toBeEnabled({ timeout: 20000 });
  await page.locator('button.run').click();
  await expect(page.locator('.mesh-output .output-title>span')).toHaveText('Cloud-Accelerated');
  await expect(page.locator('.mesh-output pre')).toBeVisible();
  await expect(page.locator('.comparison-network>strong')).toHaveText(/\d+\.\d ms/);
  const latency = Number((await page.locator('.comparison-network>strong').innerText()).replace(' ms', ''));
  assert.ok(latency >= 80 && latency !== 9999);
  assert.equal(compareRequests, 1);
  await page.screenshot({ path: '../artifacts/cloud-view-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: '../artifacts/cloud-view-mobile.png', fullPage: true });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(await page.locator('.data-packet').first().evaluate(el => getComputedStyle(el).animationName), 'none');
  // An HTTP 201 is reachable but must never count as ONLINE.
  healthStatus = 201;
  await expect(page.locator('.connection')).toContainText('CLOUD OFFLINE', { timeout: 15000 });
  await expect(page.locator('.data-packet')).toHaveCount(0);
  assert.equal((await (await page.request.get(`${url}/api/cloud-status`)).json()).health_rtt_ms, null);
  healthStatus = 200;
  executionLocation = 'edge';
  await expect(page.locator('.connection')).toContainText('ONLINE', { timeout: 15000 });
  healthStatus = 503;
  await expect(page.locator('.cloud-state')).toHaveText('Disconnected', { timeout: 15000 });
  // Without cloud configuration, local results must retain local provenance,
  // show no invented network latency, and never turn the cloud header ONLINE.
  ui.kill('SIGTERM');
  if (ui.exitCode === null) await once(ui, 'exit');
  healthStatus = 200;
  ui = spawn(process.execPath, previewArgs, { env: { ...process.env, SYNAPSE_CLOUD_API_URL: '', SYNAPSE_API_URL: cloudUrl }, stdio: 'ignore' });
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${url}/api/cloud-status`)).ok) break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  await page.goto(url);
  await expect(page.locator('.cloud-state')).toHaveText('Not configured');
  await expect(page.locator('.connection')).toContainText('CONNECTING TO KERNEL');
  await expect(page.locator('.data-packet')).toHaveCount(0);
  await expect(page.locator('button.run')).toBeEnabled({ timeout: 20000 });
  await page.locator('button.run').click();
  await expect(page.locator('.mesh-output .output-title>span')).toHaveText('EDGE / LOCAL FALLBACK');
  await expect(page.locator('.comparison-network>strong')).toHaveText('—');
  assert.deepEqual(errors, []);
  const result = { status: 'passed', cluster: 'isolated HTTP stub, not real Outshift', comparison: 'saved inference fixture', measured_transport_rtt_ms: latency, exact_200_online: true, disconnect_recovery: true, honest_local_fallback: true, mobile_overflow: false, reduced_motion: true, javascript_errors: errors };
  await writeFile('../artifacts/cloud-view-check.json', JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result));
} finally {
  await browser?.close();
  ui.kill('SIGTERM');
  if (ui.exitCode === null) await once(ui, 'exit');
  cluster.closeAllConnections();
  await new Promise(resolve => cluster.close(resolve));
}
