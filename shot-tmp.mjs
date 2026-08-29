import { chromium } from 'playwright';
const out = '/tmp/claude-1000/-home-lucanepa-repos-svrz-rc/09b0b25e-9093-419e-aacf-c0beca95c01c/scratchpad';
const b = await chromium.launch();
for (const [name, w, h] of [['m', 390, 844], ['d', 1100, 900]]) {
  const p = await b.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 2 });
  await p.goto('http://localhost:3111/#/demo', { waitUntil: 'networkidle' });
  await p.waitForTimeout(2000);
  await p.getByText(/Next appointments/).scrollIntoViewIfNeeded();
  await p.locator('div.space-y-1\\.5 > div').first().locator('button').first().click();
  await p.waitForTimeout(1500);
  const both = p.getByRole('button', { name: /^Both$/ });
  if (await both.count()) { await both.first().click(); await p.waitForTimeout(600); }
  await p.screenshot({ path: `${out}/sr-${name}.png`, clip: { x: 0, y: 0, width: Math.min(w, 800), height: 340 } });
  await p.close();
}
await b.close();
