// PocketBase → Postgres, truncate-and-reload, then proof.
//
//   MIGRATE_CONFIRM=wipe-postgres npx tsx deploy/postgres/migrate-from-pb.ts
//
// Needs POCKETBASE_URL + POCKETBASE_ADMIN_EMAIL/PASSWORD (a superuser),
// DATABASE_URL (migrated: `npx prisma migrate deploy`) and FILES_DIR.
//
// 1. Reads every collection from PocketBase in insertion order (@rowid), after
//    checking its fields are exactly the ones prisma/schema.prisma models.
// 2. Empties every table and loads the rows in that order, so `seq` keeps
//    PocketBase's order. Text, numbers, booleans and JSON as they are; ''
//    relations and stamps become NULL.
// 3. Copies each stored file (the filed PDFs) into FILES_DIR.
// 4. Proves it: every record read back THROUGH server/db/records.ts — the
//    layer the API uses — fingerprinted against the same record from the
//    PocketBase SDK, leaf by leaf, plus every file's bytes. Prints counts and
//    field paths only, never a value: the data is the association's.
//
// Ends with MIGRATION_OK or MIGRATION_MISMATCH (exit 1).

import { createHash } from 'node:crypto';
import PocketBase from 'pocketbase';
import { Prisma } from '../../server/db/generated/client.ts';
import { assertDatabase, disconnectDatabase, prisma } from '../../server/db/client.ts';
import { COLLECTIONS, type CollectionMeta } from '../../server/db/collections.ts';
import { readStoredFile, saveFile } from '../../server/db/files.ts';
import { collection } from '../../server/db/records.ts';

type AnyRecord = Record<string, any>;

if (process.env.MIGRATE_CONFIRM !== 'wipe-postgres') {
  console.error('This EMPTIES every table in DATABASE_URL first. Set MIGRATE_CONFIRM=wipe-postgres to go on.');
  process.exit(2);
}

const pb = new PocketBase(process.env.POCKETBASE_URL);
pb.autoCancellation(false);
await pb.collection('_superusers').authWithPassword(process.env.POCKETBASE_ADMIN_EMAIL!, process.env.POCKETBASE_ADMIN_PASSWORD!);
const locale = await assertDatabase();
console.log(`== database ok (provider ${locale.provider}, ${locale.locale})`);

// Targets of relations first, so every foreign key finds its row.
const metas = Object.values(COLLECTIONS);
const order: CollectionMeta[] = [
  ...metas.filter((m) => !m.fields.some((f) => f.type === 'relation')),
  ...metas.filter((m) => m.fields.some((f) => f.type === 'relation')),
];

// ── 1. read, after a schema check ────────────────────────────────────
const pbCollections = await pb.collections.getFullList();
const extra = pbCollections.filter((c) => c.type === 'base' && !c.system && !COLLECTIONS[c.name]).map((c) => c.name);
if (extra.length) {
  console.error(`PocketBase has collections the schema does not: ${extra.join(', ')}`);
  process.exit(1);
}
const source = new Map<string, AnyRecord[]>();
for (const meta of order) {
  const c = pbCollections.find((x) => x.name === meta.name);
  if (!c) { console.error(`PocketBase has no collection ${meta.name}`); process.exit(1); }
  const pbFields = c.fields.map((f: AnyRecord) => `${f.name}:${['email', 'url', 'select'].includes(f.type) ? 'text' : f.type}`).join(',');
  const ourFields = meta.fields.map((f) => `${f.name}:${f.type}`).join(',');
  if (pbFields !== ourFields) {
    console.error(`${meta.name}: PocketBase fields differ from the schema\n  pb:  ${pbFields}\n  ours: ${ourFields}`);
    process.exit(1);
  }
  source.set(meta.name, await pb.collection(meta.name).getFullList({ sort: '@rowid' }));
}
console.log(`== read ${[...source.values()].reduce((n, r) => n + r.length, 0)} records from ${source.size} collections`);

// ── 2. load ──────────────────────────────────────────────────────────
const stats = { nulStripped: 0, emptyStamps: 0 };

function rowOf(meta: CollectionMeta, rec: AnyRecord): AnyRecord {
  const row: AnyRecord = {};
  for (const f of meta.fields) {
    const v = rec[f.name];
    switch (f.type) {
      case 'text':
      case 'file': {
        const s = String(v ?? '');
        if (s.includes('\u0000')) stats.nulStripped++;
        row[f.name] = s.replaceAll('\u0000', '');
        break;
      }
      case 'number': row[f.name] = typeof v === 'number' ? v : Number(v ?? 0); break;
      case 'bool': row[f.name] = Boolean(v); break;
      case 'json': row[f.name] = v === null || v === undefined ? Prisma.DbNull : v; break;
      case 'relation': row[f.name] = v ? String(v) : null; break;
      case 'autodate':
        if (!v) { row[f.name] = null; stats.emptyStamps++; }
        else row[f.name] = new Date(String(v).replace(' ', 'T'));
        break;
    }
  }
  return row;
}

const tables = order.map((m) => `"${m.name}"`).join(', ');
await prisma().$executeRawUnsafe(`TRUNCATE ${tables} RESTART IDENTITY CASCADE`);
for (const meta of order) {
  const rows = source.get(meta.name)!.map((r) => rowOf(meta, r));
  const delegate = (prisma() as any)[meta.delegate];
  for (let i = 0; i < rows.length; i += 500) {
    // One INSERT per chunk, rows in order: `seq` follows PocketBase's rowid.
    await delegate.createMany({ data: rows.slice(i, i + 500) });
  }
}
console.log(`== loaded (empty created/updated stamps kept empty: ${stats.emptyStamps}; NUL characters dropped: ${stats.nulStripped})`);

// ── 3. files ─────────────────────────────────────────────────────────
const fileToken = await pb.files.getToken();
const fileHashes = new Map<string, string>();
let files = 0;
for (const meta of order) {
  for (const f of meta.fields.filter((x) => x.type === 'file')) {
    for (const rec of source.get(meta.name)!) {
      const name = String(rec[f.name] ?? '');
      if (!name) continue;
      const res = await fetch(pb.files.getURL(rec, name, { token: fileToken }));
      if (!res.ok) { console.error(`${meta.name}/${rec.id}: PocketBase did not serve its ${f.name} (HTTP ${res.status})`); process.exit(1); }
      const data = Buffer.from(await res.arrayBuffer());
      await saveFile(meta.name, rec.id, name, data);
      fileHashes.set(`${meta.name}/${rec.id}/${name}`, createHash('sha256').update(data).digest('hex'));
      files++;
    }
  }
}
console.log(`== copied ${files} files`);

// ── 4. proof ─────────────────────────────────────────────────────────
const h = (v: unknown) => createHash('sha256').update(JSON.stringify(v) ?? 'undefined').digest('hex').slice(0, 16);
function leaves(v: unknown, p: string, out: Record<string, string>) {
  if (v && typeof v === 'object') {
    const keys = Array.isArray(v) ? v.map((_, i) => String(i)) : Object.keys(v);
    if (keys.length === 0) out[p] = h(v);
    for (const k of keys) leaves((v as AnyRecord)[k], `${p}.${k}`, out);
  } else out[p] = h(v);
}
const shape = (rec: AnyRecord) => Object.keys(rec).join(',');

let mismatches = 0;
for (const meta of order) {
  const before = source.get(meta.name)!;
  const after = await collection(meta.name).getFullList<AnyRecord>();
  const problems: Record<string, number> = {};
  const note = (what: string) => { problems[what] = (problems[what] ?? 0) + 1; };
  if (before.length !== after.length) note(`count ${before.length} → ${after.length}`);
  if (before.map((r) => r.id).join() !== after.map((r) => r.id).join()) note('order of records');
  const byId = new Map(after.map((r) => [r.id, r]));
  for (const b of before) {
    const a = byId.get(b.id);
    if (!a) { note('missing record'); continue; }
    if (shape(a) !== shape(b)) note('key order');
    const lb: Record<string, string> = {}; leaves(b, '', lb);
    const la: Record<string, string> = {}; leaves(a, '', la);
    for (const p of new Set([...Object.keys(lb), ...Object.keys(la)])) {
      // JSON key order inside a value is compared too (`leaves` walks in key order).
      if (lb[p] !== la[p]) note(`value ${p.replace(/\.\d+(?=\.|$)/g, '.#')}`);
    }
    if (Object.keys(lb).join() !== Object.keys(la).join()) note('leaf order');
  }
  for (const [key, hash] of fileHashes) {
    const [c, id, name] = key.split('/');
    if (c !== meta.name) continue;
    const data = await readStoredFile(c, id, name);
    if (!data || createHash('sha256').update(data).digest('hex') !== hash) note('file bytes');
  }
  const n = Object.values(problems).reduce((x, y) => x + y, 0);
  mismatches += n;
  console.log(`${n === 0 ? 'same' : 'DIFF'} ${meta.name.padEnd(26)} ${String(before.length).padStart(5)} records${n ? '  ' + JSON.stringify(problems) : ''}`);
}

await disconnectDatabase();
if (mismatches > 0) {
  console.log(`MIGRATION_MISMATCH (${mismatches})`);
  process.exit(1);
}
console.log('MIGRATION_OK');
