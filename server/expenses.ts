// The Spesenabrechnung — one page per referee coach, per season.
//
// The commission's own sheet (Excel, filled by hand from the tool's CSV at
// season end): the coach's visits numbered down the page, CHF 60.– beside
// each (GBO Art. 14 Abs. 3: "Pauschal pro Einsatz, Fahrkosten inbegriffen"),
// the referee, their group, the role assessed, their level, the date and the
// match number; the total; a line for the RC-Sitzung; the grand total; a
// place to sign. Drawn here from the filed observations so nobody types it.
//
// Two rules the sheet encodes that a plain count does not:
//  - one GAME is one Einsatz. A coach who assessed both referees of a game
//    files two observations and is paid once — the sheet lists them 6a and 6b,
//    the second with "-" for the amount.
//  - Infoschreiben 6.2 caps what a season pays. Games past the cap stay on
//    the sheet (they happened) with "-" and a note, so the coach can see why
//    the total stops short.
//
// Pure: index.ts assembles the input from PocketBase and hands the bytes out.

import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';

export type ExpenseVisit = {
  gameId: string;
  matchNo: string;
  /** ISO date-time of the game. */
  date: string;
  /** Surname first, the way the sheet lists people. */
  refereeName: string;
  /** Kategorie — the coachee's group at the time of the visit. */
  group: string;
  role: string;
  /** SK — the referee's Niveau-Stufe, "N2-1". */
  level: string;
  note?: string;
};

export type ExpenseStatement = {
  /** Surname first. */
  rcName: string;
  season: number;
  visits: ExpenseVisit[];
  /** CHF per paid game. */
  visitRate: number;
  /** Infoschreiben 6.2 — games a season pays at most; null for no cap. */
  paidCap: number | null;
  /** The RC-Sitzung line, when the coach attended. */
  meeting: { date: string; rate: number } | null;
  /** The day the sheet is drawn. */
  issuedOn: Date;
};

export type ExpenseRow = ExpenseVisit & {
  /** "1", "2", "6a", "6b" … */
  no: string;
  /** null where the row is not paid: the second referee of a game, or a game past the cap. */
  amount: number | null;
};

export type ExpensePlan = {
  rows: ExpenseRow[];
  paidGames: number;
  visitsTotal: number;
  meetingTotal: number;
  grandTotal: number;
};

const OVER_CAP_NOTE = 'über der Obergrenze';

/** Number the visits and decide which are paid. Games in date order; the
 *  observations of one game share a number and are lettered. */
export function planExpenseRows(st: ExpenseStatement): ExpensePlan {
  // Date order; within one game the 1. SR first, so "a" — the paid line — is
  // the first referee, as the sheet has always written it.
  const roleRank = (r: string) => (/2/.test(r) ? 1 : 0);
  const sorted = [...st.visits].sort((a, b) =>
    a.date.localeCompare(b.date) || a.gameId.localeCompare(b.gameId) || roleRank(a.role) - roleRank(b.role) || a.refereeName.localeCompare(b.refereeName));
  // Group consecutive visits of the same game (they sort together by date).
  const games: ExpenseVisit[][] = [];
  const byGame = new Map<string, ExpenseVisit[]>();
  for (const v of sorted) {
    const key = v.gameId || `${v.date}|${v.matchNo}`;
    let bucket = byGame.get(key);
    if (!bucket) { bucket = []; byGame.set(key, bucket); games.push(bucket); }
    bucket.push(v);
  }
  const rows: ExpenseRow[] = [];
  let paidGames = 0;
  games.forEach((visits, i) => {
    const overCap = st.paidCap != null && paidGames >= st.paidCap;
    if (!overCap) paidGames += 1;
    visits.forEach((v, j) => {
      const letter = visits.length > 1 ? String.fromCharCode(97 + j) : '';
      const first = j === 0;
      rows.push({
        ...v,
        no: `${i + 1}${letter}`,
        amount: first && !overCap ? st.visitRate : null,
        note: v.note || (first && overCap ? OVER_CAP_NOTE : ''),
      });
    });
  });
  const visitsTotal = paidGames * st.visitRate;
  const meetingTotal = st.meeting ? st.meeting.rate : 0;
  return { rows, paidGames, visitsTotal, meetingTotal, grandTotal: visitsTotal + meetingTotal };
}

// ---------------------------------------------------------------- drawing

// Landscape A4, like the sheet it replaces.
const PAGE_W = 841.89;
const PAGE_H = 595.28;
const MARGIN = 40;
const INK = rgb(0.11, 0.1, 0.09);
const MUTED = rgb(0.45, 0.43, 0.42);
const RULE = rgb(0.6, 0.58, 0.57);

/** Helvetica speaks WinAnsi: Latin-1 plus a few typographic extras. A name
 *  the encoding cannot hold — "Šarić" holds one it can and one it cannot —
 *  would throw; strip the letter to its base rather than lose the page. */
const WINANSI_EXTRA = '€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ';
function safe(text: string): string {
  const ok = (ch: string) => {
    const code = ch.charCodeAt(0);
    return code < 0x80 || (code >= 0xa0 && code <= 0xff) || WINANSI_EXTRA.includes(ch);
  };
  return Array.from(text).map((ch) => {
    if (ok(ch)) return ch;
    const base = ch.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    return base && ok(base) ? base : '?';
  }).join('');
}

const chf = (n: number) => n.toFixed(2);
const seasonLabel = (season: number) => `${season}/${String((season + 1) % 100).padStart(2, '0')}`;

/** dd.mm.yyyy in Zürich, from an ISO date-time. */
function dateDe(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const parts = new Intl.DateTimeFormat('de-CH', { timeZone: 'Europe/Zurich', day: '2-digit', month: '2-digit', year: 'numeric' }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('day')}.${get('month')}.${get('year')}`;
}
/** dd.mm.yy, for the RC-Sitzung line as the sheet writes it. */
function dateShortDe(iso: string): string {
  const full = dateDe(iso);
  return /^\d{2}\.\d{2}\.\d{4}$/.test(full) ? full.slice(0, 6) + full.slice(8) : full;
}

type Col = { key: keyof ExpenseRow | 'amount'; title: string; x: number; w: number; align?: 'right' };

// Column x positions, from the sheet's proportions.
const COLS: Col[] = [
  { key: 'no', title: 'Besuch', x: MARGIN + 120, w: 34, align: 'right' },
  { key: 'amount', title: '', x: MARGIN + 160, w: 50, align: 'right' },
  { key: 'refereeName', title: 'Schiedsrichter', x: MARGIN + 224, w: 150 },
  { key: 'group', title: 'Kategorie', x: MARGIN + 380, w: 90 },
  { key: 'role', title: '1./2. SR', x: MARGIN + 476, w: 44 },
  { key: 'level', title: 'SK', x: MARGIN + 526, w: 40 },
  { key: 'date', title: 'Datum', x: MARGIN + 572, w: 66 },
  { key: 'matchNo', title: 'Spielnr.', x: MARGIN + 644, w: 52 },
  { key: 'note', title: 'Bemerkung', x: MARGIN + 702, w: PAGE_W - MARGIN - (MARGIN + 702) },
];
const ROW_H = 15;
const HEAD_Y = PAGE_H - 178;

function cell(page: PDFPage, font: PDFFont, size: number, text: string, col: Col, y: number, colour = INK): void {
  const t = safe(text);
  const w = font.widthOfTextAtSize(t, size);
  const x = col.align === 'right' ? col.x + col.w - w : col.x;
  page.drawText(t, { x, y, size, font, color: colour });
}

function fit(font: PDFFont, size: number, text: string, width: number): string {
  let t = safe(text);
  if (font.widthOfTextAtSize(t, size) <= width) return t;
  while (t.length > 1 && font.widthOfTextAtSize(`${t}…`, size) > width) t = t.slice(0, -1);
  return `${t}…`;
}

export async function buildExpenseStatementPdf(st: ExpenseStatement, logoPng?: Uint8Array): Promise<Uint8Array> {
  const plan = planExpenseRows(st);
  const doc = await PDFDocument.create();
  doc.setTitle(`Spesenabrechnung ${seasonLabel(st.season)} – ${safe(st.rcName)}`);
  doc.setProducer('svrz-rc');
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const logo = logoPng ? await doc.embedPng(logoPng) : null;

  const header = (page: PDFPage) => {
    if (logo) {
      const w = 150;
      const h = (logo.height / logo.width) * w;
      page.drawImage(logo, { x: MARGIN, y: PAGE_H - MARGIN - h, width: w, height: h });
    }
    const title = 'Spesenabrechnung';
    const sub = `Saison ${seasonLabel(st.season)}`;
    page.drawText(title, { x: PAGE_W - MARGIN - bold.widthOfTextAtSize(title, 13), y: PAGE_H - MARGIN - 34, size: 13, font: bold, color: INK });
    page.drawText(sub, { x: PAGE_W - MARGIN - bold.widthOfTextAtSize(sub, 13), y: PAGE_H - MARGIN - 50, size: 13, font: bold, color: INK });
    page.drawText(safe(st.rcName), { x: MARGIN, y: PAGE_H - 140, size: 14, font: bold, color: INK });
    for (const col of COLS) if (col.title) cell(page, bold, 9, col.title, { ...col, align: undefined }, HEAD_Y);
  };

  let page = doc.addPage([PAGE_W, PAGE_H]);
  header(page);
  let y = HEAD_Y - ROW_H - 2;
  const bottomOfRows = MARGIN + 130;

  for (const row of plan.rows) {
    if (y < bottomOfRows) {
      page = doc.addPage([PAGE_W, PAGE_H]);
      header(page);
      y = HEAD_Y - ROW_H - 2;
    }
    cell(page, regular, 9, row.no, COLS[0], y);
    cell(page, regular, 9, row.amount == null ? '-' : chf(row.amount), COLS[1], y);
    cell(page, regular, 9, fit(regular, 9, row.refereeName, COLS[2].w), COLS[2], y);
    cell(page, regular, 9, fit(regular, 9, row.group, COLS[3].w), COLS[3], y);
    cell(page, regular, 9, row.role, COLS[4], y);
    cell(page, regular, 9, row.level, COLS[5], y);
    cell(page, regular, 9, dateDe(row.date), COLS[6], y);
    cell(page, regular, 9, row.matchNo, COLS[7], y);
    cell(page, regular, 9, fit(regular, 9, row.note || '', COLS[8].w), COLS[8], y, MUTED);
    y -= ROW_H;
  }
  if (plan.rows.length === 0) {
    page.drawText('Keine Beobachtungen in dieser Saison.', { x: COLS[2].x, y, size: 9, font: regular, color: MUTED });
  }

  // Totals, anchored to the foot of the LAST page — the sheet keeps them low
  // whatever the count above.
  const amountRight = MARGIN + 130 + 50;
  const line = (label: string, amount: string, ly: number, font: PDFFont) => {
    page.drawText(safe(label), { x: MARGIN, y: ly, size: 9, font, color: INK });
    page.drawText(amount, { x: amountRight - font.widthOfTextAtSize(amount, 9), y: ly, size: 9, font, color: INK });
  };
  let ty = MARGIN + 92;
  page.drawLine({ start: { x: MARGIN, y: ty + 12 }, end: { x: PAGE_W - MARGIN, y: ty + 12 }, thickness: 0.5, color: RULE });
  line('Total RC-Besuche', chf(plan.visitsTotal), ty, regular);
  ty -= ROW_H;
  if (st.meeting) {
    line(`RC-Sitzung v. ${dateShortDe(st.meeting.date)}`, chf(st.meeting.rate), ty, regular);
    ty -= ROW_H;
  }
  ty -= 6;
  page.drawLine({ start: { x: MARGIN, y: ty + 12 }, end: { x: PAGE_W - MARGIN, y: ty + 12 }, thickness: 0.5, color: RULE });
  line('GESAMTTOTAL', chf(plan.grandTotal), ty, bold);
  page.drawLine({ start: { x: MARGIN, y: ty - 4 }, end: { x: PAGE_W - MARGIN, y: ty - 4 }, thickness: 1, color: INK });

  const sign = 'Datum, Unterschrift';
  page.drawText(sign, { x: MARGIN, y: MARGIN, size: 9, font: regular, color: INK });
  const issued = dateDe(st.issuedOn.toISOString());
  page.drawText(issued, { x: PAGE_W - MARGIN - regular.widthOfTextAtSize(issued, 9), y: MARGIN, size: 9, font: regular, color: INK });

  return doc.save();
}

/** The file name the sheet is saved under: surname first, ASCII only —
 *  accents folded, anything else a space — so the ZIP opens the same on
 *  every machine and a slash in a name cannot become a path. */
export function expenseStatementFileName(rcName: string, season: number): string {
  const name = rcName.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9]+/g, ' ').trim().replace(/\s+/g, '_') || 'RC';
  return `Spesen_${season}-${String((season + 1) % 100).padStart(2, '0')}_${name}.pdf`;
}
