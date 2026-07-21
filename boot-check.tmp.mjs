import { chromium } from '@playwright/test';

const BASE = process.env.BASE || 'http://localhost:3003';

const run = async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 430, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  const api = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('request', (r) => { if (r.url().includes('/api/')) api.push(`${r.method()} ${r.url().replace(BASE, '')}`); });

  await page.goto(`${BASE}/#/demo`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);

  const shot = async (name) => page.screenshot({ path: `/tmp/claude-1000/-home-lucanepa-repos-svrz-rc/1fe3dc49-1be5-4c57-8e17-d6d60dea4989/scratchpad/${name}.png`, fullPage: false });

  await shot('01-home');
  const tabs = ['Coachee', 'Spiel', 'Referee Coach'];
  const labels = await page.locator('button').allInnerTexts();
  console.log('TAB BUTTONS:', labels.filter((l) => l.trim()).slice(0, 12));

  for (const [i, name] of [['coachees', 1], ['games', 2], ['rc', 3]].entries()) { void i; void name; }

  // Click each of the 4 top tabs by position within the tab grid
  const tabGrid = page.locator('div.grid.grid-cols-2 > button, div.sm\\:grid-cols-4 > button');
  const count = await tabGrid.count();
  console.log('tab grid count', count);

  const clickTab = async (text) => {
    const b = page.getByRole('button', { name: text, exact: false }).first();
    await b.click();
    await page.waitForTimeout(900);
  };

  for (const [label, file] of [['Coachee-Pool', '02-coachees'], ['Spiel-Pool', '03-games'], ['Referee Coaches', '04-rc']]) {
    try { await clickTab(label); await shot(file); } catch (e) { console.log('tab fail', label, String(e).slice(0, 120)); }
  }

  console.log('\nAPI CALLS:\n' + (api.length ? api.join('\n') : '(none — demo mode)'));
  console.log('\nCONSOLE ERRORS:\n' + (errors.length ? errors.join('\n') : '(none)'));
  await browser.close();
};

run().catch((e) => { console.error(e); process.exit(1); });
