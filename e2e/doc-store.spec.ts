import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect } from '@playwright/test';
import { readStoredDoc, writeStoredDoc, type StoredDoc } from '../server/docstore';
import { stubSignedInApp } from './support/app';
import { USEFUL_DOCS } from '../src/lib/usefulDocs';

// 21.10.2026: svrz.ch answered every PDF "503 no available server" a few hours
// after a deploy had emptied the proxy's memory-only copies, and one coach's
// login asked for all ~30 SVRZ sheets in a row and logged ~30 failures.

const doc = (body: string): StoredDoc => ({
  body: Buffer.from(body), etag: 'W/"e-p2"', upstreamEtag: '"e"', checkedAt: 1_700_000_000_000, preface: 2,
});

test.describe('the proxied documents kept on disk', () => {
  let dir = '';
  test.beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'doc-store-'));
    process.env.DOC_CACHE_DIR = dir;
  });
  test.afterEach(() => {
    delete process.env.DOC_CACHE_DIR;
    rmSync(dir, { recursive: true, force: true });
  });

  test('a copy written is the copy read back, with what it was revalidated by', async () => {
    await writeStoredDoc('kurz-sr', doc('%PDF-1.7 bytes'));
    const back = await readStoredDoc('kurz-sr');
    expect(back?.body.toString()).toBe('%PDF-1.7 bytes');
    expect(back).toMatchObject({ etag: 'W/"e-p2"', upstreamEtag: '"e"', checkedAt: 1_700_000_000_000, preface: 2 });
    // No temp files left behind.
    expect(readdirSync(dir).sort()).toEqual(['kurz-sr.json', 'kurz-sr.pdf']);
  });

  test('a PDF that does not match its meta is no copy at all', async () => {
    await writeStoredDoc('zm', doc('%PDF-1.7 the first'));
    writeFileSync(join(dir, 'zm.pdf'), '%PDF-1.7 a different, longer body');
    expect(await readStoredDoc('zm')).toBeNull();
  });

  test('nothing stored, no directory, or an id that is not ours reads as nothing', async () => {
    expect(await readStoredDoc('gbo')).toBeNull();
    await writeStoredDoc('../escape', doc('%PDF-'));
    expect(readdirSync(dir)).toEqual([]);
    delete process.env.DOC_CACHE_DIR;
    await writeStoredDoc('gbo', doc('%PDF-'));
    expect(await readStoredDoc('gbo')).toBeNull();
  });
});

test('the idle prefetch asks a failing source once, not once per document', async ({ page }) => {
  await stubSignedInApp(page);
  const asked: string[] = [];
  await page.route(/\/api\/docs\//, (r) => {
    asked.push(r.request().url());
    return r.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"Dokument nicht verfügbar."}' });
  });

  // One small proxied document per upstream site is the most it may ask for.
  const hosts = new Set(USEFUL_DOCS
    .filter((d) => d.proxyId && (d.bytes || 0) <= 600_000)
    .map((d) => new URL(d.href).host));
  expect(hosts.size).toBeGreaterThan(0);
  expect(USEFUL_DOCS.filter((d) => d.proxyId && (d.bytes || 0) <= 600_000).length).toBeGreaterThan(hosts.size);

  await page.goto('/coachees');
  await expect.poll(() => asked.length, { timeout: 25_000 }).toBe(hosts.size);
  // Give a prefetch that would carry on the time to show it.
  await page.waitForTimeout(3_000);
  expect(asked.length).toBe(hosts.size);
});
