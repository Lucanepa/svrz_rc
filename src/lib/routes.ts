/**
 * Every URL this app answers to, in one place.
 *
 * Routes used to live in the hash, and the rules for reading them were eight
 * independent regexes in six files — main.tsx, App.tsx, AdminConsole.tsx twice,
 * GuidePage.tsx, SurveyPage.tsx, SignaturePage.tsx and logger.ts. tsconfig has
 * no `strict`, so a plausible-but-wrong regex compiles clean and is found by a
 * referee coach in a gym. This module is the single source of truth: pure
 * functions, no DOM reads at module scope, and a test table beside it.
 *
 * ── Two transports, on purpose ──────────────────────────────────────────────
 *
 * The app, the admin console and the guide live in the PATH. The survey and
 * signature pages keep their token in the FRAGMENT, and that is a deliberate
 * split rather than an unfinished migration:
 *
 *   A fragment is never transmitted. A path is — into Cloudflare Pages request
 *   logs, into the Referer of every same-origin /assets/* fetch (public/_headers
 *   sets strict-origin-when-cross-origin, which sends the FULL url same-origin),
 *   and within reach of the link scanners that open every URL in a mail before
 *   the recipient does. Those two URLs ARE the capability: whoever holds one can
 *   answer as that referee. Keeping them in the fragment means no token-shaped
 *   path can exist, which is a property, not a convention — and it is why
 *   public/_redirects has no /sign or /survey rule at all.
 *
 * It also costs nothing: nobody ever types or reads these links, they arrive by
 * mail and QR, and the ones already on referees' phones keep working unchanged.
 */

/** The app's own sub-screens. Mirrors the union in App.tsx. */
export type FeedbackSubView = 'coachees' | 'coacheeGames' | 'calendar' | 'feedbackForm';

export type AppRoute = {
  subView: FeedbackSubView;
  listTab: 'home' | 'coachees' | 'games';
  /** Whom the route is about, when it is about somebody. This is what makes a
   *  coachee's own list and a filed observation addressable: with the id in the
   *  URL the app can fetch what it needs instead of relying on a selection that
   *  only exists if you arrived from the screen before. */
  coacheeId: string | null;
  feedbackId: string | null;
  /** Which game an observation in progress is about, and which referee's half.
   *  A draft is keyed on (owner, game, role) — these are the two thirds of that
   *  key which are not secret, so the URL can name WHICH draft without carrying
   *  any of its content. */
  gameId: string | null;
  role: '1. SR' | '2. SR' | null;
  /** The Games tab as a month grid, and which month. Neither was addressable
   *  before, so a reload always dropped back to the list on the current month. */
  gamesView: 'list' | 'calendar';
  month: string | null;
};

export const DEFAULT_ROUTE: AppRoute = {
  subView: 'coachees',
  listTab: 'home',
  coacheeId: null,
  feedbackId: null,
  gameId: null,
  role: null,
  gamesView: 'list',
  month: null,
};

/** Roots that own the whole document. main.tsx swaps the tree for these. */
export type Root = 'admin' | 'sign' | 'survey' | 'guide' | 'app';

/** First path segment of every route the app serves from a real URL.
 *  public/_redirects must name each of these; redirects-config.spec.ts checks
 *  that it does, because a route the edge does not know 404s on reload. */
export const APP_ROUTE_PREFIXES = [
  'home', 'coachees', 'games', 'calendar', 'form', 'feedbacks',
  'coachee-games', 'admin', 'guide', 'demo',
] as const;

/** Roots that still carry their capability in the fragment. Never a path. */
const FRAGMENT_ROOTS = /^#\/?(sign|survey)(\/|$)/i;

/** A hash that names one of this app's routes, in either shape the old router
 *  accepted: `#/games/abc` and the slashless `#admin`. Built from the prefix
 *  list so a new route cannot be added on one side only. */
const LEGACY_ROUTE = new RegExp(`^#\\/?(${APP_ROUTE_PREFIXES.join('|')})(\\/|$)`, 'i');

/**
 * Which root owns this URL.
 *
 * Reads the path for the roots that moved, and the hash for the two that did
 * not. Order matters: a fragment root wins, because `/#/survey/<t>` is served
 * at `/` and its pathname says nothing.
 */
export function routeRoot(pathname: string, hash: string): Root {
  if (FRAGMENT_ROOTS.test(hash)) return /survey/i.test(hash) ? 'survey' : 'sign';
  if (/^\/admin(\/|$)/i.test(pathname)) return 'admin';
  if (/^\/guide(\/|$)/i.test(pathname)) return 'guide';
  return 'app';
}

/** Paths owned by another root. The app must neither read nor rewrite these,
 *  or it would fight main.tsx mid-navigation. */
export const isForeignPath = (pathname: string) => /^\/(admin|guide)(\/|$)/i.test(pathname);

/**
 * Rewrite a legacy `#/…` URL to its path form, in place.
 *
 * PERMANENT, not a transition step. Old hash links live in mail already sent,
 * in the retired GitHub Pages kill switch (legacy/index.html) which forwards
 * location.hash verbatim to this host and can never be updated again, and in
 * every home-screen icon captured before the migration. Deleting this breaks
 * all three, silently.
 *
 * Cloudflare cannot do this at any price: a fragment is never sent to the
 * server, so `https://host/#/form` arrives at the edge as a request for `/`
 * and no _redirects rule can ever see it. It has to be client code, and it has
 * to run before anything else reads a route.
 *
 * The whole mapping is "delete the #". No route noun was renamed in the
 * migration, precisely so this stays a string operation — a per-route table
 * has rows somebody can forget, and this has none.
 */
export function canonicalizeLegacyHash(loc: {
  pathname: string; hash: string; search: string;
}): string | null {
  if (loc.pathname !== '/') return null;          // already a real path; leave any anchor alone
  if (FRAGMENT_ROOTS.test(loc.hash)) return null; // capability URLs stay in the fragment
  // Only hashes that name a route the app actually has. `#section-2` is an
  // anchor, and rewriting it to /section-2 would put a path in the address bar
  // that public/_redirects has never heard of — fine until the reader hits
  // reload, which is then a 404 on a URL that used to work. An unrecognised
  // hash is left exactly where it is, and the app lands on its default view
  // just as it does today.
  if (!LEGACY_ROUTE.test(loc.hash)) return null;
  // NO lowercasing anywhere: PocketBase ids are case-sensitive, and an id is
  // the whole point of the routes that carry one. Root matching is
  // case-insensitive downstream, on the first segment only.
  const path = '/' + loc.hash.replace(/^#\/?/, '').replace(/\/+$/, '');
  return path + loc.search;
}

const ROLE_SLUG: Record<string, '1. SR' | '2. SR'> = { '1sr': '1. SR', '2sr': '2. SR' };
const SLUG_FOR_ROLE: Record<string, string> = { '1. SR': '1sr', '2. SR': '2sr' };

/** YYYY-MM, and a real month. Anything else is dropped rather than trusted. */
const isMonth = (v: string) => /^\d{4}-(0[1-9]|1[0-2])$/.test(v);

/**
 * URL → state.
 *
 * `restorable` is false on a cold load: a view that only makes sense with a
 * selection carried from the previous screen resolves to its parent list rather
 * than to an empty shell. A route carrying an id is exempt — the id IS the
 * selection, and the app fetches the rest.
 */
export function parsePath(pathname: string, search: string, restorable: boolean): AppRoute {
  const clean = String(pathname || '/').replace(/\/+$/, '');
  const [, head, ...rest] = clean.split('/').map((part) => {
    try { return decodeURIComponent(part); } catch { return part; }
  });
  const params = new URLSearchParams(search || '');
  const gamesView = params.get('view') === 'calendar' ? 'calendar' : 'list';
  const monthRaw = params.get('month') || '';
  const month = isMonth(monthRaw) ? monthRaw : null;

  switch ((head || '').toLowerCase()) {
    case '':
    case 'home':
      return { ...DEFAULT_ROUTE };
    case 'calendar':
      return { ...DEFAULT_ROUTE, subView: 'calendar' };
    // `/form/<gameId>/<1sr|2sr>` names WHICH observation is open — the two
    // public thirds of the draft key. The content stays in IndexedDB on the
    // device that typed it; the URL only says which drawer to open.
    case 'form': {
      const gameId = rest[0] || null;
      const role = ROLE_SLUG[String(rest[1] || '').toLowerCase()] || null;
      // An id in the URL is the coach's explicit ask, so it survives a cold
      // load. The bare `/form` does not: it names no observation, and jumping
      // into whatever draft happens to be newest is how a shared tablet shows
      // one coach another's half-written report.
      if (gameId) return { ...DEFAULT_ROUTE, subView: 'feedbackForm', gameId, role };
      return restorable
        ? { ...DEFAULT_ROUTE, subView: 'feedbackForm' }
        : { ...DEFAULT_ROUTE, listTab: 'games' };
    }
    // One noun per surface, narrowed by an id. `/games` is every fixture;
    // `/games/<coachee>` is that coachee's own list.
    case 'games':
      return rest[0]
        ? { ...DEFAULT_ROUTE, subView: 'coacheeGames', coacheeId: rest[0] }
        : { ...DEFAULT_ROUTE, listTab: 'games', gamesView, month };
    // `/feedbacks/<coachee>/<observation>` opens that FILED observation. Without
    // the second id it opens the coachee's list of them, which is a modal over
    // the coachees tab and so is an entry point rather than a state written back.
    case 'feedbacks':
      return rest[0]
        ? rest[1]
          ? { ...DEFAULT_ROUTE, subView: 'feedbackForm', coacheeId: rest[0], feedbackId: rest[1] }
          : { ...DEFAULT_ROUTE, listTab: 'coachees', coacheeId: rest[0] }
        : { ...DEFAULT_ROUTE, listTab: 'coachees' };
    // Written before the id was in the URL, and never emitted now. Kept so a
    // bookmark from then still lands on the coachee list instead of nowhere.
    case 'coachee-games':
      return restorable
        ? { ...DEFAULT_ROUTE, subView: 'coacheeGames' }
        : { ...DEFAULT_ROUTE, listTab: 'coachees' };
    case 'coachees':
      return { ...DEFAULT_ROUTE, listTab: 'coachees' };
    default:
      return { ...DEFAULT_ROUTE };
  }
}

/** state → URL. The exact inverse of parsePath for every route it can emit. */
export function routeToPath(r: AppRoute): string {
  if (r.subView === 'feedbackForm') {
    // A FILED observation has a shareable address — the record is on the server.
    if (r.coacheeId && r.feedbackId) return `/feedbacks/${r.coacheeId}/${r.feedbackId}`;
    // One still being written names its game, and its half when one is chosen.
    if (r.gameId) {
      const slug = r.role ? SLUG_FOR_ROLE[r.role] : '';
      return slug ? `/form/${r.gameId}/${slug}` : `/form/${r.gameId}`;
    }
    return '/form';
  }
  if (r.subView === 'coacheeGames') return r.coacheeId ? `/games/${r.coacheeId}` : '/coachees';
  if (r.subView === 'calendar') return '/calendar';
  if (r.listTab === 'games' && r.gamesView === 'calendar') {
    // The month rides along only when it is not the one the grid opens on
    // anyway, so an ordinary click does not produce a URL full of today.
    return r.month ? `/games?view=calendar&month=${r.month}` : '/games?view=calendar';
  }
  return `/${r.listTab}`;
}

/** The admin console's tab, and the Logs tab's own sub-tab.
 *  `/admin/logs/history` is the one that earns its place: the console always
 *  opened Logs on Live, so "the error is under Verlauf" was not a linkable
 *  sentence. */
export function adminTabFromPath(pathname: string, allowed: readonly string[]): string {
  const m = /^\/admin\/([a-z-]+)/i.exec(pathname || '');
  const tab = m ? m[1].toLowerCase() : '';
  return allowed.includes(tab) ? tab : 'coachees';
}

export function adminLogModeFromPath(pathname: string): 'live' | 'history' {
  return /^\/admin\/logs\/history\b/i.test(pathname || '') ? 'history' : 'live';
}

/** The guide's language, when the URL pins one. Null means "ask the reader's
 *  own settings" — which is what makes a link pasted into the group chat open
 *  in each reader's language. */
export function guideLangFromPath(pathname: string): 'DE' | 'EN' | null {
  const m = /^\/guide\/(de|en)\b/i.exec(pathname || '');
  return m ? (m[1].toLowerCase() === 'de' ? 'DE' : 'EN') : null;
}
