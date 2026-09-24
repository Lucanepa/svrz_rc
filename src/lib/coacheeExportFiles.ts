// The two files of the coachee export, drawn from coacheeExportTable().
import { jsPDF } from 'jspdf';
import type { Lang } from './appTime';
import { dayLabel } from './appTime';
import { seasonLabel } from './season';
import { INTER_DISPLAY_BOLD_B64, INTER_DISPLAY_REGULAR_B64 } from './pdfFontsDisplay';
import { pdfSafeText } from './feedbackPdf';
import { COACHEE_EXPORT_STR, type ExportTable } from './coacheeExport';

type Cell = string | number | null;

export async function coacheeExportXlsx(table: ExportTable, season: number, lang: Lang): Promise<Blob> {
  const mod = await import('xlsx');
  // The namespace or its default, whichever carries the API — builds differ.
  const XLSX = ((mod as unknown as { utils?: unknown }).utils ? mod : (mod as unknown as { default: typeof mod }).default);
  const aoa = [table.columns.map((c) => c.label), ...table.rows.map((r) => r.map((v) => (v === null ? '' : v)))];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = table.columns.map((c) => ({ wch: Math.max(8, Math.round(c.w * 11)) }));
  // Header row stays in view while scrolling, and the columns filter.
  ws['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: aoa.length - 1, c: table.columns.length - 1 } }) };
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, COACHEE_EXPORT_STR[lang].title(seasonLabel(season)).slice(0, 31).replace(/[/\\?*[\]:]/g, '-'));
  const out = XLSX.write(wb, { bookType: 'xlsx', type: 'array' }) as ArrayBuffer;
  return new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}

/** A4 landscape; the header repeats on every page, cells wrap rather than clip. */
export function coacheeExportPdf(table: ExportTable, season: number, lang: Lang): Blob {
  const t = COACHEE_EXPORT_STR[lang];
  const doc = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'a4' });
  doc.addFileToVFS('InterDisplay-Regular.ttf', INTER_DISPLAY_REGULAR_B64);
  doc.addFont('InterDisplay-Regular.ttf', 'Inter', 'normal');
  doc.addFileToVFS('InterDisplay-Bold.ttf', INTER_DISPLAY_BOLD_B64);
  doc.addFont('InterDisplay-Bold.ttf', 'Inter', 'bold');
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const M = 18;
  const size = table.columns.length > 12 ? 5.2 : 7.5;
  const pad = 2;
  const lineH = size * 1.2;
  const totalW = table.columns.reduce((a, c) => a + c.w, 0);
  const widths = table.columns.map((c) => ((pageW - 2 * M) * c.w) / totalW);
  const text = (v: Cell) => pdfSafeText(v === null ? '' : String(v));
  const wrap = (v: string, w: number) => doc.splitTextToSize(v, Math.max(4, w - 2 * pad)) as string[];
  const stamp = dayLabel(new Date().toISOString(), { year: true });
  let page = 1;
  const header = (): number => {
    doc.setFont('Inter', 'bold'); doc.setFontSize(11); doc.setTextColor(28, 25, 23);
    doc.text(t.title(seasonLabel(season)), M, M + 10);
    doc.setFont('Inter', 'normal'); doc.setFontSize(7); doc.setTextColor(120, 113, 108);
    doc.text(`${t.generated} ${stamp} · ${page}`, pageW - M, M + 10, { align: 'right' });
    let y = M + 20;
    doc.setFont('Inter', 'bold'); doc.setFontSize(size);
    const lines = table.columns.map((c, i) => wrap(pdfSafeText(c.label), widths[i]));
    const h = Math.max(...lines.map((l) => l.length)) * lineH + 2 * pad;
    doc.setFillColor(245, 245, 244); doc.rect(M, y, pageW - 2 * M, h, 'F');
    doc.setTextColor(87, 83, 78);
    let x = M;
    lines.forEach((l, i) => { doc.text(l, x + pad, y + pad + size); x += widths[i]; });
    y += h;
    return y;
  };
  let y = header();
  doc.setFont('Inter', 'normal'); doc.setFontSize(size); doc.setTextColor(28, 25, 23);
  table.rows.forEach((row, r) => {
    const lines = row.map((v, i) => wrap(text(v), widths[i]));
    const h = Math.max(1, ...lines.map((l) => l.length)) * lineH + 2 * pad;
    if (y + h > pageH - M) {
      doc.addPage(); page += 1; y = header();
      doc.setFont('Inter', 'normal'); doc.setFontSize(size); doc.setTextColor(28, 25, 23);
    }
    if (r % 2 === 1) { doc.setFillColor(250, 250, 249); doc.rect(M, y, pageW - 2 * M, h, 'F'); }
    let x = M;
    lines.forEach((l, i) => { doc.text(l, x + pad, y + pad + size); x += widths[i]; });
    doc.setDrawColor(231, 229, 228); doc.line(M, y + h, pageW - M, y + h);
    y += h;
  });
  return doc.output('blob');
}
