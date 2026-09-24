// The four chart forms Admin → Statistik draws, as inline SVG in the console's
// own palette — no chart library, and the same numbers the deck exporters
// read. Every mark carries a <title> for the hover, every chart says its n,
// and the grade charts sit on the 1–15 scale with C marked as the Normalfall.
import React, { useEffect, useRef, useState } from 'react';
import { GRADE_SCALE, NORMAL_SCORE, isThin, scoreToLetter } from '../lib/statistics';
import { cn } from '../lib/utils';

// Validated (dataviz six checks, light surface): blue / SVRZ red / yellow are
// CVD-separable as neighbours; the yellow needs its label, which every chart
// here draws.
// The red is the app's own brand red (--color-brand, #e2001a), not Tailwind's
// stock red-600 — the console, the charts and the export all wear one red.
export const SERIES = ['#2a78d6', '#e2001a', '#eda100'] as const;
export const SERIES_SOFT = ['#9ec5f4', '#f2a3a3', '#f6d58a'] as const;
const INK = '#44403c';      // stone-700
const INK_SOFT = '#78716c'; // stone-500
const GRID = '#e7e5e4';     // stone-200

export const fmtInt = (n: number): string => new Intl.NumberFormat('de-CH').format(Math.round(n));
export const fmtDec = (n: number, digits = 1): string => new Intl.NumberFormat('de-CH', { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(n);

/** The rendered width of an element, kept current — a chart draws itself at
 *  the block's width instead of being scaled as a picture, so its text stays
 *  the same size whether the block is three columns wide or six. */
function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.getBoundingClientRect().width);
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => { for (const e of entries) setWidth(e.contentRect.width); });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

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
  const [box, boxWidth] = useWidth<HTMLDivElement>();
  // As wide as the block, never narrower than the columns need — below that it
  // scrolls rather than squeezes.
  const width = Math.max(data.length * slotWidth + left + right, Math.floor(boxWidth) || 320);
  const top = 22;
  const bottom = 26;
  const plotH = height - top - bottom;
  const totals = data.map((d) => d.values.reduce((a, b) => a + b, 0));
  const max = Math.max(1, ...totals);
  const slot = (width - left - right) / Math.max(1, data.length);
  const barW = Math.min(36, slot * 0.62);
  const y = (v: number) => top + plotH - (v / max) * plotH;
  const gridSteps = niceSteps(max, 3);
  return (
    <div ref={box} className="overflow-x-auto">
      <svg viewBox={`0 0 ${width} ${height}`} width={width} height={height} role="img" className="block">
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

// ── One 100 % bar (part-to-whole) ───────────────────────────────────────────
// A share across a few ordered or named parts — coverage by visits, 1. SR vs
// 2. SR, a three-way assessment. Segments sit 2px apart; the legend under it
// carries every count and share, so no colour has to be read alone.
export { SEQ_BLUE } from '../lib/statsLabels';
export type Segment = { key: string; label: string; value: number; color: string };

export function StackBar({ segments, format = fmtInt }: { segments: Segment[]; format?: (n: number) => string }) {
  const total = segments.reduce((a, x) => a + x.value, 0);
  if (total === 0) return <p className="text-xs text-stone-400">–</p>;
  const shown = segments.filter((x) => x.value > 0);
  return (
    <div>
      <div className="flex h-5 gap-[2px] overflow-hidden rounded-[4px]" role="img" aria-label={shown.map((x) => `${x.label} ${format(x.value)}`).join(', ')}>
        {shown.map((x) => (
          <span key={x.key} style={{ width: `${(x.value / total) * 100}%`, background: x.color }} title={`${x.label}: ${format(x.value)} (${Math.round((x.value / total) * 100)} %)`} />
        ))}
      </div>
      <div className="mt-2 grid grid-cols-[auto_1fr_auto_auto] items-center gap-x-2 gap-y-1 text-xs">
        {segments.map((x) => (
          <React.Fragment key={x.key}>
            <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: x.color }} />
            <span className={x.value > 0 ? 'text-stone-700' : 'text-stone-400'}>{x.label}</span>
            <span className="tabular-nums font-medium text-stone-700 text-right">{format(x.value)}</span>
            <span className="tabular-nums text-stone-400 text-right w-10">{Math.round((x.value / total) * 100)} %</span>
          </React.Fragment>
        ))}
      </div>
    </div>
  );
}

// ── Diverging rows (an ordered three-way answer per row) ────────────────────
// Negative to the left of a shared centre, positive to the right, the neutral
// middle split across it — Likert-style, so rows compare at a glance: which
// assessment leans up, which down. Shares, not counts, so rows of different
// size line up; the count is in the hover and in the row's n.
export type DivergingRow = { key: string; label: string; neg: number; mid: number; pos: number; sub?: string };

export function DivergingBars({ rows, colors, labels }: {
  rows: DivergingRow[];
  colors: { neg: string; mid: string; pos: string };
  labels: { neg: string; mid: string; pos: string };
}) {
  const shares = rows.map((r) => {
    const n = r.neg + r.mid + r.pos;
    return n ? { n, neg: r.neg / n, mid: r.mid / n, pos: r.pos / n } : null;
  });
  // The widest side decides the scale, so the centre stays in one place.
  const reach = Math.max(0.01, ...shares.map((x) => (x ? Math.max(x.neg + x.mid / 2, x.pos + x.mid / 2) : 0)));
  const pct = (v: number) => `${(v / reach) * 50}%`;
  return (
    <div>
      <div className="space-y-2">
        {rows.map((r, i) => {
          const x = shares[i];
          return (
            <div key={r.key} className="text-xs">
              <div className="flex items-baseline justify-between gap-2">
                <span className="truncate text-stone-700">{r.label}</span>
                <span className="shrink-0 tabular-nums text-stone-400">{r.sub ?? (x ? `n = ${x.n}` : '')}</span>
              </div>
              <div
                className="relative mt-1 h-3.5 rounded-sm bg-stone-100"
                title={`${r.label}: ${labels.neg} ${r.neg} · ${labels.mid} ${r.mid} · ${labels.pos} ${r.pos}`}
              >
                {x && (
                  <>
                    <span className="absolute inset-y-0" style={{ right: `calc(50% + ${pct(x.mid / 2)})`, width: pct(x.neg), background: colors.neg }} />
                    <span className="absolute inset-y-0" style={{ left: `calc(50% - ${pct(x.mid / 2)})`, width: pct(x.mid), background: colors.mid }} />
                    <span className="absolute inset-y-0" style={{ left: `calc(50% + ${pct(x.mid / 2)})`, width: pct(x.pos), background: colors.pos }} />
                  </>
                )}
                <span className="absolute inset-y-[-2px] left-1/2 w-px bg-stone-500" />
              </div>
              {x && (
                <div className="mt-0.5 flex justify-between tabular-nums text-[10px] text-stone-500">
                  <span>{labels.neg} {Math.round(x.neg * 100)} %</span>
                  <span>{labels.pos} {Math.round(x.pos * 100)} %</span>
                </div>
              )}
            </div>
          );
        })}
      </div>
      <Legend items={[{ name: labels.neg, color: colors.neg }, { name: labels.mid, color: colors.mid }, { name: labels.pos, color: colors.pos }]} />
    </div>
  );
}

// ── Line on the grade scale (average per month) ─────────────────────────────
// Change over time against the Normalfall: C drawn as the reference line,
// letters on the axis, a month with under three observations drawn hollow.
export type LinePoint = { key: string; label: string; value: number | null; n: number; hint?: string };

export function GradeLine({ points, nLabel }: { points: LinePoint[]; nLabel: (n: number) => string }) {
  const [box, boxWidth] = useWidth<HTMLDivElement>();
  const width = Math.max(260, Math.floor(boxWidth) || 320);
  const height = 170;
  const left = 22; const right = 10; const top = 14; const bottom = 24;
  const vals = points.map((p) => p.value).filter((v): v is number => v !== null);
  if (vals.length === 0) return <p className="text-xs text-stone-400">–</p>;
  // A band around the data that always includes C, in whole letters.
  const lo = Math.max(1, Math.min(NORMAL_SCORE - 1, Math.floor(Math.min(...vals)) - 1));
  const hi = Math.min(15, Math.max(NORMAL_SCORE + 1, Math.ceil(Math.max(...vals)) + 1));
  const plotW = width - left - right;
  const plotH = height - top - bottom;
  const x = (i: number) => left + (points.length === 1 ? plotW / 2 : (plotW * i) / (points.length - 1));
  const y = (v: number) => top + plotH - ((v - lo) / (hi - lo)) * plotH;
  const ticks = ['E', 'D', 'C', 'B', 'A'].map((l) => ({ l, v: GRADE_SCALE[l] })).filter((t) => t.v >= lo && t.v <= hi);
  // The line breaks over a month without a grade rather than inventing one.
  const segs: string[] = [];
  let cur = '';
  points.forEach((p, i) => {
    if (p.value === null) { if (cur) segs.push(cur); cur = ''; return; }
    cur += `${cur ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`;
  });
  if (cur) segs.push(cur);
  return (
    <div ref={box}>
      <svg viewBox={`0 0 ${width} ${height}`} width={width} height={height} role="img" className="block max-w-full">
        {ticks.map((t) => (
          <g key={t.l}>
            <line x1={left} x2={width - right} y1={y(t.v)} y2={y(t.v)} stroke={t.v === NORMAL_SCORE ? '#a8a29e' : GRID} strokeWidth={1} strokeDasharray={t.v === NORMAL_SCORE ? '4 3' : undefined} />
            <text x={left - 6} y={y(t.v) + 3} fontSize={10} fill={INK_SOFT} textAnchor="end">{t.l}</text>
          </g>
        ))}
        {segs.map((d) => <path key={d} d={d} fill="none" stroke={SERIES[0]} strokeWidth={2} strokeLinejoin="round" />)}
        {points.map((p, i) => (p.value === null ? null : (
          <g key={p.key}>
            <circle cx={x(i)} cy={y(p.value)} r={4.5} fill={isThin(p.n) ? 'white' : SERIES[0]} stroke={isThin(p.n) ? SERIES[0] : 'white'} strokeWidth={2} />
            <circle cx={x(i)} cy={y(p.value)} r={12} fill="transparent">
              <title>{`${p.hint ?? p.label}: ${scoreToLetter(p.value)} · ${nLabel(p.n)}`}</title>
            </circle>
          </g>
        )))}
        {points.map((p, i) => (
          <text key={`l-${p.key}`} x={x(i)} y={height - 8} fontSize={10} fill={INK_SOFT} textAnchor="middle">{p.label}</text>
        ))}
      </svg>
    </div>
  );
}

// ── Sparkline (a tile's trend) ───────────────────────────────────────────────
export function Sparkline({ values, title }: { values: number[]; title?: string }) {
  if (values.length < 2) return null;
  const w = 100; const h = 24;
  const max = Math.max(1, ...values);
  const pts = values.map((v, i) => `${((w - 4) * i) / (values.length - 1) + 2},${h - 3 - (v / max) * (h - 6)}`);
  const last = pts[pts.length - 1].split(',').map(Number);
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="mt-1 h-6 w-full" preserveAspectRatio="none" role="img" aria-label={title}>
      {title && <title>{title}</title>}
      <polygon points={`2,${h - 3} ${pts.join(' ')} ${w - 2},${h - 3}`} fill={SERIES_SOFT[0]} opacity={0.45} />
      <polyline points={pts.join(' ')} fill="none" stroke={SERIES[0]} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
      <circle cx={last[0]} cy={last[1]} r={2.5} fill={SERIES[0]} />
    </svg>
  );
}

// ── Horizontal bars (stacked) ────────────────────────────────────────────────
// The histogram and the months as rows rather than columns: fifteen grades or
// eight months read top to bottom on a phone without scrolling sideways, and
// every row carries its label and its total in plain text.
export type HBarDatum = {
  key: string;
  label: string;
  values: number[];
  hint?: string;
  /** Drawn in the soft tint — the ± grades beside the plain letter. */
  soft?: boolean;
  /** A little air above the row — where a new letter starts. */
  gapBefore?: boolean;
};

export function HBarChart({ data, series }: { data: HBarDatum[]; /** One name per stacked series; one series draws no legend. */ series: string[] }) {
  const totals = data.map((d) => d.values.reduce((a, b) => a + b, 0));
  const max = Math.max(1, ...totals);
  return (
    <div>
      <div className="space-y-1">
        {data.map((d, i) => (
          <div
            key={d.key}
            className={cn('grid grid-cols-[3.5rem_1fr_2.5rem] items-center gap-2 text-xs', d.gapBefore && i > 0 && 'pt-1.5')}
            title={`${d.hint ?? d.label}: ${series.length > 1 ? d.values.map((v, s) => `${series[s]} ${fmtInt(v)}`).join(' · ') : fmtInt(totals[i])}`}
          >
            <span className={cn('truncate', d.soft ? 'text-stone-500' : 'font-medium text-stone-700')}>{d.label}</span>
            <span className="flex h-3.5 overflow-hidden rounded-r-[3px] bg-stone-100">
              {d.values.map((v, s) => v > 0 && (
                <span
                  key={s}
                  className={s > 0 ? 'border-l border-white' : undefined}
                  style={{ width: `${(v / max) * 100}%`, background: d.soft ? SERIES_SOFT[s % SERIES_SOFT.length] : SERIES[s % SERIES.length] }}
                />
              ))}
            </span>
            <span className={cn('tabular-nums text-right', totals[i] > 0 ? 'font-medium text-stone-700' : 'text-stone-300')}>{fmtInt(totals[i])}</span>
          </div>
        ))}
      </div>
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
        <div key={r.key} className="grid grid-cols-[minmax(0,42%)_1fr_auto] items-center gap-2 text-xs" title={r.hint ?? `${r.label}: ${format(r.value)}`}>
          <span className="min-w-0 leading-tight">
            <span className="block truncate text-stone-700">{r.label}</span>
            {r.sub && <span className="block truncate text-[10px] text-stone-400">{r.sub}</span>}
          </span>
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
export type ScaleRow = { key: string; label: string; avg: number | null; n: number; sub?: string;
  /** A sub-row (a Stufe under its Niveau): indented, lighter. */
  indent?: boolean;
  /** A heading row (the Niveau itself): bold. */
  strong?: boolean };

/** One row per thing graded: a dot on the E-…A+ track, C marked. An average
 *  from fewer than three observations is drawn hollow and carries its n. */
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
          <div key={r.key} className="grid grid-cols-[minmax(0,6.5rem)_1fr_auto] sm:grid-cols-[minmax(0,11rem)_1fr_auto] items-center gap-2 text-xs" data-thin={r.avg !== null && isThin(r.n) ? 'true' : undefined} title={r.avg === null ? `${r.label}: ${nLabel(r.n)}` : `${r.label}: ${scoreToLetter(r.avg)} · ${nLabel(r.n)}${isThin(r.n) ? ` (n < 3)` : ''}`}>
            <span className={cn('truncate', r.indent ? 'pl-3 text-stone-500' : 'text-stone-700', r.strong && 'font-semibold text-stone-800')}>{r.label}{r.sub && <span className="text-stone-400"> · {r.sub}</span>}</span>
            <span className="relative h-4">
              <span className="absolute inset-x-0 top-1/2 h-px bg-stone-200" />
              <span className="absolute top-0 bottom-0 w-0.5 -translate-x-1/2 bg-stone-400" style={{ left: `${pos(NORMAL_SCORE)}%` }} title="C" />
              {r.avg !== null && (isThin(r.n)
                ? <span className="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white border-2" style={{ left: `${pos(r.avg)}%`, borderColor: SERIES[0] }} />
                : <span className="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-white" style={{ left: `${pos(r.avg)}%`, background: SERIES[0] }} />)}
            </span>
            <span className="tabular-nums min-w-[4.5rem] text-right whitespace-nowrap">
              {r.avg === null
                ? <span className="text-stone-400">{nLabel(r.n)}</span>
                : isThin(r.n)
                  ? <><span className="font-semibold text-stone-600">{scoreToLetter(r.avg)}</span> <span className="text-stone-400">· n = {r.n}</span></>
                  : <><span className="font-semibold text-stone-800">{scoreToLetter(r.avg)}</span> <span className="text-stone-400">· {r.n}</span></>}
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
export function StatTile({ label, value, sub, delta, deltaLabel, hero, spark }: {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  /** Signed change against the previous season, already formatted; null hides the chip. */
  delta?: string | null;
  deltaLabel?: string;
  hero?: boolean;
  /** A small trend under the value (e.g. observations per month). */
  spark?: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-stone-200/70 bg-white px-3 py-2.5 min-w-0">
      <div className="text-[11px] text-stone-500 leading-tight">{label}</div>
      <div className={`${hero ? 'text-3xl' : 'text-2xl'} font-semibold text-stone-800 tabular-nums leading-tight mt-0.5`}>{value}</div>
      <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] text-stone-500 min-h-[1rem] leading-tight">
        {sub && <span>{sub}</span>}
        {delta && <span className="inline-flex items-center rounded-full bg-stone-100 px-1.5 py-px text-[10px] font-medium text-stone-600 tabular-nums" title={deltaLabel}>{delta}</span>}
      </div>
      {spark}
    </div>
  );
}
