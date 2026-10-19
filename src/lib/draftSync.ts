// One coach, several devices, one set of unfinished observations.
//
// Every device keeps its drafts in its own IndexedDB (formDraft.ts) and parks a
// copy on the server. Before this, the server copy only ever travelled at boot,
// and only towards a device that had nothing: a draft finished on the laptop
// stayed "Nicht gesendet" on the phone forever, and a newer edit made on one
// device never reached another that already held an older copy (Luca,
// 19.10.2026). This decides, from both sides, what a device does with each
// draft. Pure, so the rules are tested on their own
// (e2e/draft-sync-rules.spec.ts); App.tsx carries the plan out.

import type { DraftRecord } from './formDraft';

export type ServerDraftState = {
  /** Every parked copy, as `listParkedDrafts` keyed them for this owner. */
  drafts: DraftRecord[];
  /** Tombstones: a role filed or discarded, and when (device clock). */
  gone: Array<{ gameId: string; role: string; at: number }>;
  /** Roles this coach has filed a report for, from any device. */
  filed: Array<{ gameId: string; role: string }>;
};

export type DraftSyncPlan = {
  /** Server copies to write locally: newer than this device's, or new to it. */
  adopt: DraftRecord[];
  /** Local work whose report this coach has filed — from this device or another. */
  file: DraftRecord[];
  /** Local work filed or discarded elsewhere AFTER its last edit here. */
  remove: DraftRecord[];
  /** Local work the server lacks or holds an older copy of. */
  push: DraftRecord[];
};

const key = (gameId: string, role: string) => `${gameId}|${role}`;

/**
 * `skip` names games the device must leave alone — the one open in the form,
 * whose copy in memory is newer than anything on either side.
 *
 * Only 'editing' work is ever changed here. A 'queued' record is a send the
 * outbox still holds and a 'filed' one is a tombstone: both already say more
 * than any parked copy can, so they always win.
 */
export function planDraftSync(
  local: DraftRecord[],
  server: ServerDraftState,
  skip: (gameId: string) => boolean = () => false,
): DraftSyncPlan {
  const plan: DraftSyncPlan = { adopt: [], file: [], remove: [], push: [] };
  const filed = new Set(server.filed.map((m) => key(m.gameId, m.role)));
  const goneAt = new Map<string, number>();
  for (const m of server.gone) {
    const k = key(m.gameId, m.role);
    goneAt.set(k, Math.max(goneAt.get(k) ?? 0, m.at || 0));
  }
  const parked = new Map<string, DraftRecord>();
  for (const d of server.drafts) {
    const k = key(d.gameId, d.role);
    const seen = parked.get(k);
    if (!seen || (d.updatedAt || 0) > (seen.updatedAt || 0)) parked.set(k, d);
  }
  const mine = new Map<string, DraftRecord>();
  for (const d of local) mine.set(key(d.gameId, d.role), d);

  for (const d of local) {
    if (d.status !== 'editing' || skip(d.gameId)) continue;
    const k = key(d.gameId, d.role);
    // The report is out. Nothing typed into this copy can be sent any more,
    // and keeping it is what put a red "Nicht gesendet" over a report the
    // referee had already read.
    if (filed.has(k)) { plan.file.push(d); continue; }
    const theirs = parked.get(k);
    if (theirs) {
      // A live row is never older than its own tombstone: re-parking after a
      // removal is what clears one. So a live copy settles it, newest wins.
      if ((theirs.updatedAt || 0) > (d.updatedAt || 0)) plan.adopt.push(theirs);
      else if ((d.updatedAt || 0) > (theirs.updatedAt || 0)) plan.push.push(d);
      continue;
    }
    if (goneAt.has(k)) {
      // Discarded or sent on another device after this copy was last touched:
      // finished. Touched AFTER that removal, it is new work — and goes back up.
      if ((d.updatedAt || 0) <= (goneAt.get(k) ?? 0)) plan.remove.push(d);
      else plan.push.push(d);
      continue;
    }
    // Never reached the server — parked while offline, or a backup that
    // failed. Pushing it is what makes it reach the coach's other devices.
    plan.push.push(d);
  }

  for (const [k, theirs] of parked) {
    if (skip(theirs.gameId) || filed.has(k) || mine.has(k)) continue;
    plan.adopt.push(theirs);
  }
  return plan;
}

// ── Has the work actually changed? ──────────────────────────────────

/** A map with its empty entries dropped and its keys in one order. A form
 *  rebuilt from a record carries every field of INITIAL_DATA, most of them '',
 *  and that must not read as an edit. */
function settled(map: Record<string, string> | undefined): string {
  const source = map || {};
  return JSON.stringify(Object.keys(source).filter((k) => source[k] !== '' && source[k] != null).sort()
    .map((k) => [k, source[k]]));
}

/**
 * Whether two records hold the same work. `updatedAt` is what decides which
 * device's copy wins, so it may only move when the coach changed something.
 * Opening a draft, switching tabs or the page going to the background rebuild
 * the record from the form — stamping each of those "now" made an untouched
 * phone's copy newer than the laptop's real edits, and its next park wiped them.
 *
 * `lang` is left out: it is the app's language, not the coach's work, and the
 * ratings travel by item id whatever it is.
 */
export function sameDraftContent(a: DraftRecord, b: DraftRecord): boolean {
  return settled(a.meta) === settled(b.meta)
    && settled(a.ratings) === settled(b.ratings)
    && settled(a.results) === settled(b.results)
    && (a.signature || '') === (b.signature || '')
    && (a.rcSignature || '') === (b.rcSignature || '')
    && (a.tipsAndTricks || '') === (b.tipsAndTricks || '')
    && JSON.stringify(a.attachedDocs || []) === JSON.stringify(b.attachedDocs || [])
    && (a.coacheeId || '') === (b.coacheeId || '')
    && (a.coacheeName || '') === (b.coacheeName || '')
    && (a.coacheeLevel || '') === (b.coacheeLevel || '')
    && !!a.resultUnlocked === !!b.resultUnlocked
    && a.observationTarget === b.observationTarget;
}
