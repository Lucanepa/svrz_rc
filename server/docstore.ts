// The proxied documents' last good copies, kept on disk.
//
// loadProxiedDoc (index.ts) serves its last good copy when an upstream fails,
// but a copy held only in memory is gone after every deploy. On 21.10.2026
// svrz.ch answered every PDF with 503 a few hours after a restart, and every
// SVRZ sheet was unreadable in the app although we had served each of them the
// day before. Written here, the copy outlives the container: <DOC_CACHE_DIR>/
// <id>.pdf with <id>.json beside it.
//
// Unset DOC_CACHE_DIR means memory only, as before: development and the tests
// leave nothing behind. Nothing here throws to the reader: a copy that cannot
// be read is no copy, and the upstream is asked as if it were never there.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export type StoredDoc = {
  body: Buffer;
  /** What the browser sees; differs from upstreamEtag for a prefaced document. */
  etag: string;
  /** What we revalidate the upstream with. */
  upstreamEtag: string;
  checkedAt: number;
  /** The DOC_PREFACES version applied to the body, 0 for none or a failed one. */
  preface: number;
};

type Meta = Omit<StoredDoc, 'body'> & { bytes: number };

// The ids come from PROXIED_DOCS, never from a request — checked anyway.
const ID = /^[a-z0-9][a-z0-9-]*$/;

export function docStoreDir(): string | null {
  const dir = process.env.DOC_CACHE_DIR;
  return dir ? path.resolve(dir) : null;
}

export async function readStoredDoc(id: string): Promise<StoredDoc | null> {
  const dir = docStoreDir();
  if (!dir || !ID.test(id)) return null;
  try {
    const meta = JSON.parse(await readFile(path.join(dir, `${id}.json`), 'utf8')) as Partial<Meta>;
    const body = await readFile(path.join(dir, `${id}.pdf`));
    // The PDF and its meta are two writes; a crash between them leaves a pair
    // that does not belong together, and the length is what tells.
    if (body.byteLength !== meta.bytes || typeof meta.etag !== 'string' || typeof meta.upstreamEtag !== 'string') return null;
    return {
      body,
      etag: meta.etag,
      upstreamEtag: meta.upstreamEtag,
      checkedAt: Number(meta.checkedAt) || 0,
      preface: Number(meta.preface) || 0,
    };
  } catch {
    return null;
  }
}

/** Temp file + rename for each half, so a reader never sees a torn PDF. */
export async function writeStoredDoc(id: string, doc: StoredDoc): Promise<void> {
  const dir = docStoreDir();
  if (!dir || !ID.test(id)) return;
  await mkdir(dir, { recursive: true });
  const meta: Meta = {
    etag: doc.etag, upstreamEtag: doc.upstreamEtag, checkedAt: doc.checkedAt, preface: doc.preface,
    bytes: doc.body.byteLength,
  };
  const pdf = path.join(dir, `${id}.pdf`);
  const json = path.join(dir, `${id}.json`);
  await writeFile(`${pdf}.${process.pid}.tmp`, doc.body);
  await rename(`${pdf}.${process.pid}.tmp`, pdf);
  await writeFile(`${json}.${process.pid}.tmp`, JSON.stringify(meta), 'utf8');
  await rename(`${json}.${process.pid}.tmp`, json);
}
