// `for await (const chunk of stream)` over a ReadableStream. pdf.js 6 reads
// every page's text that way (getTextContent), and Safari has no async
// iteration on streams up to 26.x — not even the legacy build brings it. On an
// iPad every page's text threw at once: the reader's search found nothing in
// 135 pages, the Home search could not look inside a document, and no word on
// a page could be selected (30.10.2026). Playwright's WebKit is newer than the
// shipping Safari and has it, so the suite never saw it.
//
// The spec's behaviour, over the reader every Safari has: done releases the
// lock, leaving the loop early cancels the stream unless preventCancel.
// Imported for its effect by every module that loads pdf.js.

type IterOptions = { preventCancel?: boolean };

export function installStreamIterator(proto: ReadableStream | undefined = globalThis.ReadableStream?.prototype): boolean {
  if (!proto || Symbol.asyncIterator in proto) return false;
  function values(this: ReadableStream, { preventCancel = false }: IterOptions = {}): AsyncIterableIterator<unknown> {
    const reader = this.getReader();
    return {
      async next() {
        try {
          const result = await reader.read();
          if (result.done) reader.releaseLock();
          return result;
        } catch (error) {
          reader.releaseLock();
          throw error;
        }
      },
      async return(value?: unknown) {
        if (preventCancel) reader.releaseLock();
        else {
          const cancelled = reader.cancel(value);
          reader.releaseLock();
          await cancelled;
        }
        return { done: true, value };
      },
      [Symbol.asyncIterator]() { return this; },
    };
  }
  for (const key of ['values', Symbol.asyncIterator] as const) {
    if (!(key in proto)) Object.defineProperty(proto, key, { value: values, writable: true, configurable: true });
  }
  return true;
}

installStreamIterator();
