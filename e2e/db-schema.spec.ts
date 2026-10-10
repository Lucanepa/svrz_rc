import { test, expect } from '@playwright/test';
import { readFileSync, readdirSync } from 'node:fs';
import { COLLECTIONS } from '../server/db/collections';

// Two descriptions of the same tables must not drift apart: the Prisma schema
// (what the database has) and server/db/collections.ts (what the record layer
// answers with — PocketBase's field order and types). A field added to one and
// not the other would either never be returned or never be written.

type PrismaField = { name: string; type: string; attrs: string };

function prismaModels(): Map<string, { model: string; fields: PrismaField[] }> {
  const src = readFileSync('prisma/schema.prisma', 'utf8');
  const out = new Map<string, { model: string; fields: PrismaField[] }>();
  for (const m of src.matchAll(/model (\w+) \{([\s\S]*?)\n\}/g)) {
    const body = m[2];
    const table = /@@map\("([^"]+)"\)/.exec(body)?.[1];
    if (!table) continue;
    const fields: PrismaField[] = [];
    for (const line of body.split('\n')) {
      const f = /^\s+(\w+)\s+(\S+)(.*)$/.exec(line);
      if (!f || f[1].startsWith('@@')) continue;
      fields.push({ name: f[1], type: f[2], attrs: f[3] });
    }
    out.set(table, { model: m[1], fields });
  }
  return out;
}

const EXPECTED: Record<string, (f: PrismaField) => boolean> = {
  text: (f) => f.type === 'String' && f.attrs.includes('@default("")'),
  file: (f) => f.type === 'String' && f.attrs.includes('@default("")'),
  number: (f) => f.type === 'Float' && f.attrs.includes('@default(0)'),
  bool: (f) => f.type === 'Boolean' && f.attrs.includes('@default(false)'),
  // `json`, not `jsonb`: PocketBase stored JSON as written, key order included.
  json: (f) => f.type === 'Json?' && f.attrs.includes('@db.Json'),
  relation: (f) => f.type === 'String?' && f.attrs.includes('@db.VarChar(15)'),
  autodate: (f) => f.type === 'DateTime?' && f.attrs.includes('@db.Timestamptz(3)'),
};

test('every collection is a Prisma model with the same fields, types and order', () => {
  const models = prismaModels();
  expect([...models.keys()].sort()).toEqual(Object.keys(COLLECTIONS).sort());
  for (const meta of Object.values(COLLECTIONS)) {
    const model = models.get(meta.name)!;
    expect(meta.delegate, meta.name).toBe(model.model[0].toLowerCase() + model.model.slice(1));
    // The scalar columns, minus the order column — every one described, in order.
    const scalar = model.fields.filter((f) => f.name !== 'seq' && ['String', 'String?', 'Float', 'Boolean', 'Json?', 'DateTime?'].includes(f.type));
    expect(scalar.map((f) => f.name), meta.name).toEqual(meta.fields.map((f) => f.name));
    for (const f of meta.fields) {
      const p = scalar.find((x) => x.name === f.name)!;
      if (f.name === 'id') { expect(p.attrs).toContain('@id'); continue; }
      expect(EXPECTED[f.type](p), `${meta.name}.${f.name} (${f.type}) is ${p.type}${p.attrs}`).toBe(true);
      if (f.type === 'relation') {
        const target = models.get(f.target!)!.model;
        const rel = model.fields.find((x) => x.name === `${f.name}_rec`);
        expect(rel?.type, `${meta.name}.${f.name}_rec`).toBe(`${target}?`);
        // PocketBase cleared the link when the target went; it never deleted the row.
        expect(rel?.attrs).toContain('onDelete: SetNull');
      }
      if (f.type === 'autodate' && f.name === 'updated') expect(p.attrs).toContain('@updatedAt');
    }
    // The order column every unsorted read and every tie relies on.
    expect(model.fields.find((f) => f.name === 'seq')?.attrs).toContain('@default(autoincrement())');
  }
});

test('the migrations create every table', () => {
  const sql = readdirSync('prisma/migrations', { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => readFileSync(`prisma/migrations/${d.name}/migration.sql`, 'utf8'))
    .join('\n');
  for (const name of Object.keys(COLLECTIONS)) expect(sql, name).toContain(`CREATE TABLE "${name}"`);
});

test('production Postgres is created to compare text byte by byte', () => {
  // server/db/client.ts refuses any other database at start; this keeps the
  // compose file from creating one.
  const compose = readFileSync('deploy/hetzner/docker-compose.yml', 'utf8');
  expect(compose).toContain('--locale-provider=builtin --builtin-locale=C.UTF-8');
  expect(compose).toMatch(/image: postgres:18\.\d+-alpine/);
});
