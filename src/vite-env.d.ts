/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

declare const __APP_VERSION__: string;
declare const __BUILD_SHA__: string;
declare const __BUILD_TIME__: string;

interface Window {
  /**
   * True while an observation form holds work that exists nowhere else — i.e.
   * it is not (yet) committed to the `svrz-drafts` IndexedDB store, or this
   * device cannot store drafts at all. The service-worker auto-update reads it
   * and postpones its reload; with drafts durable this is normally a window of
   * about a second rather than the length of a match.
   */
  __svrzFormDirty?: boolean;
  /**
   * Commits the in-progress observation to IndexedDB. Awaited (with a 1.5 s
   * ceiling) before a service-worker reload, so the reload no longer has to
   * wait for the coach to finish.
   */
  __svrzFlushDraft?: () => Promise<void>;
}
