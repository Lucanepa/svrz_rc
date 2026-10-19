// The rules that keep one coach's devices agreeing about a parked draft, kept
// apart from the routes so they can be tested without a database
// (e2e/park-sync-rules.spec.ts).
//
// A parked draft used to be a backup and nothing more: one device wrote it,
// another adopted it on boot, and the work was then on two devices with nothing
// tying the copies together. Filing the report on the laptop left the phone's
// copy shouting "Nicht gesendet" for a report the referee had already read
// (Luca, 19.10.2026), and Discard on one device was undone by the next park
// from the other. So a removed draft now leaves a TOMBSTONE behind — the row
// stays, its payload goes, `deleted_at` says when — and every device that still
// holds an older copy learns from it that the work is finished.

export const PARK_ROLES = ['1. SR', '2. SR'] as const;

/** One stored row, reduced to what the comparison needs. `updatedAt` is the
 *  DEVICE clock of the last edit (or of the removal, for a tombstone): the
 *  copies being compared were all stamped by one coach's own devices. */
export type ParkedRowState = { updatedAt: number; deleted: boolean };

/**
 * What a park of one role does to the row already there.
 *
 *  - 'write' — nothing newer is stored.
 *  - 'stale' — a live copy edited LATER on another device is already parked.
 *    Writing over it is how a phone that was never touched again wipes the
 *    evening the coach spent on the laptop, so the older copy is refused and the
 *    device is told to fetch the newer one instead.
 *  - 'gone'  — the work was filed or discarded after this copy's last edit.
 *    Taking it back would resurrect a report that already went out.
 *
 * An edit made AFTER the removal wins over the tombstone: that is a coach who
 * went on working on purpose, and their newer work is not something a removal
 * on another device gets to undo.
 */
export type ParkVerdict = 'write' | 'stale' | 'gone';

export function parkVerdict(existing: ParkedRowState | null, incomingUpdatedAt: number): ParkVerdict {
  if (!existing) return 'write';
  if (existing.deleted) return incomingUpdatedAt > existing.updatedAt ? 'write' : 'gone';
  // Equal is a re-park of the copy already stored — idempotent, not stale.
  return incomingUpdatedAt >= existing.updatedAt ? 'write' : 'stale';
}

/**
 * The time a tombstone carries. The removing device's clock where it gave a
 * believable one, the server's otherwise — and never earlier than the copy it
 * removes, or that very copy would read as newer than its own removal and come
 * straight back.
 */
export function tombstoneTime(rowUpdatedAt: number, at: unknown, now: number, maxSkewMs: number): number {
  const asked = Number(at);
  const deviceAt = Number.isFinite(asked) && asked > 0 && asked <= now + maxSkewMs ? Math.floor(asked) : now;
  return Math.max(Number.isFinite(rowUpdatedAt) ? rowUpdatedAt : 0, deviceAt);
}

/**
 * Which roles a DELETE removes, or null for a request that named none.
 *
 * Null keeps the old meaning — hard-delete both rows, leave no tombstone —
 * because only an older build sends that, and an older build sends it after
 * filing ONE role of a two-referee visit as well. A tombstone on the other,
 * unfiled half would tell every device to throw that half away.
 */
export function rolesToRemove(role: unknown): string[] | null {
  if (role === undefined) return null;
  const text = typeof role === 'string' ? role.trim() : '';
  if (text === 'both') return [...PARK_ROLES];
  return (PARK_ROLES as readonly string[]).includes(text) ? [text] : [];
}

/** `?games=a,b,c` — the games a device holds drafts for, so the answer can say
 *  which of them this coach has filed. Bounded and de-duplicated; an id that
 *  could not be a record id is dropped rather than escaped into a filter. */
export function parseGameIds(raw: unknown, max = 40): string[] {
  const text = Array.isArray(raw) ? raw.join(',') : typeof raw === 'string' ? raw : '';
  const out: string[] = [];
  for (const part of text.split(',')) {
    const id = part.trim();
    if (!id || id.length > 64 || !/^[A-Za-z0-9_-]+$/.test(id) || out.includes(id)) continue;
    out.push(id);
    if (out.length >= max) break;
  }
  return out;
}

export function parkKey(gameId: string, role: string): string {
  return `${gameId}|${role}`;
}
