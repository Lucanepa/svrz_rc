// The inside-the-documents search as a hook: Home's document card and the
// form's "Dokumente beilegen" both ask the same question of different lists.
import { useEffect, useState } from 'react';
import { searchDocText, type DocTextProgress, type DocTextResult } from './docText';
import type { UsefulDoc } from './usefulDocs';

/** Shorter than this, nearly every page matches and the answer is noise. */
export const DOC_TEXT_MIN_QUERY = 3;

export type DocTextSearch = {
  /** One entry per document with a hit, in the order they were searched. */
  results: DocTextResult[];
  searching: boolean;
  progress: DocTextProgress | null;
};

const IDLE: DocTextSearch = { results: [], searching: false, progress: null };

/** `refreshKey` re-runs the search when it changes — e.g. once more PDFs were
 *  saved to the device and can now be searched inside. */
export function useDocTextSearch(query: string, docs: UsefulDoc[], refreshKey: unknown = 0): DocTextSearch {
  const [state, setState] = useState<DocTextSearch>(IDLE);
  const q = query.trim();
  useEffect(() => {
    if (q.length < DOC_TEXT_MIN_QUERY) { setState(IDLE); return; }
    const abort = new AbortController();
    const found: DocTextResult[] = [];
    setState({ results: [], searching: true, progress: null });
    // Typing is not searching: wait for a pause before reading any PDF.
    const timer = window.setTimeout(() => {
      void searchDocText(
        q,
        docs,
        (result) => { found.push(result); if (!abort.signal.aborted) setState((s) => ({ ...s, results: [...found] })); },
        (progress) => {
          if (abort.signal.aborted) return;
          setState((s) => ({ ...s, progress, searching: progress.done < progress.total }));
        },
        abort.signal,
      ).catch(() => { if (!abort.signal.aborted) setState((s) => ({ ...s, searching: false })); });
    }, 300);
    return () => { abort.abort(); window.clearTimeout(timer); };
    // `docs` is a module-level constant list at both call sites.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, refreshKey]);
  return state;
}
