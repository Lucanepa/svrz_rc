import { test, expect } from '@playwright/test';
import {
  canonicalizeLegacyHash, parsePath, routeToPath, routeRoot, isForeignPath,
  adminTabFromPath, adminLogModeFromPath, guideLangFromPath,
  DEFAULT_ROUTE, APP_ROUTE_PREFIXES, type AppRoute,
} from '../src/lib/routes';

/**
 * The route table, tested without a browser — no `page` fixture here, the same
 * idiom as boerse-rules.spec.ts and games-sync-rules.spec.ts.
 *
 * These functions decide what the app shows for a given URL, and the app is
 * about to stop keeping its routes in the hash. The expensive half of that
 * change is not the switch itself, it is the promise that every link already
 * sent out keeps working — links in mail the server has already delivered, in
 * the retired GitHub Pages kill switch that can never be edited again, and in
 * home-screen icons captured months ago.
 */

const loc = (pathname: string, hash = '', search = '') => ({ pathname, hash, search });

test.describe('the legacy # redirect', () => {
  // The promise: every hash URL that ever worked reaches the same screen.
  const CARRIED_OVER = [
    ['#/home', '/home'],
    ['#/coachees', '/coachees'],
    ['#/games', '/games'],
    ['#/calendar', '/calendar'],
    ['#/form', '/form'],
    ['#/coachee-games', '/coachee-games'],
    ['#/admin', '/admin'],
    ['#/admin/niveau', '/admin/niveau'],
    ['#/guide', '/guide'],
    ['#/guide/de', '/guide/de'],
    ['#/demo', '/demo'],
    // ids ride along untouched
    ['#/games/kx82hd93jf0a1qp', '/games/kx82hd93jf0a1qp'],
    ['#/feedbacks/abc123/def456', '/feedbacks/abc123/def456'],
    // the leading slash is optional in the old form
    ['#admin', '/admin'],
  ];
  for (const [hash, path] of CARRIED_OVER) {
    test(`${hash} → ${path}`, () => {
      expect(canonicalizeLegacyHash(loc('/', hash))).toBe(path);
    });
  }

  test('a PocketBase id keeps its case', () => {
    // The ids are case-sensitive and they are the whole point of these routes.
    // Lowercasing the path — the obvious way to make root matching easy — would
    // turn every deep link into a 404 from the API.
    expect(canonicalizeLegacyHash(loc('/', '#/games/AbC123XyZ'))).toBe('/games/AbC123XyZ');
  });

  test('a query string survives', () => {
    expect(canonicalizeLegacyHash(loc('/', '#/games', '?view=calendar'))).toBe('/games?view=calendar');
  });

  // The two that must NOT move: their URL *is* the capability.
  test('a survey token is left in the fragment', () => {
    expect(canonicalizeLegacyHash(loc('/', '#/survey/tok3nabc'))).toBeNull();
  });

  test('a signature slug is left in the fragment', () => {
    expect(canonicalizeLegacyHash(loc('/', '#/sign/slug123'))).toBeNull();
  });

  test('a real anchor is not a route and is left alone', () => {
    // `#section-2` is an anchor. Rewriting it to /section-2 would put a path in
    // the address bar that public/_redirects has never heard of — invisible
    // until the reader hits reload, which is then a 404 on a URL that worked.
    expect(canonicalizeLegacyHash(loc('/', '#section-2'))).toBeNull();
    expect(canonicalizeLegacyHash(loc('/', '#'))).toBeNull();
    expect(canonicalizeLegacyHash(loc('/', ''))).toBeNull();
  });

  test('a hash naming no route this app has is left alone too', () => {
    // Same reasoning: only routes the edge knows may become paths.
    expect(canonicalizeLegacyHash(loc('/', '#/nonsense'))).toBeNull();
  });

  test('a URL that is already a path is not touched', () => {
    // Including one that carries an anchor of its own.
    expect(canonicalizeLegacyHash(loc('/games', '#/coachees'))).toBeNull();
  });
});

test.describe('which root owns the URL', () => {
  test('the console and the guide are paths', () => {
    expect(routeRoot('/admin', '')).toBe('admin');
    expect(routeRoot('/admin/logs/history', '')).toBe('admin');
    expect(routeRoot('/guide/de', '')).toBe('guide');
  });

  test('survey and sign are still read from the fragment', () => {
    // Served at '/', so the pathname says nothing at all about them.
    expect(routeRoot('/', '#/survey/tok3n')).toBe('survey');
    expect(routeRoot('/', '#/sign/slug1')).toBe('sign');
  });

  test('everything else is the app', () => {
    expect(routeRoot('/', '')).toBe('app');
    expect(routeRoot('/games/abc', '')).toBe('app');
  });

  test('"administration" is not the admin console', () => {
    // A prefix match without a boundary is how /formula opens the form.
    expect(routeRoot('/administration', '')).toBe('app');
    expect(isForeignPath('/administration')).toBe(false);
    expect(isForeignPath('/admin')).toBe(true);
    expect(isForeignPath('/admin/logs')).toBe(true);
  });
});

test.describe('URL → state', () => {
  test('the bare root is the landing view', () => {
    expect(parsePath('/', '', false)).toEqual(DEFAULT_ROUTE);
    expect(parsePath('/home', '', false)).toEqual(DEFAULT_ROUTE);
  });

  test('a trailing slash changes nothing', () => {
    expect(parsePath('/games/', '', false).listTab).toBe('games');
  });

  test("a coachee's own list carries the coachee", () => {
    const r = parsePath('/games/kx82hd93jf0a1qp', '', false);
    expect(r.subView).toBe('coacheeGames');
    expect(r.coacheeId).toBe('kx82hd93jf0a1qp');
  });

  test('a filed observation carries both ids', () => {
    const r = parsePath('/feedbacks/c1/f2', '', false);
    expect(r.subView).toBe('feedbackForm');
    expect(r.coacheeId).toBe('c1');
    expect(r.feedbackId).toBe('f2');
  });

  test('the games calendar and its month come off the query', () => {
    const r = parsePath('/games', '?view=calendar&month=2026-11', false);
    expect(r.gamesView).toBe('calendar');
    expect(r.month).toBe('2026-11');
  });

  test('a month that is not a month is dropped, not trusted', () => {
    // It reaches a date constructor, so "13" and "2026-1x" must not get there.
    expect(parsePath('/games', '?view=calendar&month=2026-13', false).month).toBeNull();
    expect(parsePath('/games', '?view=calendar&month=nonsense', false).month).toBeNull();
  });

  test('an unknown path is the landing view, never a blank screen', () => {
    expect(parsePath('/nonsense', '', false)).toEqual(DEFAULT_ROUTE);
  });
});

test.describe('the form identity', () => {
  test('a form URL names the game and the half', () => {
    const r = parsePath('/form/g1/2sr', '', false);
    expect(r.subView).toBe('feedbackForm');
    expect(r.gameId).toBe('g1');
    expect(r.role).toBe('2. SR');
  });

  test('the half is optional — the game alone is a valid address', () => {
    const r = parsePath('/form/g1', '', false);
    expect(r.gameId).toBe('g1');
    expect(r.role).toBeNull();
  });

  // The reason `restorable` exists. A cold load of the id-less form must not
  // open whatever draft happens to be newest: on a shared tablet that is one
  // coach being shown another's half-written report.
  test('the id-less form does NOT open itself on a cold load', () => {
    expect(parsePath('/form', '', false).subView).toBe('coachees');
    expect(parsePath('/form', '', false).listTab).toBe('games');
  });

  test('...but it does when the app is already running', () => {
    expect(parsePath('/form', '', true).subView).toBe('feedbackForm');
  });

  // A named observation is exempt: the id in the URL IS the coach's explicit
  // ask, the same rule /games/<coacheeId> already follows.
  test('a form URL that names a game survives a cold load', () => {
    expect(parsePath('/form/g1/1sr', '', false).subView).toBe('feedbackForm');
  });

  test('a role slug nobody emits is ignored rather than guessed', () => {
    expect(parsePath('/form/g1/3sr', '', false).role).toBeNull();
  });
});

/**
 * The property that keeps Back working.
 *
 * The state→URL effect pushes a history entry whenever the built URL differs
 * from the address bar. So if the builder can emit a URL the parser does not
 * read back into the same state, going Back re-pushes it immediately and the
 * screen can never be left. That is not hypothetical — it is live on the
 * current build for a sent observation.
 */
test.describe('every URL the app writes reads back to the same state', () => {
  const ROUTES: AppRoute[] = [
    { ...DEFAULT_ROUTE },
    { ...DEFAULT_ROUTE, listTab: 'coachees' },
    { ...DEFAULT_ROUTE, listTab: 'games' },
    { ...DEFAULT_ROUTE, listTab: 'games', gamesView: 'calendar' },
    { ...DEFAULT_ROUTE, listTab: 'games', gamesView: 'calendar', month: '2026-11' },
    { ...DEFAULT_ROUTE, subView: 'calendar' },
    { ...DEFAULT_ROUTE, subView: 'coacheeGames', coacheeId: 'c1' },
    { ...DEFAULT_ROUTE, subView: 'feedbackForm', coacheeId: 'c1', feedbackId: 'f2' },
    { ...DEFAULT_ROUTE, subView: 'feedbackForm', gameId: 'g1', role: '1. SR' },
    { ...DEFAULT_ROUTE, subView: 'feedbackForm', gameId: 'g1', role: '2. SR' },
    { ...DEFAULT_ROUTE, subView: 'feedbackForm', gameId: 'g1', role: null },
  ];
  for (const route of ROUTES) {
    const url = routeToPath(route);
    test(`${url} round-trips`, () => {
      const [pathname, search] = url.split('?');
      // `restorable: true` — this is the running app writing and reading back.
      expect(parsePath(pathname, search ? `?${search}` : '', true)).toEqual(route);
    });
  }
});

test.describe('the admin console', () => {
  const TABS = ['coachees', 'games', 'niveau', 'logs', 'emails'];

  test('the tab comes off the path', () => {
    expect(adminTabFromPath('/admin/niveau', TABS)).toBe('niveau');
  });

  test('an unknown tab falls back rather than 404ing', () => {
    expect(adminTabFromPath('/admin/nonsense', TABS)).toBe('coachees');
    expect(adminTabFromPath('/admin', TABS)).toBe('coachees');
  });

  test('the logs sub-tab is addressable, and defaults to live', () => {
    expect(adminLogModeFromPath('/admin/logs/history')).toBe('history');
    expect(adminLogModeFromPath('/admin/logs/live')).toBe('live');
    expect(adminLogModeFromPath('/admin/logs')).toBe('live');
  });
});

test.describe('the guide', () => {
  test('a language in the path pins it', () => {
    expect(guideLangFromPath('/guide/de')).toBe('DE');
    expect(guideLangFromPath('/guide/en')).toBe('EN');
  });

  test('no language means the reader\'s own', () => {
    // What makes one link pasted into the group chat open in each reader's
    // language instead of whoever pasted it.
    expect(guideLangFromPath('/guide')).toBeNull();
  });
});

test('every route prefix the app emits is one the edge must know', () => {
  // APP_ROUTE_PREFIXES drives redirects-config.spec.ts. If a route is added to
  // routeToPath and not to that list, the edge never learns about it and the
  // first reload on it is a 404 — so pin the list against the builder.
  const emitted = new Set<string>();
  const all: AppRoute[] = [
    { ...DEFAULT_ROUTE },
    { ...DEFAULT_ROUTE, listTab: 'coachees' },
    { ...DEFAULT_ROUTE, listTab: 'games' },
    { ...DEFAULT_ROUTE, subView: 'calendar' },
    { ...DEFAULT_ROUTE, subView: 'coacheeGames', coacheeId: 'c1' },
    { ...DEFAULT_ROUTE, subView: 'feedbackForm', coacheeId: 'c1', feedbackId: 'f2' },
    { ...DEFAULT_ROUTE, subView: 'feedbackForm', gameId: 'g1', role: '1. SR' },
  ];
  for (const r of all) {
    const seg = routeToPath(r).split('?')[0].split('/')[1];
    if (seg) emitted.add(seg);
  }
  for (const seg of emitted) expect(APP_ROUTE_PREFIXES).toContain(seg);
});
