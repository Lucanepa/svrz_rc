import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_ROUTE_PREFIXES } from '../src/lib/routes';

/**
 * public/_redirects, checked against the routes the app actually emits.
 *
 * Routes live in the path now, which means the EDGE has to know them: a request
 * for /games is a request Cloudflare answers before any JavaScript runs, and a
 * route it has never heard of is a 404 on reload. Nothing in the build catches
 * that — the app works perfectly until somebody presses F5.
 *
 * Reading the file rather than deploying it is the same trade docs-reader.spec.ts
 * makes: it cannot prove Cloudflare's behaviour, but it can prove the file says
 * what we think it says, and that is where this goes wrong.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const REDIRECTS = readFileSync(join(HERE, '..', 'public', '_redirects'), 'utf8');

/** [from, to, status] for every rule, comments and blanks dropped. */
const RULES = REDIRECTS.split('\n')
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith('#'))
  .map((l) => l.split(/\s+/));

test('every route the app can emit is one the edge will serve', () => {
  for (const prefix of APP_ROUTE_PREFIXES) {
    const exact = RULES.some(([from]) => from === `/${prefix}`);
    expect(exact, `/${prefix} has no rule in public/_redirects`).toBe(true);
  }
});

test('the routes that carry an id also match their children', () => {
  // /games/<coacheeId>, /form/<gameId>/1sr, /feedbacks/<c>/<o>, /admin/<tab>…
  for (const prefix of ['coachees', 'games', 'form', 'feedbacks', 'admin', 'guide']) {
    const wild = RULES.some(([from]) => from === `/${prefix}/*`);
    expect(wild, `/${prefix}/* has no rule in public/_redirects`).toBe(true);
  }
});

/**
 * The one that matters most.
 *
 * A catch-all is the obvious way to make an SPA work on Pages, and it is the
 * outage. Cloudflare evaluates _redirects BEFORE looking for a file — their
 * docs say "Redirects are always followed, regardless of whether or not an
 * asset matches the incoming request" — so `/*  /index.html  200` shadows
 * /assets/index-<hash>.js too. _headers marks /assets/* immutable for a year,
 * so the edge caches the shell under a script URL and every client goes blank
 * until somebody purges it. That happened on 12.08.2026; a redeploy did not fix
 * it. And the guard you would reach for is unavailable: _redirects supports no
 * non-3xx/200 status, so no `/assets/* … 404` rule can sit in front.
 */
test('there is no catch-all, and there never may be', () => {
  const catchAll = RULES.filter(([from]) => from === '/*' || from === '/**');
  expect(catchAll, 'a catch-all in _redirects shadows /assets/* — see the comment in the file').toEqual([]);
});

test('nothing rewrites the asset namespaces', () => {
  for (const [from] of RULES) {
    expect(from.startsWith('/assets'), `${from} would shadow a fingerprinted asset`).toBe(false);
    expect(from.startsWith('/img'), `${from} would shadow an image`).toBe(false);
  }
});

/**
 * Survey and signature links are capabilities: whoever opens one answers as
 * that referee. They stay in the URL fragment, which is never transmitted, so
 * no token-shaped path exists to be logged at the edge, sent as a Referer, or
 * opened by a mail scanner. A rule here would be the first step to undoing it.
 */
test('no rule exists for the two roots that keep their token in the fragment', () => {
  for (const [from] of RULES) {
    expect(/^\/(sign|survey)\b/.test(from), `${from} would put a token in a path`).toBe(false);
  }
});

test('the old GitHub Pages subpath still redirects, and still comes first', () => {
  const dynamic = RULES.filter(([from]) => from.includes('*'));
  expect(dynamic[0]).toEqual(['/svrz_rc/*', '/:splat', '301']);
});

test('every rule is a 200 rewrite or a 301, which is all Pages supports here', () => {
  for (const rule of RULES) {
    expect(rule.length, `malformed rule: ${rule.join(' ')}`).toBe(3);
    expect(['200', '301', '302', '307', '308']).toContain(rule[2]);
  }
});

test('the rule count stays inside Cloudflare\'s limits', () => {
  const dynamic = RULES.filter(([from]) => from.includes('*'));
  const staticRules = RULES.length - dynamic.length;
  expect(dynamic.length).toBeLessThanOrEqual(100);
  expect(staticRules).toBeLessThanOrEqual(2000);
});

/**
 * public/404.html is the other half of the arrangement: it is what makes an
 * unknown path a real 404 instead of a 200 full of HTML. Deleting it is the
 * one-line way to make path routing "just work" — Pages then treats the site as
 * an SPA and serves index.html at 200 for everything — and it is the same
 * outage by a different road.
 */
test('404.html still exists', () => {
  const html = readFileSync(join(HERE, '..', 'public', '404.html'), 'utf8');
  expect(html).toContain('<!doctype html>');
});
