// What a notebook page becomes when it is lifted into the form: the page,
// verbatim, with trailing whitespace trimmed; several pages separated by one
// blank line. No bullet and no prefix — a free page is prose, not a list of
// remarks, and the PDF is always German, so nothing in the UI's language may
// travel with it. The four rich boxes take the result through
// appendPlainToRich (richText.ts); Tipps & Tricks is a plain textarea.

import type { NotebookPage } from './notebook';

export function pageBlock(page: NotebookPage): string {
  return (page.text || '').replace(/\s+$/, '');
}

export function importBlock(pages: NotebookPage[]): string {
  return pages.map(pageBlock).filter(Boolean).join('\n\n');
}
