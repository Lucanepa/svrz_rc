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
