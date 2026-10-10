// PocketBase's record API — getList, getFullList, getFirstListItem, getOne,
// create, update, delete — answered from Postgres through Prisma.
//
// Phase 1 of docs/postgres-prisma-plan.md: the database moved, the 200-odd
// queries in server/index.ts did not. Each call here behaves as the PocketBase
// SDK call it replaces did against PocketBase 0.40.5, down to the details the
// server leans on without saying so:
//
//   - records are plain objects with PocketBase's keys in PocketBase's order
//     (alphabetical: they were Go maps), `collectionId`/`collectionName`
//     included, `created`/`updated` as "2026-10-10 17:23:41.040Z" text, ''
//     for empty text and relations, null for empty JSON;
//   - errors are the SDK's own ClientResponseError with PocketBase's status,
//     message and data, because callers match on `String(error)` ("…404…",
//     "wasn't found", "Missing collection context");
//   - a write is first serialised as JSON, as the SDK did, then coerced field
//     by field the way PocketBase coerced it (42 → "42" in a text field, ""
//     → 0 in a number, an object's keys sorted inside a JSON field);
//   - filters and sorts: see ./filter.ts.
//
// The typed rewrite (phase 1b) replaces these calls area by area with direct
// Prisma queries; this file shrinks as it does.

import { randomInt } from 'node:crypto';
import { ClientResponseError } from 'pocketbase';
import { Prisma } from './generated/client.ts';
import { prisma } from './client.ts';
import { COLLECTIONS, type CollectionMeta, type FieldMeta } from './collections.ts';
import { FilterError, filterToWhere, sortToOrderBy } from './filter.ts';
import { removeFile, removeRecordFiles, saveFile, storedName } from './files.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRecord = Record<string, any>;

export type ListOptions = {
  filter?: string;
  sort?: string;
  fields?: string;
  expand?: string;
  skipTotal?: boolean;
  batch?: number;
  [key: string]: unknown;
};

export type ListResult<T> = { items: T[]; page: number; perPage: number; totalItems: number; totalPages: number };

const NOT_FOUND = "The requested resource wasn't found.";
const BAD_REQUEST = 'Something went wrong while processing your request.';

function pbError(status: number, message: string, data: Record<string, unknown> = {}, originalError?: unknown, url = ''): ClientResponseError {
  return new ClientResponseError({ url, status, response: { data, message, status }, isAbort: false, originalError });
}

/** The SDK's own synthetic 404s (getFirstListItem with no match, getOne('')). */
function sdkNotFound(message: string): ClientResponseError {
  return new ClientResponseError({ status: 404, response: { code: 404, message, data: {} } });
}

const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
/** A PocketBase-shaped id: 15 characters of [a-z0-9]. */
export function newRecordId(): string {
  let id = '';
  for (let i = 0; i < 15; i++) id += ID_ALPHABET[randomInt(ID_ALPHABET.length)];
  return id;
}

/** PocketBase's text form of a timestamp. */
export function pbStamp(d: Date | null | undefined): string {
  return d instanceof Date ? d.toISOString().replace('T', ' ') : '';
}

// ── values coming out ────────────────────────────────────────────────

function outValue(f: FieldMeta, v: unknown): unknown {
  switch (f.type) {
    case 'text':
    case 'file':
    case 'relation':
      return v ?? '';
    case 'number':
      return typeof v === 'number' ? v : Number(v ?? 0);
    case 'bool':
      return Boolean(v);
    case 'json':
      return v === undefined ? null : v;
    case 'autodate':
      return v instanceof Date ? pbStamp(v) : '';
  }
}

/** The `fields` option as a set of top-level keys; null means everything. */
function pickOf(fields: string | undefined): Set<string> | null {
  if (!fields) return null;
  const set = new Set<string>();
  for (const raw of String(fields).split(',')) {
    const name = raw.trim().replace(/:excerpt\(.*\)$/, '');
    if (!name) continue;
    if (name === '*') return null;
    set.add(name.startsWith('expand.') ? 'expand' : name);
  }
  return set;
}

function toRecord(meta: CollectionMeta, row: AnyRecord, pick: Set<string> | null, expand?: AnyRecord): AnyRecord {
  const full: AnyRecord = { collectionId: meta.id, collectionName: meta.name };
  for (const f of meta.fields) if (f.name in row) full[f.name] = outValue(f, row[f.name]);
  if (expand && Object.keys(expand).length > 0) full.expand = expand;
  // PocketBase records were Go maps, serialised with their keys sorted.
  const out: AnyRecord = {};
  for (const key of Object.keys(full).sort()) {
    if (pick && !pick.has(key)) continue;
    out[key] = full[key];
  }
  return out;
}

// ── values going in ──────────────────────────────────────────────────

/** Strings as PocketBase (Go) stored them: lone surrogates become U+FFFD.
 *  NUL is dropped — Postgres text cannot hold it, SQLite could. */
function cleanText(s: string): string {
  const wellFormed = s.toWellFormed();
  return wellFormed.includes('\u0000') ? wellFormed.replaceAll('\u0000', '') : wellFormed;
}

function toText(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return cleanText(v);
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  // PocketBase could not turn an object into text and stored ''. Say so: the
  // caller almost certainly meant to JSON.stringify it.
  console.warn('[db] an object written to a text field was stored as empty text');
  return '';
}

function toNumber(v: unknown): number {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'string' && /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(v)) return Number(v);
  return 0;
}

const TRUE_TEXT = new Set(['1', 't', 'T', 'TRUE', 'true', 'True']);

function toBool(v: unknown): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') return TRUE_TEXT.has(v);
  return false;
}

/** JSON values as PocketBase's JSON field stored them. */
function sortedJson(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortedJson);
  if (v && typeof v === 'object') {
    const out: AnyRecord = {};
    for (const k of Object.keys(v).sort()) out[cleanText(k)] = sortedJson((v as AnyRecord)[k]);
    return out;
  }
  return typeof v === 'string' ? cleanText(v) : v;
}

function wellFormedDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(wellFormedDeep);
  if (v && typeof v === 'object') {
    const out: AnyRecord = {};
    for (const [k, x] of Object.entries(v)) out[cleanText(k)] = wellFormedDeep(x);
    return out;
  }
  return typeof v === 'string' ? cleanText(v) : v;
}

function toJson(v: unknown): unknown {
  if (v === null || v === undefined) return Prisma.DbNull;
  if (typeof v === 'string') {
    // PocketBase's rules for a plain string sent to a JSON field: JSON-looking
    // text is stored as that JSON (as written — keys NOT sorted); anything
    // else, the empty string included, is stored as a JSON string.
    if (v === 'null') return Prisma.JsonNull;
    if (v === 'true' || v === 'false') return v === 'true';
    if (/^[0-9\-"[{]/.test(v)) {
      try { return wellFormedDeep(JSON.parse(v)); } catch { /* not JSON: a string */ }
    }
    return cleanText(v);
  }
  return sortedJson(v);
}

function toRelation(v: unknown): string | null {
  let ids: string[] = [];
  if (Array.isArray(v)) ids = v.map((x) => String(x ?? ''));
  else if (typeof v === 'string') {
    const s = v.trim();
    if (s.startsWith('[')) {
      try { const parsed = JSON.parse(s); if (Array.isArray(parsed)) ids = parsed.map((x) => String(x ?? '')); } catch { ids = [s]; }
    } else ids = [s];
  } else if (v !== null && v !== undefined) ids = [String(v)];
  ids = ids.map((x) => x.trim()).filter(Boolean);
  // A single relation keeps the last id given, as PocketBase did.
  return ids.length > 0 ? ids[ids.length - 1] : null;
}

type Upload = { field: FieldMeta; name: string; data: Buffer };

type Prepared = {
  data: AnyRecord;
  uploads: Upload[];
  /** File fields whose current file goes (replaced, or cleared). */
  replacedFiles: string[];
};

function isBlob(v: unknown): v is Blob {
  return typeof Blob !== 'undefined' && v instanceof Blob;
}

async function prepare(meta: CollectionMeta, body: unknown, mode: 'create' | 'update', existing: AnyRecord | null): Promise<Prepared> {
  // What reached PocketBase: a FormData as its entries, anything else as the
  // SDK's JSON body (undefined keys dropped, Dates as ISO text, NaN as null).
  const entries: [string, unknown][] = [];
  const blobs: [string, Blob][] = [];
  if (typeof FormData !== 'undefined' && body instanceof FormData) {
    for (const [k, v] of body.entries()) {
      if (isBlob(v)) blobs.push([k, v]);
      else entries.push([k, v]);
    }
  } else if (body && typeof body === 'object') {
    const plain: AnyRecord = {};
    for (const [k, v] of Object.entries(body as AnyRecord)) {
      if (isBlob(v)) blobs.push([k, v]);
      else plain[k] = v;
    }
    entries.push(...Object.entries(JSON.parse(JSON.stringify(plain)) as AnyRecord));
  }

  const data: AnyRecord = {};
  const uploads: Upload[] = [];
  const replacedFiles: string[] = [];

  for (const [key, raw] of entries) {
    if (/^[+-]|[+-]$/.test(key)) {
      console.warn(`[db] ${meta.name}: field modifiers (${key}) are not supported`);
      throw pbError(400, mode === 'create' ? 'Failed to create record.' : 'Failed to update record.');
    }
    if (key === 'id') {
      if (mode === 'create' && raw !== '' && raw !== null) {
        if (typeof raw !== 'string' || !/^[a-z0-9]{15}$/.test(raw)) {
          throw pbError(400, 'Failed to create record.', { id: { code: 'validation_invalid_format', message: 'Invalid value format.' } });
        }
        data.id = raw;
      }
      continue;
    }
    const f = meta.fields.find((x) => x.name === key);
    if (!f || f.type === 'autodate') continue; // PocketBase ignored unknown fields and its own stamps
    switch (f.type) {
      case 'text': data[key] = toText(raw); break;
      case 'number': data[key] = toNumber(raw); break;
      case 'bool': data[key] = toBool(raw); break;
      case 'json': data[key] = toJson(raw); break;
      case 'relation': data[key] = toRelation(raw); break;
      case 'file': {
        // A string keeps the current file when it names it; anything else
        // (empty, null, another name) leaves the field without one.
        const keep = existing && typeof raw === 'string' && raw !== '' && raw === existing[key];
        if (!keep) {
          if (existing?.[key]) replacedFiles.push(key);
          data[key] = '';
        }
        break;
      }
    }
  }

  for (const [key, blob] of blobs) {
    const f = meta.fields.find((x) => x.name === key);
    if (!f || f.type !== 'file') continue;
    const buf = Buffer.from(await blob.arrayBuffer());
    if (f.maxSize && buf.length > f.maxSize) {
      throw pbError(400, mode === 'create' ? 'Failed to create record.' : 'Failed to update record.', {
        [key]: {
          code: 'validation_file_size_limit',
          message: `Failed to upload ${(blob as File).name ?? 'file'} - the maximum allowed file size is ${f.maxSize} bytes.`,
          params: { file: (blob as File).name ?? 'file', maxSize: f.maxSize },
        },
      });
    }
    const name = storedName((blob as File).name || 'file');
    // One file per field: a second upload in the same request replaces the first.
    const prior = uploads.findIndex((u) => u.field.name === key);
    if (prior >= 0) uploads.splice(prior, 1);
    uploads.push({ field: f, name, data: buf });
    data[key] = name;
    if (existing?.[key] && !replacedFiles.includes(key)) replacedFiles.push(key);
  }

  // Required fields may not end up empty.
  const missing: AnyRecord = {};
  for (const f of meta.fields) {
    if (!f.required) continue;
    const value = f.name in data ? data[f.name] : mode === 'create' ? '' : existing?.[f.name];
    if (value === '' || value === null || value === undefined) {
      missing[f.name] = { code: 'validation_required', message: 'Cannot be blank.' };
    }
  }
  if (Object.keys(missing).length > 0) {
    throw pbError(400, mode === 'create' ? 'Failed to create record.' : 'Failed to update record.', missing);
  }
  return { data, uploads, replacedFiles };
}

/** A database error as the PocketBase error the caller expects. */
function writeError(meta: CollectionMeta, error: unknown, mode: 'create' | 'update' | 'delete'): unknown {
  const code = (error as { code?: string })?.code;
  const message = mode === 'create' ? 'Failed to create record.' : mode === 'update' ? 'Failed to update record.' : 'Failed to delete record. Make sure that the record is not part of a required relation reference.';
  if (code === 'P2025') return pbError(404, NOT_FOUND, {}, error);
  if (code === 'P2002') {
    const target = (error as { meta?: { target?: unknown } }).meta?.target;
    const fields = Array.isArray(target) ? target.map(String) : [];
    const field = fields[0] ?? meta.fields.find((f) => String(target ?? '').includes(f.name))?.name ?? 'id';
    return pbError(400, message, { [field]: { code: 'validation_not_unique', message: 'Value must be unique.' } }, error);
  }
  if (code === 'P2003') {
    const text = `${(error as { meta?: { field_name?: unknown; constraint?: unknown } }).meta?.field_name ?? ''} ${(error as Error).message}`;
    const field = meta.fields.find((f) => f.type === 'relation' && text.includes(`${meta.name}_${f.name}_fkey`))?.name
      ?? meta.fields.find((f) => f.type === 'relation')?.name ?? 'id';
    return pbError(400, message, { [field]: { code: 'validation_missing_rel_records', message: 'Failed to find all relation records with the provided ids.' } }, error);
  }
  return dbFailure(meta, error);
}

/** Anything else — the database down, a bug — logged once with its cause and
 *  thrown on as status 0, what the SDK reported when PocketBase did not answer
 *  (a 400 would send callers down their "retry a simpler query" paths). No
 *  SQL reaches a client either way. A filter this layer cannot translate is
 *  PocketBase's 400 for a filter it could not parse. */
function dbFailure(meta: CollectionMeta, error: unknown): unknown {
  if (error instanceof ClientResponseError) return error;
  if (error instanceof FilterError) {
    console.warn(`[db] ${meta.name}: query not supported — ${error.message}`);
    return pbError(400, BAD_REQUEST, {}, error);
  }
  console.error(`[db] ${meta.name}: database call failed`, error);
  return pbError(0, BAD_REQUEST, {}, error);
}

// ── the collection ───────────────────────────────────────────────────

export class RecordCollection {
  constructor(readonly name: string) {}

  private get meta(): CollectionMeta {
    const meta = COLLECTIONS[this.name];
    if (!meta) throw pbError(404, 'Missing collection context.');
    return meta;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private get delegate(): any {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (prisma() as any)[this.meta.delegate];
  }

  /** Columns to read: what `fields` asks for, plus what expand needs. */
  private selectFor(pick: Set<string> | null, expandNames: string[]): AnyRecord | undefined {
    if (!pick) return undefined;
    const select: AnyRecord = { id: true };
    for (const f of this.meta.fields) if (pick.has(f.name)) select[f.name] = true;
    for (const n of expandNames) select[n] = true;
    return select;
  }

  private expandNames(expand: string | undefined): string[] {
    if (!expand) return [];
    const names: string[] = [];
    for (const raw of String(expand).split(',')) {
      const name = raw.trim();
      if (!name) continue;
      if (name.includes('.')) throw new FilterError('nested expand is not supported');
      const f = this.meta.fields.find((x) => x.name === name);
      // PocketBase skipped an expand it could not resolve.
      if (f?.type === 'relation' && !names.includes(name)) names.push(name);
    }
    return names;
  }

  private async records(rows: AnyRecord[], options: ListOptions): Promise<AnyRecord[]> {
    const meta = this.meta;
    const pick = pickOf(options.fields);
    const names = this.expandNames(options.expand);
    const expanded = new Map<string, AnyRecord>();
    const keepExpand = !pick || pick.has('expand');
    if (names.length > 0 && keepExpand) {
      for (const name of names) {
        const target = COLLECTIONS[meta.fields.find((f) => f.name === name)!.target!];
        const ids = [...new Set(rows.map((r) => r[name]).filter(Boolean))] as string[];
        if (ids.length === 0) continue;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const found: AnyRecord[] = await (prisma() as any)[target.delegate].findMany({ where: { id: { in: ids } } });
        for (const t of found) expanded.set(`${name}:${t.id}`, toRecord(target, t, null));
      }
    }
    return rows.map((row) => {
      const expand: AnyRecord = {};
      // Sorted like every other key PocketBase wrote from a map.
      for (const name of [...names].sort()) {
        const hit = row[name] ? expanded.get(`${name}:${row[name]}`) : undefined;
        if (hit) expand[name] = hit;
      }
      return toRecord(meta, row, pick, expand);
    });
  }

  async getList<T = AnyRecord>(page = 1, perPage = 30, options: ListOptions = {}): Promise<ListResult<T>> {
    const meta = this.meta;
    try {
      const p = Math.max(1, Math.floor(Number(page)) || 1);
      let pp = Math.floor(Number(perPage)) || 30;
      if (pp <= 0) pp = 30;
      if (pp > 1000) pp = 1000;
      const where = filterToWhere(options.filter, meta);
      const orderBy = sortToOrderBy(options.sort, meta);
      const select = this.selectFor(pickOf(options.fields), this.expandNames(options.expand));
      const rows: AnyRecord[] = await this.delegate.findMany({ where, orderBy, skip: (p - 1) * pp, take: pp, select });
      let totalItems = -1;
      let totalPages = -1;
      if (!options.skipTotal) {
        totalItems = await this.delegate.count({ where });
        totalPages = Math.ceil(totalItems / pp);
      }
      // PocketBase's own key order for a page (its Go struct), which routes
      // that pass a page straight through still answer with.
      return { items: (await this.records(rows, options)) as T[], page: p, perPage: pp, totalItems, totalPages };
    } catch (error) {
      throw dbFailure(meta, error);
    }
  }

  async getFullList<T = AnyRecord>(batchOrOptions?: number | ListOptions, maybeOptions?: ListOptions): Promise<T[]> {
    const options = (typeof batchOrOptions === 'object' && batchOrOptions ? batchOrOptions : maybeOptions) ?? {};
    const meta = this.meta;
    try {
      const where = filterToWhere(options.filter, meta);
      const orderBy = sortToOrderBy(options.sort, meta);
      const select = this.selectFor(pickOf(options.fields), this.expandNames(options.expand));
      const rows: AnyRecord[] = await this.delegate.findMany({ where, orderBy, select });
      return (await this.records(rows, options)) as T[];
    } catch (error) {
      throw dbFailure(meta, error);
    }
  }

  async getFirstListItem<T = AnyRecord>(filter: string, options: ListOptions = {}): Promise<T> {
    const page = await this.getList<T>(1, 1, { ...options, filter, skipTotal: true });
    if (page.items.length === 0) throw sdkNotFound(NOT_FOUND);
    return page.items[0];
  }

  async getOne<T = AnyRecord>(id: string, options: ListOptions = {}): Promise<T> {
    if (!id) throw sdkNotFound('Missing required record id.');
    const meta = this.meta;
    let row: AnyRecord | null;
    try {
      const select = this.selectFor(pickOf(options.fields), this.expandNames(options.expand));
      row = await this.delegate.findUnique({ where: { id: String(id) }, select });
    } catch (error) {
      throw dbFailure(meta, error);
    }
    if (!row) throw pbError(404, NOT_FOUND);
    try {
      return (await this.records([row], options))[0] as T;
    } catch (error) {
      throw dbFailure(meta, error);
    }
  }

  async create<T = AnyRecord>(body: unknown, options: ListOptions = {}): Promise<T> {
    const meta = this.meta;
    const { data, uploads } = await prepare(meta, body, 'create', null);
    const id = (data.id as string) || newRecordId();
    const now = new Date();
    const stamps: AnyRecord = {};
    for (const f of meta.fields) if (f.type === 'autodate') stamps[f.name] = now;
    let row: AnyRecord;
    try {
      row = await this.delegate.create({ data: { ...data, ...stamps, id } });
    } catch (error) {
      throw writeError(meta, error, 'create');
    }
    try {
      for (const u of uploads) await saveFile(meta.name, id, u.name, u.data);
    } catch (error) {
      // No record pointing at a file that is not there.
      await this.delegate.delete({ where: { id } }).catch(() => undefined);
      await removeRecordFiles(meta.name, id).catch(() => undefined);
      throw writeError(meta, error, 'create');
    }
    return (await this.records([row], options))[0] as T;
  }

  async update<T = AnyRecord>(id: string, body: unknown, options: ListOptions = {}): Promise<T> {
    const meta = this.meta;
    if (!id) throw sdkNotFound('Missing required record id.');
    let existing: AnyRecord | null;
    try {
      existing = await this.delegate.findUnique({ where: { id: String(id) } });
    } catch (error) {
      throw dbFailure(meta, error);
    }
    if (!existing) throw pbError(404, NOT_FOUND);
    const { data, uploads, replacedFiles } = await prepare(meta, body, 'update', existing);
    for (const u of uploads) await saveFile(meta.name, String(id), u.name, u.data);
    const stamps: AnyRecord = {};
    for (const f of meta.fields) if (f.type === 'autodate' && f.name === 'updated') stamps[f.name] = new Date();
    let row: AnyRecord;
    try {
      row = await this.delegate.update({ where: { id: String(id) }, data: { ...data, ...stamps } });
    } catch (error) {
      for (const u of uploads) await removeFile(meta.name, String(id), u.name).catch(() => undefined);
      throw writeError(meta, error, 'update');
    }
    for (const field of replacedFiles) {
      await removeFile(meta.name, String(id), String(existing[field])).catch(() => undefined);
    }
    return (await this.records([row], options))[0] as T;
  }

  async delete(id: string): Promise<boolean> {
    const meta = this.meta;
    if (!id) throw sdkNotFound('Missing required record id.');
    try {
      await this.delegate.delete({ where: { id: String(id) } });
    } catch (error) {
      throw writeError(meta, error, 'delete');
    }
    await removeRecordFiles(meta.name, String(id)).catch(() => undefined);
    return true;
  }
}

/** `pb.collection(name)`, on Postgres. An unknown name fails on first use
 *  with PocketBase's "Missing collection context." 404, as it did. */
export function collection(name: string): RecordCollection {
  return new RecordCollection(name);
}
