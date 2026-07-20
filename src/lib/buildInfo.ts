// Injected at build time via vite.config.ts `define` (git SHA + build timestamp).
export const BUILD_INFO = `${__BUILD_SHA__} · ${new Date(__BUILD_TIME__).toLocaleString('de-CH', {
  day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
})}`;
