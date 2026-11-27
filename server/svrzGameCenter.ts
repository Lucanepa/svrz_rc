// Referees (and the schedule around them) from the SVRZ public Game Center.
//
// Why this exists: since 25.11.2026 VolleyManager's web server (185.195.199.53)
// refuses this server's address, so the login-based games sync is dead. The
// SVRZ Game Center at https://www.svrz.ch is a SEPARATE, public site on a
// different host (5.148.180.98) that is NOT blocked, and it publishes exactly
// what the public league iCal feeds leave out: the two referees of each game,
// each with their SV number. It is the regional association's own public page —
// this reads it, it does not log in to or go around VolleyManager.
//
// The detail page /game-center/game/<id> server-renders the whole game as JSON
// inside its React-Server-Components stream (the `self.__next_f.push([1,"…"])`
// chunks). A plain GET gets it; no browser, no API key, no cookies. The URL id
// is the VolleyManager game number — the same `match_no` svrz_rc keys on.
//
// What the Game Center does NOT carry, and the login did (documented so the
// wiring that replaces the sync can decide what to do):
//   - line judges  → first/second_line_judge stay empty
//   - the RD/RSV supervision marks (isSupervised / refereeSupervisorNeeded)
//     → is_rd_game / is_rsv_game are always false here, so a game is kept only
//       on the "a coachee is on it" ground, never on a mark alone.

/** One referee slot as the Game Center gives it. */
export type GameCenterReferee = { slot: '1' | '2'; refereeId: string; firstName: string; lastName: string };

/** A game as read from the Game Center, in svrz_rc's incoming-game shape
 *  (see mapIncomingGame in server/index.ts) plus a few fields the caller may
 *  want when it reconciles leagues/results. Strings, because that is what the
 *  rest of the pipeline stores. */
export type GameCenterGame = {
  external_id: string;
  match_no: string;
  league: string;
  gender: string;            // 'm' | 'f' as the site reports it
  group: string;             // e.g. "Männer 2. Liga" — for the focus-rule league mapping at wiring
  match_date: string;        // Zürich wall-clock text "YYYY-MM-DD HH:mm:ss", as svrz_rc stores it
  location: string;          // "Hall, Street No, ZIP City" — the shape hallKey() expects
  home_team: string;
  away_team: string;
  first_referee: string;
  first_referee_id: string;
  second_referee: string;
  second_referee_id: string;
  first_line_judge: '';      // not published by the Game Center
  second_line_judge: '';
  is_rd_game: false;         // marks are not published by the Game Center
  is_ld_game: false;
  is_rsv_game: false;
  maps_url: string;
  game_result: string;       // sets won, "home:away", or '' before the game is played
  played: boolean;
};

const txt = (v: unknown): string => (v == null ? '' : String(v).trim());

/** Rebuild the RSC flight text from a Game Center HTML page. Each chunk is a
 *  JSON-escaped string argument to `self.__next_f.push([1,"…"])`; JSON.parsing
 *  that argument unescapes it, and concatenating the chunks gives the data. */
function rscFlight(html: string): string {
  let flight = '';
  for (const m of html.matchAll(/self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g)) {
    try { flight += JSON.parse(m[1]) as string; } catch { /* a non-string chunk is not data */ }
  }
  return flight;
}

/** Slice the balanced-brace object that starts at `"<key>":{` in `s`. Respects
 *  strings and escapes so a `}` inside a caption does not end it early. */
function sliceObjectAfter(s: string, key: string): string | null {
  const at = s.indexOf(`"${key}":{`);
  if (at < 0) return null;
  let i = s.indexOf('{', at);
  let depth = 0;
  let inStr = false;
  for (let j = i; j < s.length; j += 1) {
    const c = s[j];
    if (inStr) {
      if (c === '\\') { j += 1; continue; }
      if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === '{') depth += 1;
    else if (c === '}') { depth -= 1; if (depth === 0) return s.slice(i, j + 1); }
  }
  return null;
}

/** Sets won, home:away, from the per-set results — '' when none are in yet. */
function resultFromSets(setResults: Record<string, { home?: unknown; away?: unknown }> | undefined): string {
  if (!setResults) return '';
  let home = 0; let away = 0; let any = false;
  for (const s of Object.values(setResults)) {
    const h = Number(s?.home); const a = Number(s?.away);
    if (!Number.isFinite(h) || !Number.isFinite(a)) continue;
    any = true;
    if (h > a) home += 1; else if (a > h) away += 1;
  }
  return any ? `${home}:${away}` : '';
}

/**
 * Parse one Game Center detail page into a game row. Pure (no network) so it is
 * testable against a saved page. Returns null when the page carries no game
 * object (a 404 / maintenance page), so a caller can tell "no such game" from a
 * thrown fetch error.
 */
export function parseGameCenterGame(html: string): GameCenterGame | null {
  const flight = rscFlight(html);
  const raw = sliceObjectAfter(flight, 'game');
  if (!raw) return null;
  let g: any;
  try { g = JSON.parse(raw); } catch { return null; }
  if (g == null || g.gameId == null) return null;

  const refs: Record<string, { refereeId?: unknown; firstName?: unknown; lastName?: unknown }> = g.referees ?? {};
  const ref = (slot: '1' | '2') => {
    const r = refs[slot];
    const name = r ? `${txt(r.firstName)} ${txt(r.lastName)}`.trim() : '';
    return { name, id: r ? txt(r.refereeId) : '' };
  };
  const r1 = ref('1'); const r2 = ref('2');

  const hall = g.hall ?? {};
  const location = [
    txt(hall.caption),
    [txt(hall.street), txt(hall.number)].filter(Boolean).join(' '),
    [txt(hall.zip), txt(hall.city)].filter(Boolean).join(' '),
  ].filter(Boolean).join(', ');

  const lat = Number(hall.latitude); const lon = Number(hall.longitude);
  const maps_url = Number.isFinite(lat) && Number.isFinite(lon)
    ? `https://www.google.com/maps/search/?api=1&query=${lat},${lon}` : '';

  const id = txt(g.gameId);
  return {
    external_id: id,
    match_no: id,
    league: txt(g.league?.caption),
    gender: txt(g.gender),
    group: txt(g.group?.caption),
    match_date: txt(g.playDate),
    location,
    home_team: txt(g.teams?.home?.caption),
    away_team: txt(g.teams?.away?.caption),
    first_referee: r1.name,
    first_referee_id: r1.id,
    second_referee: r2.name,
    second_referee_id: r2.id,
    first_line_judge: '',
    second_line_judge: '',
    is_rd_game: false,
    is_ld_game: false,
    is_rsv_game: false,
    maps_url,
    game_result: resultFromSets(g.setResults),
    // Played iff a result is in. The `status` field is NOT it: an upcoming game
    // and a played one both carry status 2 (checked live on 406182, a future
    // game), so only the presence of set results tells them apart.
    played: Boolean(resultFromSets(g.setResults)),
  };
}

export const GAME_CENTER_BASE = process.env.SVRZ_GAME_CENTER_BASE || 'https://www.svrz.ch';

/** How long a single Game Center fetch may take. The page is ~130 KB of static
 *  HTML served from svrz.ch's own cache, so it answers in well under this. */
export const GAME_CENTER_TIMEOUT_MS = Number(process.env.SVRZ_GAME_CENTER_TIMEOUT_MS || 20_000);

/**
 * Read one game's referees (and schedule) from the public Game Center.
 * `fetchImpl` is injectable for tests; production uses global fetch.
 * Throws on a non-200, returns null when the page has no game object.
 */
export async function fetchGameCenterGame(
  gameId: string | number,
  fetchImpl: typeof fetch = fetch,
): Promise<GameCenterGame | null> {
  const url = `${GAME_CENTER_BASE}/game-center/game/${encodeURIComponent(String(gameId))}`;
  const res = await fetchImpl(url, {
    headers: {
      // Honest, identifiable, no personal data — this is the region's own tool.
      'User-Agent': 'svrz-rc-gamecenter/1.0',
      Accept: 'text/html',
      'Accept-Language': 'de-CH,de;q=0.9',
    },
    signal: AbortSignal.timeout(GAME_CENTER_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Game Center ${res.status} for game ${gameId}`);
  return parseGameCenterGame(await res.text());
}
