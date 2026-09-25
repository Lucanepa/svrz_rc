// Searching INSIDE the documents of "Nützliche Infos & Dokumente".
//
// The titles only get a coach so far: "what does a double contact look like?"
// is answered on page 34 of a rulebook whose title says nothing of the sort.
// So the text of every document this device already holds is pulled out once
// with pdf.js, kept beside the PDF (Cache Storage, as JSON), and searched from
// there — instantly after the first time, and with no signal in the gym.
//
// Deliberately only what is stored: a search must not start a 7 MB download
// on somebody's data plan. What is not on the device is searched by title,
// and the card says how many that is and offers "Save all offline".

import { docSourceUrl, isDocStored, fetchDocBytes } from './docCache';
import type { UsefulDoc } from './usefulDocs';

/**
 * Lower-cased and stripped of accents, one character in one character out.
 *
 * Length has to survive folding: a hit is a pair of offsets into this string,
 * and the snippet (and the reader's highlight) is cut from the original text
 * at the same offsets. The usual `normalize('NFD').replace(...)` shortens "ü"
 * to "u" plus a mark and every offset after it drifts.
 */
export function foldText(s: string): string {
  let out = '';
  for (const ch of s) {
    const base = ch.normalize('NFD')[0].toLowerCase();
    out += base.length === 1 ? base : ch.toLowerCase()[0] || ch;
  }
  return out;
}

/** Bump when the extraction changes, so old text is pulled out again. */
const TEXT_CACHE = 'svrz-doctext-v1';
/** Per page, in page order. */
type DocPages = string[];
const memory = new Map<string, Promise<DocPages>>();

async function openTextCache(): Promise<Cache | null> {
  try {
    if (typeof caches === 'undefined') return null;
    return await caches.open(TEXT_CACHE);
  } catch {
    return null;
  }
}

async function extract(url: string): Promise<DocPages> {
  const [pdfjsLib, worker] = await Promise.all([
    import('pdfjs-dist/legacy/build/pdf.mjs'),
    import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'),
  ]);
  pdfjsLib.GlobalWorkerOptions.workerSrc = worker.default;
  const bytes = await fetchDocBytes(url);
  const task = pdfjsLib.getDocument({ data: new Uint8Array(bytes) });
  try {
    const pdf = await task.promise;
    const pages: DocPages = [];
    for (let n = 1; n <= pdf.numPages; n += 1) {
      const page = await pdf.getPage(n);
      const content = await page.getTextContent();
      let text = '';
      for (const item of content.items) {
        if (!('str' in item)) continue;
        text += item.str;
        // A line break is a space as far as searching goes, as in the reader.
        if (item.hasEOL) text += '\n';
      }
      pages.push(text);
    }
    return pages;
  } finally {
    void task.destroy();
  }
}

/** The document's text, page by page — from memory, the text cache, or pulled
 *  out of the stored PDF (and then kept). Null when the PDF is not on this
 *  device and its text never was. */
export async function docPages(url: string): Promise<DocPages | null> {
  const known = memory.get(url);
  if (known) return known;
  const cache = await openTextCache();
  if (cache) {
    try {
      const hit = await cache.match(url);
      if (hit) {
        const pages = hit.json() as Promise<DocPages>;
        memory.set(url, pages);
        return pages;
      }
    } catch { /* pull it out again below */ }
  }
  if (!(await isDocStored(url))) return null;
  const pending = extract(url);
  memory.set(url, pending);
  try {
    const pages = await pending;
    if (cache) {
      try { await cache.put(url, new Response(JSON.stringify(pages), { headers: { 'Content-Type': 'application/json' } })); } catch { /* over quota: memory still has it */ }
    }
    return pages;
  } catch (error) {
    memory.delete(url);
    throw error;
  }
}

export type DocTextHit = { page: number; before: string; match: string; after: string };
export type DocTextResult = { doc: UsefulDoc; hits: DocTextHit[]; total: number };
export type DocTextProgress = { done: number; total: number; unsaved: UsefulDoc[] };

/** How many snippets one document shows; the rest is a count. */
export const HITS_PER_DOC = 3;

/** The hits in one document's pages, the first few as snippets. */
export function findInPages(pages: DocPages, query: string): { hits: DocTextHit[]; total: number } {
  const needle = foldText(query.trim());
  const hits: DocTextHit[] = [];
  let total = 0;
  if (!needle) return { hits, total };
  pages.forEach((text, i) => {
    const folded = foldText(text);
    let at = folded.indexOf(needle);
    while (at !== -1) {
      total += 1;
      if (hits.length < HITS_PER_DOC) {
        const from = Math.max(0, at - 50);
        const to = Math.min(text.length, at + needle.length + 60);
        hits.push({
          page: i + 1,
          before: (from > 0 ? '…' : '') + text.slice(from, at).replace(/\s+/g, ' ').trimStart(),
          match: text.slice(at, at + needle.length),
          after: text.slice(at + needle.length, to).replace(/\s+/g, ' ').trimEnd() + (to < text.length ? '…' : ''),
        });
      }
      at = folded.indexOf(needle, at + needle.length);
    }
  });
  return { hits, total };
}

/**
 * Searches the text of every document in `docs` that this device holds.
 * Results arrive as they are found (`onResult`), so the first documents answer
 * while the rulebooks are still being read; `signal` stops a search the next
 * keystroke has replaced.
 */
export async function searchDocText(
  query: string,
  docs: UsefulDoc[],
  onResult: (result: DocTextResult) => void,
  onProgress: (progress: DocTextProgress) => void,
  signal: AbortSignal,
): Promise<void> {
  const readable = docs.filter((doc) => doc.kind === 'pdf' && docSourceUrl(doc));
  const unsaved: UsefulDoc[] = [];
  let done = 0;
  onProgress({ done, total: readable.length, unsaved });
  for (const doc of readable) {
    if (signal.aborted) return;
    try {
      const pages = await docPages(docSourceUrl(doc));
      if (signal.aborted) return;
      if (!pages) unsaved.push(doc);
      else {
        const found = findInPages(pages, query);
        if (found.total > 0) onResult({ doc, ...found });
      }
    } catch { /* a PDF pdf.js cannot read is searched by title only */ }
    done += 1;
    onProgress({ done, total: readable.length, unsaved: [...unsaved] });
  }
}
