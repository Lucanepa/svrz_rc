// Two different questions, answered separately.
//
// APP_VERSION is the release — bumped in package.json with `npm version
// patch|minor|major`. It is what a coach can quote and what a referee holding a
// printed form can compare against.
//
// BUILD_INFO is the exact build: the git SHA and when it was made. That is a
// diagnostic, useful in a bug report and meaningless to anybody else, so it
// stays in the console footer and out of the document.
export const APP_VERSION = __APP_VERSION__;

export const BUILD_INFO = `${__BUILD_SHA__} · ${new Date(__BUILD_TIME__).toLocaleString('de-CH', {
  day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
})}`;

/** For the PDF footer: "v1.0.0 · August 2026". Month and year, because a
 *  document that lives in a folder for a season does not need the minute it was
 *  generated — and the PDF is always German, so the month is too. */
export const VERSION_STAMP = `v${APP_VERSION} · ${new Date(__BUILD_TIME__).toLocaleDateString('de-CH', {
  month: 'long', year: 'numeric',
})}`;
