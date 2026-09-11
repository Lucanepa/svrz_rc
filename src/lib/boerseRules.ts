// Which colour a game row wears when someone has put their slot in the SR-Börse.
//
// Pure, and in src/lib rather than server/, for two reasons: the server imports
// it the way it already imports src/lib/survey.ts, and it is the only part of
// this feature a test can exercise exhaustively — no VolleyManager, no
// PocketBase, no browser. The join it encodes is the part most likely to be
// wrong, so it is the part that gets a truth table.
//
// The rules, as agreed 2026-09-10:
//   R1   one of MY coachees, their slot offered            → red
//   R2   two of MY coachees, one offered                   → amber
//   R2b  two of MY coachees, both offered                  → red
//   R4a  RC game (I whistle it), a coachee's slot offered  → amber
//   R4b  RC game, MY OWN slot offered                      → blue
//   —    only the non-coachee's slot offered               → no colour, but a mark
// Precedence on collision: red > amber > blue.

/** One live offer on this game, already narrowed to a head slot. */
export type BoerseSlotOffer = {
  slot: string;        // '1' | '2'
  status: string;      // VM's own word: open | applied | not_applied
  withdrawn: boolean;
  personName: string;
  personSv: string;
};

/**
 * Everything viewer-scoped, resolved server-side before this is called.
 *
 * `coacheeSlots` is every coachee on the game, from the season-wide index — and
 * that is correct HERE, though it would not be in a system that assigned
 * coachees to coaches. This one does not: `coachees.groups` holds labels like
 * "Neu-Schiedsrichter 26/27", `referee_coaches` has no group field, and the only
 * ownership that exists is `games.assigned_rc`. So both coachees on a game are
 * equally this coach's to observe, because they hold the GAME. "Somebody else's
 * coachee is still whistling, so I have nothing left" is a case this data model
 * cannot produce.
 *
 * If coachee-to-coach assignment is ever added, R2 has to be revisited: the
 * survivor test below would then need to count only the asking coach's own.
 */
export type BoerseView = {
  offers: BoerseSlotOffer[];
  coacheeSlots: string[];
  mySlot: string;       // the slot I whistle myself; '' when this is not an RC game
  gameInPast: boolean;
  isManual: boolean;
};

// FLAT, like everything else that crosses a boundary here: this tsconfig has no
// `strict`, so a union tagged by a literal does not narrow for the checker.
export type BoerseVerdict = {
  level: string;        // 'red' | 'amber' | 'blue' | 'none'
  reason: string;
  markedSlots: string[]; // every slot whose referee is in the börse, coachee or not
};

const HEAD_SLOTS = ['1', '2'];

const none = (reason: string): BoerseVerdict => ({ level: 'none', reason, markedSlots: [] });

export function boerseLevel(view: BoerseView): BoerseVerdict {
  // A manual game's referees are typed by hand and are not in VolleyManager's
  // disposition at all, so an offer can never refer to one.
  if (view.isManual) return none('manual-game');
  // A game that has been played cannot lose its referee any more.
  if (view.gameInPast) return none('already-played');

  // Only OPEN counts. An offer somebody already took is not a risk — it is a
  // completed swap, and the same poll that saw it has already corrected the crew
  // on the game, so the coachee has left by the ordinary route.
  const live = view.offers.filter(
    (o) => o.status === 'open' && !o.withdrawn && HEAD_SLOTS.includes(o.slot),
  );

  // R3 is independent of any colour: whoever is in the börse is visible, even
  // when it changes nothing for this coach.
  const markedSlots = live.map((o) => o.slot);
  if (live.length === 0) return { level: 'none', reason: 'no-open-offers', markedSlots: [] };

  const offered = new Set(markedSlots);
  const coachees = view.coacheeSlots.filter((s) => HEAD_SLOTS.includes(s));
  const coacheesOffered = coachees.filter((s) => s !== view.mySlot && offered.has(s));

  if (coacheesOffered.length > 0) {
    // An RC game: I am in that hall whatever happens, so only the observation is
    // at risk, never the trip. Amber even when my own slot is offered too —
    // the lost observation outranks the confirmation of my own offer.
    if (view.mySlot) return { level: 'amber', reason: 'rc-game-coachee-offered', markedSlots };

    const survivors = coachees.filter((s) => s !== view.mySlot && !offered.has(s));
    // R2: a coachee is still whistling, so the evening is still worth it.
    if (survivors.length > 0) return { level: 'amber', reason: 'one-of-mine-remains', markedSlots };
    // R1 and R2b land here together, and deliberately: losing the only coachee
    // and losing both of them are the same outcome, and there is no colour
    // sharper than red to tell them apart with.
    return {
      level: 'red',
      reason: coacheesOffered.length > 1 ? 'both-coachees-offered' : 'only-coachee-offered',
      markedSlots,
    };
  }

  // R4b: my own slot, and none of my coachees affected. Pure confirmation —
  // I already know, I filed it.
  if (view.mySlot && offered.has(view.mySlot)) {
    return { level: 'blue', reason: 'my-own-slot-offered', markedSlots };
  }

  // Someone is in the börse, but not anyone this coach is here for. The names
  // still carry their ⚠; the row stays as it was.
  return { level: 'none', reason: 'not-my-concern', markedSlots };
}
