/** Sorting key for a coachee's name.
 *
 *  The lists SHOW "Vorname Nachname" — that is how a coach reads a name off a
 *  game sheet. But sorting the shown string files everyone under their first
 *  name, which is not how anyone looks a referee up. So display and order are
 *  split: the row keeps "Vorname Nachname", the sort reads surname first.
 *
 *  Rows imported before the name was split into columns carry only `full_name`;
 *  there the last word is taken as the surname, which is right for the ordinary
 *  case and no worse than the old behaviour for a compound one.
 */
export function surnameFirst(c: { first_name?: string; last_name?: string; full_name?: string }): string {
  const last = (c.last_name || '').trim();
  const first = (c.first_name || '').trim();
  if (last) return `${last} ${first}`.trim();

  const parts = (c.full_name || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return parts.join(' ');
  return `${parts[parts.length - 1]} ${parts.slice(0, -1).join(' ')}`;
}

/** Compare two coachees by surname. 'de' so ä/ö/ü file next to a/o/u rather
 *  than after z, which is what a Swiss reader expects of a name list. */
export function bySurname(
  a: { first_name?: string; last_name?: string; full_name?: string },
  b: { first_name?: string; last_name?: string; full_name?: string },
): number {
  return surnameFirst(a).localeCompare(surnameFirst(b), 'de');
}

/** How a coachee's name is LISTED: "Nachname, Vorname".
 *
 *  The two coachee lists — the Coachees tab and the admin console's table —
 *  are looked up by surname, so they now read that way too rather than being
 *  ordered on one thing and printed on another. Everywhere a name is ADDRESSED
 *  rather than looked up (the observation form, the PDF, the mail, a game's
 *  referee line) keeps "Vorname Nachname": nobody is greeted by their surname.
 *
 *  Falls back the same way [[surnameFirst]] does — a row with only `full_name`
 *  gives up its last word as the surname; a single-word name is left alone.
 */
export function surnameFirstLabel(c: { first_name?: string; last_name?: string; full_name?: string }): string {
  const last = (c.last_name || '').trim();
  const first = (c.first_name || '').trim();
  if (last && first) return `${last}, ${first}`;
  if (last) return last;

  const parts = (c.full_name || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return parts.join(' ');
  return `${parts[parts.length - 1]}, ${parts.slice(0, -1).join(' ')}`;
}

/** Fold a name for COMPARISON — case-blind, accent-blind, spaces squeezed.
 *
 *  "Müller" off a game sheet and "Muller" in the coachee list are the same
 *  referee, and which of the two a record carries is not something the app gets
 *  to choose. Lived in App.tsx and again in the admin console, which is one copy
 *  too many for a rule both sides have to agree on to the letter: a game whose
 *  referee folds differently in the two places is a coachee in one list and a
 *  stranger in the other.
 */
export function foldName(value: string): string {
  return value.trim().toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '').replace(/\s+/g, ' ');
}

/** Every name a game's referee line can be written as, pointing at the coachee
 *  it belongs to.
 *
 *  Coachees are per-season rows: the same person has one per season, and
 *  everything derived from the row — Niveau, group, whether this referee is a
 *  coachee at all — has to read the season on screen, or last season's people
 *  leak onto this season's games wearing last season's badge. Rows from other
 *  seasons are left out entirely; among what remains (this season's rows plus
 *  the seasonless ones that predate the field) the selected season's row is
 *  inserted last so it wins the key.
 *
 *  Both name orders are keyed. VolleyManager writes "Vorname Nachname" on some
 *  fixtures and "Nachname Vorname" on others, and a lookup that knew only one
 *  of them silently treated half the roster as strangers.
 */
export function coacheeIndex<T extends {
  full_name?: string; first_name?: string; last_name?: string; season?: number;
}>(coachees: T[], season: number): Map<string, T> {
  const map = new Map<string, T>();
  const ordered = coachees
    .filter((c) => typeof c.season !== 'number' || c.season === season)
    .sort((a, b) => Number(a.season === season) - Number(b.season === season));
  for (const c of ordered) {
    const fn = foldName(c.full_name || '');
    if (fn) map.set(fn, c);
    const first = (c.first_name || '').trim();
    const last = (c.last_name || '').trim();
    if (first && last) {
      map.set(foldName(`${first} ${last}`), c);
      map.set(foldName(`${last} ${first}`), c);
    }
  }
  return map;
}
