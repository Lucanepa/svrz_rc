import './support/build-globals';
import { test, expect } from '@playwright/test';
// A namespace, not named imports: a name the module does not export fails the
// one test that uses it, not the whole file at load.
import * as rules from '../src/lib/notebook';
import type { NotebookPage, ServerPage } from '../src/lib/notebook';

// The client's half of a page with two sides, without a browser: which records
// this frontend vouches for both sides of, what goes on the wire for each, how
// a pull treats a record the frontend before 25.10.2026 wrote, and which side
// a write leaves the page on (its `kind`, which is all the installed apps read).
//
// The frontend before kept one side per page: '' as the text of a pen page and
// '' / 0 as the court and the stroke count of a typed one, whatever the server
// held. Pushed with `both`, those blanks would be taken at their word and wipe
// the server's copy (data-loss review, 25.10.2026).

const OWNER = 'rc-rules-0001';
const PAGE = 'page-rules-0001';
const AT = Date.parse('2026-10-25T18:00:00Z');
const iso = (t: number) => new Date(t).toISOString();

/** A record as the frontend before 25.10.2026 left it in IndexedDB: no mark. */
function oldRecord(over: Partial<NotebookPage> = {}): NotebookPage {
  return {
    id: `${OWNER}|${PAGE}`, schema: 1, ownerId: OWNER, pageId: PAGE, kind: 'ink', title: '', text: '', bg: '', points: 0, usedIn: [],
    createdAt: AT - 60_000, updatedAt: AT, deleted: false, dirty: false, savedAt: iso(AT), rejectedReason: '', ...over,
  };
}
/** The server's copy of the same page, as the pull turns it into a record. */
function fromServer(over: Partial<ServerPage> = {}): NotebookPage {
  return rules.pageFromServer(OWNER, {
    pageId: PAGE, kind: 'ink', createdAt: AT - 60_000, updatedAt: AT, deleted: false, schema: 1, savedAt: iso(AT),
    title: '', text: '', bg: '', points: 0, usedIn: [], ...over,
  })!;
}

test.describe('Which records vouch for both sides', () => {
  test('a page made here or taken from the server is marked, and the mark never travels', () => {
    const made = rules.makePage(OWNER, 'text');
    expect(made.sides).toBe(2);
    expect(fromServer().sides).toBe(2);
    const wire = rules.wireFrom({ ...made, inkRejected: 'ink-too-big' });
    expect(wire.both).toBe(true);
    for (const key of ['sides', 'inkRejected', 'id', 'ownerId', 'dirty', 'savedAt', 'rejectedReason']) expect(wire).not.toHaveProperty(key);
  });

  test('a record the frontend before wrote goes without "both", so the server keeps the side it could not show', () => {
    const wire = rules.wireFrom(oldRecord({ dirty: true }));
    expect(wire).not.toHaveProperty('both');
    expect(wire).not.toHaveProperty('sides');
  });

  test('a record is known on both sides once marked, or while it never reached the server', () => {
    expect(rules.sidesKnown(oldRecord())).toBe(false);
    expect(rules.sidesKnown(oldRecord({ savedAt: '' }))).toBe(true);
    expect(rules.sidesKnown({ ...oldRecord(), sides: 2 })).toBe(true);
  });
});

test.describe('A pull meets a record the frontend before wrote', () => {
  test('a tie with an old pen page brings in the typed text the server kept, and marks the record', () => {
    const d = rules.mergeFromServer(oldRecord({ kind: 'ink', text: '', points: 3 }), fromServer({ kind: 'ink', text: 'auf dem Tablet getippt', points: 3 }), true);
    expect(d.write).not.toBeNull();
    expect(d.write!.text).toBe('auf dem Tablet getippt');
    expect(d.write!.points).toBe(3);
    expect(d.write!.sides).toBe(2);
    expect(d.write!.dirty).toBe(false);
    // Its strokes are this version's: nothing to ask for.
    expect(d.fetchInk).toBe(false);
  });

  test('a tie with an old typed page brings in the court and the stroke count, and asks for the strokes', () => {
    const d = rules.mergeFromServer(oldRecord({ kind: 'text', text: 'getippt', bg: '', points: 0 }), fromServer({ kind: 'text', text: 'getippt', bg: 'court', points: 3 }));
    expect(d.write).toMatchObject({ text: 'getippt', bg: 'court', points: 3, sides: 2, kind: 'text' });
    expect(d.fetchInk).toBe(true);
  });

  test('a marked record at the same version is left as it is', () => {
    const mine = { ...oldRecord({ kind: 'text', text: 'hier', points: 0 }), sides: 2 as const };
    expect(rules.mergeFromServer(mine, fromServer({ kind: 'text', text: 'hier', points: 0 })).write).toBeNull();
  });

  test('an old record newer than the server keeps its copy, and is pushed without "both"', () => {
    const local = oldRecord({ kind: 'ink', text: '', points: 3, updatedAt: AT + 1_000, dirty: true });
    const d = rules.mergeFromServer(local, fromServer({ kind: 'ink', text: 'getippt', points: 3 }), true);
    expect(d.write).toBeNull();
    expect(rules.wireFrom(local)).not.toHaveProperty('both');
  });

  test('a newer server copy replaces an old record whole, and is marked', () => {
    const d = rules.mergeFromServer(oldRecord({ kind: 'ink', text: '' }), fromServer({ kind: 'text', text: 'neuer', updatedAt: AT + 5_000 }));
    expect(d.write).toMatchObject({ text: 'neuer', kind: 'text', sides: 2 });
  });
});

test.describe('The side a write leaves the page on', () => {
  const page = (over: Partial<NotebookPage>) => ({ ...oldRecord(), sides: 2 as const, ...over });

  test('the first stroke on a typed page makes it a pen page; typing on a pen page makes it a typed one', () => {
    expect(rules.kindAfterWrite(page({ kind: 'text', text: 'getippt', points: 12 }), 'ink')).toBe('ink');
    expect(rules.kindAfterWrite(page({ kind: 'ink', text: 'jetzt getippt', points: 12 }), 'text')).toBe('text');
  });

  test('a side written empty hands the page to the other side when that one holds something', () => {
    // Rückgängig on the last stroke of a page with text: an installed app
    // must not show an empty pen page the coach then deletes, text and all.
    expect(rules.kindAfterWrite(page({ kind: 'ink', text: 'getippt', points: 0 }), 'ink')).toBe('text');
    expect(rules.kindAfterWrite(page({ kind: 'text', text: '', points: 12 }), 'text')).toBe('ink');
    // Markup with no letters in it is nothing typed.
    expect(rules.kindAfterWrite(page({ kind: 'text', text: '<b> </b>\n', points: 12 }), 'text')).toBe('ink');
  });

  test('a page with nothing on either side stays on the side written', () => {
    expect(rules.kindAfterWrite(page({ kind: 'text', text: '', points: 0 }), 'ink')).toBe('ink');
    expect(rules.kindAfterWrite(page({ kind: 'ink', text: '', points: 0 }), 'text')).toBe('text');
  });
});
