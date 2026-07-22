/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

declare const __BUILD_SHA__: string;
declare const __BUILD_TIME__: string;

interface Window {
  /**
   * True while an observation form holds work that exists nowhere else. The
   * service-worker auto-update reads it and postpones its reload — a deploy
   * must never wipe a form being filled in at a match.
   */
  __svrzFormDirty?: boolean;
}
