// The four chart forms Admin → Statistik draws, as inline SVG in the console's
// own palette — no chart library, and the same numbers the deck exporters
// read. Every mark carries a <title> for the hover, every chart says its n,
// and the grade charts sit on the 1–15 scale with C marked as the Normalfall.
import React from 'react';
import { GRADE_SCALE, NORMAL_SCORE, scoreToLetter } from '../lib/statistics';

// Validated (dataviz six checks, light surface): blue / SVRZ red / yellow are
// CVD-separable as neighbours; the yellow needs its label, which every chart
// here draws.
export const SERIES = ['#2a78d6', '#dc2626', '#eda100'] as const;
export const SERIES_SOFT = ['#9ec5f4', '#f2a3a3', '#f6d58a'] as const;
const INK = '#44403c';      // stone-700
const INK_SOFT = '#78716c'; // stone-500
const GRID = '#e7e5e4';     // stone-200

export const fmtInt = (n: number): string => new Intl.NumberFormat('de-CH').format(Math.round(n));
export const fmtDec = (n: number, digits = 1): string => new Intl.NumberFormat('de-CH', { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(n);

// ── Columns ──────────────────────────────────────────────────────────────────
export type ColumnDatum = { key: string; label: string; values: number[]; hint?: string };

export function ColumnChart({ data, series, height = 180, soft = [], slotWidth = 36 }: {
  data: ColumnDatum[];
  /** One name per stacked series; a single series draws no legend. */
  series: string[];
  height?: number;
  /** Indexes of columns to draw in the soft tint — the ± grades beside the plain letter. */
  soft?: number[];
  /** Horizontal room per column; the 15-grade histogram packs tighter. */
  slotWidth?: number;
}) {
  // The tick labels get their own strip on the right, so a tall last column
  // and its total never share pixels with them.
  const left = 8;
  const right = 30;
  const width = Math.max(320, data.length * slotWidth + left + right);
  const top = 22;
  const bottom = 26;
  const plotH = height - top - bottom;
  const totals = data.map((d) => d.values.reduce((a, b) => a + b, 0));
  const max = Math.max(1, ...totals);
  const slot = (width - left - right) / Math.max(1, data.length);
  const barW = Math.min(24, slot * 0.62);
  const y = (v: number) => top + plotH - (v / max) * plotH;
  const gridSteps = niceSteps(max, 3);
  return (
    <div className="overflow-x-auto">
      {/* Scales down to 300px before it scrolls: a chart that has to be
          scrolled to be read is not read. */}
      <svg viewBox={`0 0 ${width} ${height}`} width="100%" style={{ minWidth: Math.min(width, 300), maxWidth: width * 1.6 }} role="img" className="block">
        {gridSteps.map((g) => (
          <g key={g}>
            <line x1={left} x2={width - right} y1={y(g)} y2={y(g)} stroke={GRID} strokeWidth={1} />
            <text x={width - right + 4} y={y(g) + 3} fontSize={9} fill={INK_SOFT} textAnchor="start">{fmtInt(g)}</text>
          </g>
        ))}
        {data.map((d, i) => {
          const x = left + slot * i + (slot - barW) / 2;
          let acc = 0;
          return (
            <g key={d.key}>
              {d.values.map((v, s) => {
                const y0 = y(acc + v);
                const h = Math.max(0, y(acc) - y0);
                acc += v;
                const fill = soft.includes(i) ? SERIES_SOFT[s % SERIES_SOFT.length] : SERIES[s % SERIES.length];
                return h > 0 ? (
                  <rect key={s} x={x} y={y0 + (s > 0 ? 1 : 0)} width={barW} height={Math.max(0, h - (s > 0 ? 1 : 0))} fill={fill} rx={s === d.values.length - 1 ? 3 : 0}>
                    <title>{`${d.hint ?? d.label}${series.length > 1 ? ` · ${series[s]}` : ''}: ${fmtInt(v)}`}</title>
                  </rect>
                ) : null;
              })}
              {totals[i] > 0 && (
                <text x={x + barW / 2} y={y(totals[i]) - 4} fontSize={10} fontWeight={600} fill={INK} textAnchor="middle">{fmtInt(totals[i])}</text>
              )}
              <text x={x + barW / 2} y={height - 9} fontSize={10} fill={INK_SOFT} textAnchor="middle">{d.label}</text>
            </g>
          );
        })}
        <line x1={left} x2={width - right} y1={y(0)} y2={y(0)} stroke={GRID} strokeWidth={1} />
      </svg>
      {series.length > 1 && <Legend items={series.map((name, i) => ({ name, color: SERIES[i % SERIES.length] }))} />}
    </div>
  );
}

function niceSteps(max: number, count: number): number[] {
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(Math.max(1, raw)));
  const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? mag * 10;
  const out: number[] = [];
  for (let v = step; v <= max; v += step) out.push(v);
  return out;
}

export function Legend({ items }: { items: Array<{ name: string; color: string }> }) {
  return (
    <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-stone-600">
      {items.map((it) => (
        <span key={it.name} className="inline-flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: it.color }} />
          {it.name}
        </span>
      ))}
    </div>
  );
}

// ── Horizontal bars (counts) ─────────────────────────────────────────────────
export type BarRow = { key: string; label: string; value: number; hint?: string; sub?: string };

export function BarList({ rows, color = SERIES[0], format = fmtInt, max: maxIn }: {
  rows: BarRow[];
  color?: string;
  format?: (n: number) => string;
  max?: number;
}) {
  const max = Math.max(1, maxIn ?? Math.max(0, ...rows.map((r) => r.value)));
  return (
    <div className="space-y-1.5">
      {rows.map((r) => (
        <div key={r.key} className="grid grid-cols-[minmax(0,7rem)_1fr_auto] sm:grid-cols-[minmax(0,10rem)_1fr_auto] items-center gap-2 text-xs" title={r.hint ?? `${r.label}: ${format(r.value)}`}>
          <span className="truncate text-stone-700">{r.label}{r.sub && <span className="text-stone-400"> · {r.sub}</span>}</span>
          <span className="h-3 rounded-r-[3px] bg-stone-100 overflow-hidden">
            <span className="block h-full rounded-r-[3px]" style={{ width: `${Math.max(r.value > 0 ? 2 : 0, (r.value / max) * 100)}%`, background: color }} />
          </span>
          <span className="tabular-nums font-medium text-stone-700 min-w-[2.5rem] text-right">{format(r.value)}</span>
        </div>
      ))}
    </div>
  );
}

// ── The grade scale (averages) ───────────────────────────────────────────────
export type ScaleRow = { key: string; label: string; avg: number | null; n: number; sub?: string };

/** One row per thing graded: a dot on the E-…A+ track, C marked. An average
 *  withheld for want of observations shows its n and no dot. */
export function GradeScale({ rows, minLabel, maxLabel, nLabel }: { rows: ScaleRow[]; minLabel?: string; maxLabel?: string; nLabel: (n: number) => string }) {
  const pos = (score: number) => ((score - 1) / 14) * 100;
  const ticks = ['E', 'D', 'C', 'B', 'A'].map((l) => ({ l, p: pos(GRADE_SCALE[l]) }));
  return (
    <div>
      <div className="grid grid-cols-[minmax(0,6.5rem)_1fr_auto] sm:grid-cols-[minmax(0,11rem)_1fr_auto] items-center gap-2 text-[10px] text-stone-400 mb-1">
        <span />
        <span className="relative h-3">
          {ticks.map((t) => <span key={t.l} className="absolute -translate-x-1/2" style={{ left: `${t.p}%` }}>{t.l}</span>)}
        </span>
        <span className="min-w-[4.5rem]" />
      </div>
      <div className="space-y-1.5">
        {rows.map((r) => (
          <div key={r.key} className="grid grid-cols-[minmax(0,6.5rem)_1fr_auto] sm:grid-cols-[minmax(0,11rem)_1fr_auto] items-center gap-2 text-xs" title={r.avg === null ? `${r.label}: ${nLabel(r.n)}` : `${r.label}: ${scoreToLetter(r.avg)} · ${fmtDec(r.avg)} · ${nLabel(r.n)}`}>
            <span className="truncate text-stone-700">{r.label}{r.sub && <span className="text-stone-400"> · {r.sub}</span>}</span>
            <span className="relative h-4">
              <span className="absolute inset-x-0 top-1/2 h-px bg-stone-200" />
              <span className="absolute top-0 bottom-0 w-px bg-stone-400" style={{ left: `${pos(NORMAL_SCORE)}%` }} title="C" />
              {r.avg !== null && (
                <span className="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-white" style={{ left: `${pos(r.avg)}%`, background: SERIES[0] }} />
              )}
            </span>
            <span className="tabular-nums min-w-[4.5rem] text-right">
              {r.avg === null
                ? <span className="text-stone-400">{nLabel(r.n)}</span>
                : <><span className="font-semibold text-stone-800">{scoreToLetter(r.avg)}</span> <span className="text-stone-500">{fmtDec(r.avg)}</span> <span className="text-stone-400">· {r.n}</span></>}
            </span>
          </div>
        ))}
      </div>
      {(minLabel || maxLabel) && (
        <div className="mt-1 flex justify-between text-[10px] text-stone-400"><span>{minLabel}</span><span>{maxLabel}</span></div>
      )}
    </div>
  );
}

// ── Donut ────────────────────────────────────────────────────────────────────
export type Slice = { key: string; label: string; value: number; color?: string };

export function Donut({ slices, size = 96, emptyLabel }: { slices: Slice[]; size?: number; emptyLabel: string }) {
  const total = slices.reduce((a, s) => a + s.value, 0);
  const r = size / 2 - 6;
  const c = size / 2;
  const circumference = 2 * Math.PI * r;
  let offset = 0;
  return (
    <div className="flex flex-col items-start gap-2">
      <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size} role="img" className="shrink-0">
        <circle cx={c} cy={c} r={r} fill="none" stroke={GRID} strokeWidth={10} />
        {total > 0 && slices.map((s, i) => {
          const len = (s.value / total) * circumference;
          const el = (
            <circle key={s.key} cx={c} cy={c} r={r} fill="none" stroke={s.color ?? SERIES[i % SERIES.length]} strokeWidth={10}
              strokeDasharray={`${Math.max(0, len - 2)} ${circumference - Math.max(0, len - 2)}`} strokeDashoffset={-offset}
              transform={`rotate(-90 ${c} ${c})`}>
              <title>{`${s.label}: ${fmtInt(s.value)} (${Math.round((s.value / total) * 100)}%)`}</title>
            </circle>
          );
          offset += len;
          return el;
        })}
        <text x={c} y={c + 4} textAnchor="middle" fontSize={13} fontWeight={700} fill={INK}>{total > 0 ? fmtInt(total) : '–'}</text>
      </svg>
      <div className="text-[11px] text-stone-600 space-y-0.5 min-w-0 w-full">
        {total === 0 && <div className="text-stone-400">{emptyLabel}</div>}
        {total > 0 && slices.map((s, i) => (
          <div key={s.key} className="flex items-center gap-1.5">
            <span className="inline-block h-2.5 w-2.5 rounded-sm shrink-0" style={{ background: s.color ?? SERIES[i % SERIES.length] }} />
            <span className="truncate flex-1 min-w-0">{s.label}</span>
            <span className="tabular-nums text-stone-800 font-medium">{fmtInt(s.value)}</span>
            <span className="tabular-nums text-stone-400">{Math.round((s.value / total) * 100)}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Stat tile ────────────────────────────────────────────────────────────────
export function StatTile({ label, value, sub, delta, deltaLabel, hero }: {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  /** Signed change against the previous season, already formatted; null hides the chip. */
  delta?: string | null;
  deltaLabel?: string;
  hero?: boolean;
}) {
  return (
    <div className="rounded-xl border border-stone-200/70 bg-white px-3 py-2.5 min-w-0">
      <div className="text-[11px] text-stone-500 leading-tight">{label}</div>
      <div className={`${hero ? 'text-3xl' : 'text-2xl'} font-semibold text-stone-800 tabular-nums leading-tight mt-0.5`}>{value}</div>
      <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] text-stone-500 min-h-[1rem] leading-tight">
        {sub && <span>{sub}</span>}
        {delta && <span className="inline-flex items-center rounded-full bg-stone-100 px-1.5 py-px text-[10px] font-medium text-stone-600 tabular-nums" title={deltaLabel}>{delta}</span>}
      </div>
    </div>
  );
}
