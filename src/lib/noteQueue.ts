// The SR-Spiel Rückmeldung, written in a hall with no signal.
//
// It is the one thing a coach writes at a game that had no offline path: the
// observation has its outbox (offlineQueue.ts), drafts and the Notizblock have
// their own stores, but "Senden" on the Rückmeldung failed with a network error
// and the text went with the dialog. A few lines of text need no IndexedDB, so
// this is a small list in localStorage, sent by the app when the network is
// back. Like the outbox, every item is tagged with the coach who wrote it and
// only ever sent under that same identity, and it carries one submission key
// for all of its resends — the server rewrites its own row instead of filing a
// second Rückmeldung (see submitRcGameNote).

export type QueuedRcNote = {
  submissionKey: string;
  ownerId: string;
  gameId: string;
  note: string;
  season: number;
  rolesSwapped: boolean;
  queuedAt: number;
};

const KEY = 'svrz-rc-note-outbox';

function readAll(): QueuedRcNote[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) || '[]');
    return Array.isArray(parsed) ? parsed as QueuedRcNote[] : [];
  } catch {
    return [];
  }
}

function writeAll(items: QueuedRcNote[]): boolean {
  try {
    if (items.length) localStorage.setItem(KEY, JSON.stringify(items));
    else localStorage.removeItem(KEY);
    return true;
  } catch {
    return false;
  }
}

/** Keep a Rückmeldung to send later. One per game and coach: a second one for
 *  the same game replaces the first, as a resend online would. Returns false
 *  when this device cannot store it (private mode) — the caller must then say
 *  it was NOT kept. */
export function queueRcNote(item: Omit<QueuedRcNote, 'queuedAt'>): boolean {
  const rest = readAll().filter((q) => !(q.gameId === item.gameId && q.ownerId === item.ownerId));
  return writeAll([...rest, { ...item, queuedAt: Date.now() }]);
}

export function queuedRcNotes(ownerId: string): QueuedRcNote[] {
  return readAll().filter((q) => q.ownerId === ownerId);
}

function removeQueued(submissionKey: string): void {
  writeAll(readAll().filter((q) => q.submissionKey !== submissionKey));
}

/** A failure worth retrying: the network, not the server's answer. fetch throws
 *  a TypeError when there is no connection; apiError() answers plain Errors. */
export function isNetworkFailure(error: unknown): boolean {
  return error instanceof TypeError || (typeof navigator !== 'undefined' && navigator.onLine === false);
}

let flushing = false;

/** Send what this coach queued. A network failure keeps the item for the next
 *  try; a refusal from the server drops it and is reported through onDropped,
 *  since sending it again would be refused again. */
export async function flushRcNotes<T>(
  ownerId: string,
  send: (item: QueuedRcNote) => Promise<T>,
  hooks: { onSent?: (item: QueuedRcNote, result: T) => void; onDropped?: (item: QueuedRcNote, error: unknown) => void } = {},
): Promise<void> {
  if (flushing || !ownerId) return;
  flushing = true;
  try {
    for (const item of queuedRcNotes(ownerId)) {
      try {
        const result = await send(item);
        removeQueued(item.submissionKey);
        hooks.onSent?.(item, result);
      } catch (error) {
        if (isNetworkFailure(error)) return; // still offline: the rest would fail the same way
        removeQueued(item.submissionKey);
        hooks.onDropped?.(item, error);
      }
    }
  } finally {
    flushing = false;
  }
}
