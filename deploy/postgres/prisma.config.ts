// Prisma 7 reads the connection from here, not from schema.prisma. It lives
// beside the CLI (deploy/postgres/package.json), not at the repo root: the CLI
// is a tool with its own dependencies, kept out of the app's. Paths are
// relative to this file. `prisma generate` needs no database, so a missing
// DATABASE_URL only matters to the commands that connect (migrate, studio).
import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: '../../prisma/schema.prisma',
  migrations: { path: '../../prisma/migrations' },
  datasource: { url: process.env.DATABASE_URL ?? '' },
});
