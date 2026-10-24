// The constants Vite defines at build time (vite.config.ts `define`), for the
// specs that import app modules straight into Node: src/lib/buildInfo.ts reads
// __APP_VERSION__ at import, and src/lib/notebook.ts reaches it through
// formDraft.ts. Imported FIRST by such a spec, before the module under test,
// so the names exist when that module is evaluated (25.10.2026).
const g = globalThis as Record<string, unknown>;
if (g.__APP_VERSION__ === undefined) g.__APP_VERSION__ = '0.0.0-spec';
if (g.__BUILD_SHA__ === undefined) g.__BUILD_SHA__ = 'spec';
if (g.__BUILD_TIME__ === undefined) g.__BUILD_TIME__ = '2026-10-25T00:00:00.000Z';

export {};
