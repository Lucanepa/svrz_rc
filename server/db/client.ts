// The one Prisma client of the API process, over node-postgres.

import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/client.ts';

let client: PrismaClient | null = null;

export function prisma(): PrismaClient {
  client ??= new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
  });
  return client;
}

/**
 * Refuse to run on a database that compares text differently from SQLite.
 *
 * Every query still compares and sorts text the way PocketBase did — byte by
 * byte. A database created with a language locale would order "Zürich" and
 * "zug" differently, put "2026-10-10 15:00" after "2026-10-10T10:00", and
 * nothing would fail: lists would just come back in another order. So the
 * locale is checked once at start instead of trusted.
 */
export async function assertDatabase(): Promise<{ provider: string; locale: string }> {
  const rows = await prisma().$queryRaw<{ provider: string; locale: string | null; collate: string }[]>`
    SELECT datlocprovider::text AS provider, datlocale AS locale, datcollate AS collate
    FROM pg_database WHERE datname = current_database()`;
  const row = rows[0];
  const byteOrder = row && (
    (row.provider === 'b' && (row.locale === 'C.UTF-8' || row.locale === 'C'))
    || (row.provider === 'c' && (row.collate === 'C' || row.collate === 'POSIX'))
  );
  if (!byteOrder) {
    throw new Error(`database must compare text byte-wise (builtin C.UTF-8); found provider=${row?.provider} locale=${row?.locale ?? row?.collate}`);
  }
  return { provider: row.provider, locale: row.locale ?? row.collate };
}

export async function disconnectDatabase(): Promise<void> {
  if (client) await client.$disconnect();
  client = null;
}
