import { dayKey, todayKey } from './appTime';

// The season window, as both screens draw it. A season is named by its
// starting year and runs September to April: "2026" is 2026-09-01 .. 2027-04-30
// — the same convention as the server's seasonDateFilter, so a list filtered
// here agrees with a counter computed there.

/** The window's first and last day, as Zürich day keys. */
function seasonWindow(season: number): { from: string; to: string } {
  return { from: `${season}-09-01`, to: `${season + 1}-04-30` };
}

/** The season today falls in, by the Zürich calendar — the app's guess until
 *  the settings say which season it opens to. Was computed three times over
 *  from the device clock; a coach abroad on the night of 31 August got a
 *  different season from the console. */
export function currentSeason(): number {
  const [y, m] = todayKey().split('-').map(Number);
  return m >= 9 ? y : y - 1;
}

/** "2026/27" — the season as it is spoken and written on every list. */
export const seasonLabel = (season: number) => `${season}/${String((season + 1) % 100).padStart(2, '0')}`;

/** Inside the season on screen — or a test game, which is exempt.
 *
 *  A season runs September to April, and a test game is usually made today,
 *  which in May–August belongs to no season at all. It then disappeared from
 *  every list while sitting in the console that had just created it. The row
 *  says "Testspiel", so showing one out of season misleads nobody.
 *
 *  Shared by the coach app and the admin console: the console's Spiele tab
 *  applied no window at all and listed last season's fixtures for assignment
 *  under this season's heading — sorted newest first, on a September day most
 *  of what it showed was the season before. */
export function inSeasonOrManual(g: { date?: string; isManual?: boolean }, season: number): boolean {
  if (g.isManual) return true;
  if (!g.date) return true;
  // Zürich day keys, for the same reason as the date filter: the old bounds
  // mixed a UTC start with a device-local end, and the last matchday of the
  // season disappeared for a coach travelling east.
  const key = dayKey(g.date);
  if (!key) return true;
  const { from, to } = seasonWindow(season);
  return key >= from && key <= to;
}
