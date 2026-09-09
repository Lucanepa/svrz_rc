// Forensic read path over the daily JSONL files written by logstore.ts.
//
// The admin console reads the in-memory ring (fast, live, and gone the moment
// the container restarts). This module reads the DURABLE half: the files under
// LOG_DIR, one per local day, retained for 30 days. That is the difference
// between "what is happening" and "what happened on Tuesday", and the second
// question is the one a user report always asks.
//
// It also carries the triage layer, because a log that records every click
// needs one to stay readable:
//   • annotations — mark ONE occurrence solved / important, with a note;
//   • mute rules  — hide a whole CLASS of noise (an event, or a message
//                   substring) without deleting anything from the files.
// Both live in LOG_DIR/log-notes.json, beside the logs they describe, so they
// survive a redeploy exactly like the logs do.

import { createReadStream } from 'node:fs';
import { readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { flushNow, localDate, logDir, logFileFor, ringEntries, fileSinkEnabled, type LogEntry, type LogLevel, type LogSource } from './logstore.ts';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export type AnnotationStatus = 'open' | 'important' | 'solved';

export type Annotation = {
  status: AnnotationStatus;
  note?: string;
  commit?: string;
  date?: string;
  updated: string;
};

export type MuteRule = {
  id: string;
  /** Event prefix, e.g. `net.fail` or `ui.` — case-insensitive. */
  evt?: string;
  /** Case-insensitive substring of the message. */
  match?: string;
  level?: LogLevel;
  note?: string;
  enabled: boolean;
  created: string;
};

export type StoredEntry = LogEntry & {
  /** Identifies this ONE occurrence — the handle for an annotation. */
  hash: string;
  /** Identifies the CLASS (level + event + message with the variables blanked),
   *  so 400 copies of the same failure collapse into one line. */
  group: string;
  _annotation?: Annotation;
  /** Set when a mute rule hid this entry (only visible with show_muted). */
  _muted?: string;
};

export type ErrorLogQuery = {
  date?: string;
  level?: LogLevel;
  src?: LogSource;
  evt?: string;
  sid?: string;
  did?: string;
  user?: string;
  reqId?: string;
  status?: number;
  q?: string;
  limit?: number;
  showSolved?: boolean;
  showMuted?: boolean;
};

// ── Hashing ───────────────────────────────────────────────────────────
function md5(input: string, length: number): string {
  return createHash('md5').update(input).digest('hex').slice(0, length);
}

/** Blank out the parts that differ between two copies of the same problem:
 *  ids, timings, counts, tokens. What is left is the shape of the failure. */
function normalizeMessage(msg: string): string {
  return msg
    .toLowerCase()
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<uuid>')
    .replace(/[0-9a-f]{15,}/g, '<id>')
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

export function entryHash(e: LogEntry): string {
  return md5(`${e.t}|${e.evt}|${e.msg || ''}|${e.seq}`, 12);
}

export function entryGroup(e: LogEntry): string {
  return md5(`${e.lvl}|${e.evt}|${normalizeMessage(e.msg || '')}`, 10);
}

// ── Triage store (annotations + mute rules) ───────────────────────────
type NotesFile = { annotations: Record<string, Annotation>; muteRules: MuteRule[] };

function notesPath(): string { return path.join(logDir(), 'log-notes.json'); }

let writeChain: Promise<unknown> = Promise.resolve();

export async function readNotes(): Promise<NotesFile> {
  try {
    const raw = await readFile(notesPath(), 'utf8');
    const parsed = JSON.parse(raw) as Partial<NotesFile>;
    return {
      annotations: parsed.annotations && typeof parsed.annotations === 'object' ? parsed.annotations : {},
      muteRules: Array.isArray(parsed.muteRules) ? parsed.muteRules : [],
    };
  } catch {
    // Missing file is the normal first-run case; a corrupt one must not take the
    // whole error console down with it.
    return { annotations: {}, muteRules: [] };
  }
}

/** Read-modify-write, serialized in-process, via a temp file + rename so a
 *  crash mid-write cannot leave a half-written JSON behind. */
async function updateNotes<T>(mutate: (notes: NotesFile) => T | Promise<T>): Promise<T> {
  const run = writeChain.then(async () => {
    const notes = await readNotes();
    const result = await mutate(notes);
    const tmp = `${notesPath()}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(notes, null, 2), 'utf8');
    await rename(tmp, notesPath());
    return result;
  });
  writeChain = run.catch(() => undefined);
  return run;
}

export async function annotate(input: {
  hashes: string[];
  status: AnnotationStatus;
  note?: string;
  commit?: string;
  date?: string;
}): Promise<{ updated: number }> {
  return updateNotes((notes) => {
    for (const hash of input.hashes) {
      notes.annotations[hash] = {
        status: input.status,
        note: input.note || undefined,
        commit: input.commit || undefined,
        date: input.date || undefined,
        updated: new Date().toISOString(),
      };
    }
    return { updated: input.hashes.length };
  });
}

export async function listAnnotations(filter: { status?: AnnotationStatus; date?: string } = {}) {
  const { annotations } = await readNotes();
  return Object.entries(annotations)
    .filter(([, a]) => (!filter.status || a.status === filter.status) && (!filter.date || a.date === filter.date))
    .map(([hash, a]) => ({ hash, ...a }))
    .sort((a, b) => b.updated.localeCompare(a.updated));
}

export async function listMuteRules(): Promise<MuteRule[]> {
  return (await readNotes()).muteRules;
}

export async function addMuteRule(input: { evt?: string; match?: string; level?: LogLevel; note?: string }): Promise<MuteRule> {
  const rule: MuteRule = {
    id: randomUUID().slice(0, 8),
    evt: input.evt?.trim() || undefined,
    match: input.match?.trim() || undefined,
    level: input.level,
    note: input.note?.trim() || undefined,
    enabled: true,
    created: new Date().toISOString(),
  };
  await updateNotes((notes) => { notes.muteRules.push(rule); });
  return rule;
}

export async function setMuteRuleEnabled(id: string, enabled: boolean): Promise<boolean> {
  return updateNotes((notes) => {
    const rule = notes.muteRules.find((r) => r.id === id);
    if (!rule) return false;
    rule.enabled = enabled;
    return true;
  });
}

export async function deleteMuteRule(id: string): Promise<boolean> {
  return updateNotes((notes) => {
    const before = notes.muteRules.length;
    notes.muteRules = notes.muteRules.filter((r) => r.id !== id);
    return notes.muteRules.length < before;
  });
}

function matchingMuteRule(entry: LogEntry, rules: MuteRule[]): MuteRule | undefined {
  const msg = (entry.msg || '').toLowerCase();
  return rules.find((r) => {
    if (!r.enabled) return false;
    if (!r.evt && !r.match && !r.level) return false; // a rule matching everything is never what was meant
    if (r.level && entry.lvl !== r.level) return false;
    if (r.evt && !entry.evt.toLowerCase().startsWith(r.evt.toLowerCase())) return false;
    if (r.match && !msg.includes(r.match.toLowerCase())) return false;
    return true;
  });
}

// ── Reading a day ─────────────────────────────────────────────────────
function matches(e: LogEntry, opts: ErrorLogQuery, needle?: string): boolean {
  if (opts.level && LEVEL_ORDER[e.lvl] < LEVEL_ORDER[opts.level]) return false;
  if (opts.src && e.src !== opts.src) return false;
  if (opts.evt && !e.evt.toLowerCase().startsWith(opts.evt.toLowerCase())) return false;
  if (opts.sid && e.sid !== opts.sid) return false;
  if (opts.did && e.did !== opts.did) return false;
  if (opts.reqId && e.reqId !== opts.reqId) return false;
  if (opts.user && !(e.user || '').toLowerCase().includes(opts.user.toLowerCase())) return false;
  if (opts.status != null && Number(e.data?.status) !== opts.status) return false;
  if (needle && !JSON.stringify(e).toLowerCase().includes(needle)) return false;
  return true;
}

const HARD_LIMIT = 2_000;

/**
 * Every matching entry of one day, newest first.
 *
 * Streams the file line by line rather than reading it whole: a carpet-bombing
 * day is tens of megabytes, and the reason to open this endpoint is usually
 * that something is already going wrong on the box.
 */
export async function readDay(opts: ErrorLogQuery = {}): Promise<{
  date: string;
  entries: StoredEntry[];
  scanned: number;
  matched: number;
  hidden: { solved: number; muted: number };
  source: 'file' | 'ring';
}> {
  const date = opts.date || localDate();
  const limit = Math.min(Math.max(opts.limit ?? 200, 1), HARD_LIMIT);
  const needle = opts.q?.trim().toLowerCase() || undefined;
  const { annotations, muteRules } = await readNotes();
  const enabledRules = muteRules.filter((r) => r.enabled);

  // Today's last seconds are still in the batch buffer; get them onto disk
  // before reading, or the newest — most interesting — lines are missing.
  if (date === localDate()) await flushNow().catch(() => undefined);

  const kept: StoredEntry[] = [];
  const hidden = { solved: 0, muted: 0 };
  let scanned = 0;
  let matched = 0;

  // Keep only the newest `limit` matches while streaming, so memory stays flat
  // whatever the file size.
  const push = (entry: StoredEntry) => {
    kept.push(entry);
    if (kept.length > limit) kept.shift();
  };

  const take = (e: LogEntry) => {
    scanned++;
    if (!matches(e, opts, needle)) return;
    const hash = entryHash(e);
    const annotation = annotations[hash];
    if (annotation?.status === 'solved' && !opts.showSolved) { hidden.solved++; return; }
    // An explicit "important" outranks any mute rule: it was flagged by a human
    // who wanted to see it again.
    if (annotation?.status !== 'important') {
      const muted = matchingMuteRule(e, enabledRules);
      if (muted && !opts.showMuted) { hidden.muted++; return; }
      if (muted) {
        matched++;
        push({ ...e, hash, group: entryGroup(e), _annotation: annotation, _muted: muted.id });
        return;
      }
    }
    matched++;
    push({ ...e, hash, group: entryGroup(e), _annotation: annotation });
  };

  if (fileSinkEnabled()) {
    const file = logFileFor(date);
    try {
      const stream = createReadStream(file, { encoding: 'utf8' });
      const lines = createInterface({ input: stream, crlfDelay: Infinity });
      for await (const line of lines) {
        if (!line.trim()) continue;
        let parsed: LogEntry;
        try { parsed = JSON.parse(line) as LogEntry; } catch { continue; }
        take(parsed);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      // No file for that date: fall through with an empty result, which is the
      // honest answer (the endpoint lists the dates that exist).
    }
    return { date, entries: kept.reverse(), scanned, matched, hidden, source: 'file' };
  }

  // LOG_TO_FILE=0 (or a sink in its cooldown): the ring is all there is.
  for (const e of ringEntries()) take(e);
  return { date, entries: kept.reverse(), scanned, matched, hidden, source: 'ring' };
}

export type LogGroup = {
  group: string;
  lvl: LogLevel;
  src: LogSource;
  evt: string;
  msg?: string;
  count: number;
  first: string;
  last: string;
  users: string[];
  sessions: number;
  /** Newest occurrence — the handle to annotate, plus its data payload. */
  sample: StoredEntry;
  /** Every occurrence's hash (capped), so the console can mark a whole group
   *  solved in one call instead of the one line that happened to be on screen. */
  hashes: string[];
};

/** Collapse a day's matches into one row per distinct failure, biggest first.
 *  This is the view that answers "what is broken today" in ten lines. */
export function groupEntries(entries: StoredEntry[]): LogGroup[] {
  const byGroup = new Map<string, LogGroup & { _sids: Set<string> }>();
  for (const e of entries) {
    const cur = byGroup.get(e.group);
    if (!cur) {
      byGroup.set(e.group, {
        group: e.group, lvl: e.lvl, src: e.src, evt: e.evt, msg: e.msg,
        count: 1, first: e.t, last: e.t,
        users: e.user ? [e.user] : [],
        sessions: e.sid ? 1 : 0,
        sample: e,
        hashes: [e.hash],
        _sids: new Set(e.sid ? [e.sid] : []),
      });
      continue;
    }
    cur.count++;
    if (cur.hashes.length < 500) cur.hashes.push(e.hash);
    if (e.t < cur.first) cur.first = e.t;
    if (e.t > cur.last) { cur.last = e.t; cur.sample = e; }
    if (e.user && !cur.users.includes(e.user) && cur.users.length < 20) cur.users.push(e.user);
    if (e.sid) cur._sids.add(e.sid);
  }
  return [...byGroup.values()]
    .map(({ _sids, ...g }) => ({ ...g, sessions: _sids.size }))
    .sort((a, b) => b.count - a.count || b.last.localeCompare(a.last));
}

/** The days that actually have a log file, newest first. */
export async function listDays(): Promise<Array<{ date: string; bytes: number; modified: string }>> {
  try {
    const names = await readdir(logDir());
    const days = await Promise.all(
      names
        .filter((n) => /^svrz-\d{4}-\d{2}-\d{2}\.jsonl$/.test(n))
        .map(async (n) => {
          const info = await stat(path.join(logDir(), n));
          return { date: n.slice(5, 15), bytes: info.size, modified: new Date(info.mtimeMs).toISOString() };
        }),
    );
    return days.sort((a, b) => b.date.localeCompare(a.date));
  } catch {
    return [];
  }
}
