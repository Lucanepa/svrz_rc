// The one place the app's look is written down for e-mail.
//
// Every mail this system sends — the coaching report, the reminder, the survey,
// the credential code, the RC-game note and the error alert — is the same
// product arriving in an inbox, so they share a palette and a typeface rather
// than each carrying their own. Before this file the error alert had drifted to
// an indigo accent and a system font stack, which made an SVRZ mail look like a
// mail from somewhere else.
//
// The values mirror `src/index.css` — the app is stone + one brand red, and
// light-only. Keep them in step: a token changed there and not here shows up as
// a mail that no longer matches the screen it links to.

export const MAIL_BRAND = '#e2001a';        // --color-brand
export const MAIL_BRAND_DARK = '#be0014';   // --color-red-700
export const MAIL_INK = '#292524';          // stone-800 — the app's body text
export const MAIL_INK_STRONG = '#1c1917';   // stone-900 — headings, chip fills
export const MAIL_INK_SOFT = '#57534e';     // stone-600
export const MAIL_MUTED = '#a8a29e';        // stone-400 — footers, captions
export const MAIL_MUTED_STRONG = '#78716c'; // stone-500 — dense meta lines
export const MAIL_LINE = '#e7e5e4';         // stone-200
export const MAIL_SURFACE = '#f5f5f4';      // stone-100 — the page behind the card
export const MAIL_PANEL = '#fafaf9';        // stone-50 — inset panels
export const MAIL_CODE_BG = '#292524';      // stone-800 — the ground under a stack trace

// Inter is the app's typeface; 'Inter Display' is its display optical size,
// which readers who have Inter installed locally get by name and everyone on a
// client that keeps the stylesheet gets through the opsz axis.
//
// Webmail strips <link> and <style> (Gmail, Outlook.com), so the webfont is a
// bonus, never the plan: every fallback in this stack is a real face that is
// actually installed somewhere, and the layout is sized to survive all of them.
export const MAIL_FONT = "'Inter Display','Inter Variable',Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
export const MAIL_MONO = "ui-monospace,SFMono-Regular,Menlo,Consolas,monospace";
export const MAIL_FONT_LINK = '<link href="https://fonts.googleapis.com/css2?family=Inter:opsz,wght@14..32,400..700&display=swap" rel="stylesheet">';

// The display cut: tighter spacing, for headings only. Ignored where the
// variable font never loaded, which is exactly the right failure.
export const MAIL_DISPLAY = "font-variation-settings:'opsz' 32;letter-spacing:-0.3px;";

/** Body copy and headings — one helper, so every mail agrees on line height. */
export const mailText = (size: number, color: string, extra = '') =>
  `font-family:${MAIL_FONT};font-size:${size}px;color:${color};line-height:1.6;${extra}`;

// The app pins `color-scheme: light` (src/index.css) because every surface is a
// stone/white card. Saying the same here stops iOS Mail's dark mode inverting a
// card built out of warm greys into something muddy.
export const MAIL_COLOR_SCHEME_META = [
  '<meta name="color-scheme" content="light only">',
  '<meta name="supported-color-schemes" content="light">',
].join('\n');
