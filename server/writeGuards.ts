// Small, pure rules the write routes in server/index.ts lean on — kept here so
// a spec can pin them without a PocketBase or an SMTP server behind them (see
// e2e/write-guards.spec.ts). index.ts keeps the I/O: the records, the locks,
// the mail.
import { refereeAmong, type RefereeSet } from '../src/lib/identity.ts';

// ── What a filed document may be ──────────────────────────────────────
// A manual upload may be a phone photo of a paper form, so the type comes from
// the bytes, never from the name or the header the client sent.

/** The ISO-BMFF brands a phone writes for a HEIF still. iPhones label theirs
 *  `heic`, but `heix`, `hevc`/`hevx` and the generic `mif1`/`msf1` are just as
 *  much a photo — refusing them sent a coach off to convert a picture the
 *  upload's own `accept="image/*"` had offered. */
const HEIF_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1']);

export function sniffAttachmentType(buffer: Buffer): string {
  if (buffer.length >= 4 && buffer.toString('latin1', 0, 4) === '%PDF') return 'application/pdf';
  if (buffer.length >= 4 && buffer.toString('latin1', 1, 4) === 'PNG') return 'image/png';
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.length >= 12 && buffer.toString('latin1', 0, 4) === 'RIFF' && buffer.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  if (buffer.length >= 6 && buffer.toString('latin1', 0, 4) === 'GIF8') return 'image/gif';
  if (buffer.length >= 12 && buffer.toString('latin1', 4, 8) === 'ftyp') {
    const brand = buffer.toString('latin1', 8, 12);
    if (brand === 'avif' || brand === 'avis') return 'image/avif';
    if (HEIF_BRANDS.has(brand)) return 'image/heic';
  }
  return 'application/octet-stream';
}

export const ATTACHMENT_EXTENSIONS: Record<string, string> = {
  'application/pdf': 'pdf', 'image/png': 'png', 'image/jpeg': 'jpg',
  'image/webp': 'webp', 'image/gif': 'gif', 'image/heic': 'heic', 'image/avif': 'avif',
};

// ── 4.4.10 SR-Spiel ───────────────────────────────────────────────────
// A coach ON the whistle beside a coachee cannot observe them: there is nobody
// in the stand. The regulation asks for no Feedbackformular on that referee and
// for a Rückmeldung instead. The pair test is listMyRcGames' own — the coach on
// one slot, a coachee of the game's season on the other — asked about the slot
// being assessed. A colleague in the stand is not on either whistle and is
// untouched by it: 4.4.10 closes the form for the coach who referees, nobody
// else (memory: svrz-rc-srspiel-rueckmeldung).

type Slot = { name?: unknown; sv?: unknown };

/** Whether `me` whistled the OTHER slot of a game whose `role` slot holds a
 *  coachee — i.e. whether this form is the one 4.4.10 replaces. */
export function whistleBlocksForm<S extends Slot>(
  role: string,
  slots: [S, S],
  me: RefereeSet,
  isCoachee: (slot: S) => boolean,
): boolean {
  if (me.names.size === 0 && me.svs.size === 0) return false;
  const [first, second] = slots;
  const assessed = role === '2. SR' ? second : first;
  const mine = role === '2. SR' ? first : second;
  return refereeAmong(mine, me) && isCoachee(assessed);
}

// ── Mail cooldowns ────────────────────────────────────────────────────
// Every route here mails from the association's own address, so a button that
// can be pressed in a loop is a way to flood somebody's inbox with SVRZ mail.
// A cooldown per key answers that without a table: the API is one process (the
// same assumption chainOnKey makes), and a restart forgetting the marks costs
// at most one extra mail per key.

export type MailCooldown = {
  /** Milliseconds until `key` may mail again; 0 when it may now. */
  left(key: string): number;
  /** Record that `key` just mailed — or is about to: marking BEFORE the send
   *  is what keeps a burst of parallel requests from all passing `left`. */
  mark(key: string): void;
  /** Forget `key`, for a send that was reserved and then did not happen. */
  clear(key: string): void;
};

export function createMailCooldown(ms: number, now: () => number = Date.now): MailCooldown {
  const last = new Map<string, number>();
  return {
    left(key) {
      const at = last.get(key);
      if (at === undefined) return 0;
      const remaining = at + ms - now();
      if (remaining <= 0) { last.delete(key); return 0; }
      return remaining;
    },
    mark(key) {
      const t = now();
      last.set(key, t);
      // Swept on write, so the map holds at most the keys of one window.
      if (last.size > 500) for (const [k, at] of last) if (at + ms <= t) last.delete(k);
    },
    clear(key) { last.delete(key); },
  };
}

/**
 * Update mails that COALESCE instead of being dropped: the first goes at once,
 * anything inside the cooldown waits for its end, and only the latest version
 * is then sent — and not at all when it says what the last mail already said.
 * A correction the reader never sees is worse than a second mail (the reason
 * the RC-game note mails its rewrites at all), so nothing is thrown away; a
 * loop of rewrites simply costs one mail per window.
 */
export type Coalescer<T> = { offer(key: string, payload: T): 'sent' | 'queued' | 'unchanged' };

export function createCoalescer<T>(opts: {
  cooldownMs: number;
  send: (payload: T) => void;
  /** Two payloads that would read the same in the inbox. */
  same: (a: T, b: T) => boolean;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
}): Coalescer<T> {
  const now = opts.now ?? Date.now;
  const setTimer = opts.setTimer ?? ((fn: () => void, ms: number) => {
    const t = setTimeout(fn, ms);
    (t as { unref?: () => void }).unref?.();
    return t;
  });
  type State = { lastAt: number; lastSent: T | undefined; pending: T | undefined; timer: boolean };
  const state = new Map<string, State>();

  const flush = (key: string) => {
    const s = state.get(key);
    if (!s) return;
    s.timer = false;
    const payload = s.pending;
    s.pending = undefined;
    if (payload === undefined) return;
    if (s.lastSent !== undefined && opts.same(payload, s.lastSent)) return;
    s.lastAt = now();
    s.lastSent = payload;
    opts.send(payload);
  };

  return {
    offer(key, payload) {
      let s = state.get(key);
      const t = now();
      if (!s || t - s.lastAt >= opts.cooldownMs) {
        if (s?.lastSent !== undefined && opts.same(payload, s.lastSent) && !s.timer) return 'unchanged';
        if (!s) { s = { lastAt: 0, lastSent: undefined, pending: undefined, timer: false }; state.set(key, s); }
        if (!s.timer) {
          s.lastAt = t;
          s.lastSent = payload;
          s.pending = undefined;
          opts.send(payload);
          return 'sent';
        }
      }
      s.pending = payload;
      if (!s.timer) {
        s.timer = true;
        setTimer(() => flush(key), Math.max(0, s.lastAt + opts.cooldownMs - t));
      }
      return 'queued';
    },
  };
}
