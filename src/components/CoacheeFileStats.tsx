import { useMemo, useState, type ReactNode } from 'react';
import { BarList, GradeLine, GradeScale, GradeScaleGrid, StatTile, SERIES, WIDE_SCALE_ROW, fmtInt, type BarRow, type LinePoint, type ScaleRow } from './StatsCharts';
import { gradeAvg, isThin, scoreToLetter, STAT_LETTERS, type StatRole } from '../lib/statistics';
import { criterionLabel, sectionTitle } from '../lib/statsLabels';
import { seasonLabel } from '../lib/season';
import { SECTIONS_1SR_DE, SECTIONS_1SR_EN, SECTIONS_2SR_DE, SECTIONS_2SR_EN } from '../types';
import {
  fileSeasonRows, fileSeasons, fileStatistics, fileStrengths, firstToLatest, seasonChange,
  type FileCriterionAgg, type FileStatsEntry,
} from '../lib/coacheeFileStats';
import type { Lang } from '../lib/prefs';

/**
 * "Statistik" on the coachee's dossier (/dossier): their own reports in
 * numbers — how many, the average grade, per section and per criterion of the
 * form, and against their own earlier seasons. Counted in the browser from
 * what the dossier already holds (src/lib/coacheeFileStats.ts); nothing here
 * compares a referee with anyone else.
 *
 * Every block says in full sentences what it shows, and every grade track
 * runs A left → E right like the form — the console's statistics rules.
 */

type Reading = 'improved' | 'same' | 'worse';

const STR = {
  DE: {
    seasonPick: 'Saison wählen',
    seasonAll: 'Alle Saisons',
    rolePick: 'Rolle',
    roleName: { '1SR': '1. SR', '2SR': '2. SR' } as Record<StatRole, string>,
    reports: 'Berichte',
    avg: 'Ø Note',
    grades: 'Noten erhalten',
    coaches: 'Referee Coaches',
    coachesSub: 'haben dich beobachtet',
    normalCase: 'C = Normalfall',
    fromReports: (n: number) => `aus ${n} Bericht${n === 1 ? '' : 'en'}`,
    roleSplit: (a: number, b: number) => `1. SR ${a} · 2. SR ${b}`,
    vsSeason: (r: Reading, s: string) => (r === 'improved' ? `▲ besser als ${s}` : r === 'worse' ? `▼ tiefer als ${s}` : `= etwa wie ${s}`),
    nReports: (n: number) => (n === 0 ? 'keine Note' : `${n} Bericht${n === 1 ? '' : 'e'}`),
    nGrades: (n: number) => `${n} Note${n === 1 ? '' : 'n'}`,
    seasonsTitle: 'Deine Saisons im Vergleich',
    seasonsDesc: 'Jede Zeile ist deine Ø Note in einer Saison, über alle Noten aus deinen Berichten. Wo du in einer Saison beide Rollen hattest, steht darunter die Note als 1. und als 2. SR. A steht links, E rechts; der graue Strich ist C, der Normalfall. Ein hohler Punkt steht für weniger als 3 Berichte.',
    seasonsLine: (r: Reading, s: string, p: string) => (r === 'improved'
      ? `Deine Ø Note ${s} ist besser als ${p}.`
      : r === 'worse' ? `Deine Ø Note ${s} ist tiefer als ${p}.` : `Deine Ø Note ${s} ist etwa gleich wie ${p}.`),
    trendTitle: 'Entwicklung',
    trendDesc: 'Jeder Punkt ist die Ø Note eines Berichts, der älteste links, der neueste rechts. Oben steht A, unten E; die gestrichelte Linie ist C, der Normalfall. Ein hohler Punkt ist ein Bericht mit weniger als 3 Noten.',
    trendLine: (r: Reading) => (r === 'improved'
      ? 'Seit deinem ersten Bericht ist deine Ø Note gestiegen.'
      : r === 'worse' ? 'Seit deinem ersten Bericht ist deine Ø Note gesunken.' : 'Seit deinem ersten Bericht ist deine Ø Note etwa gleich geblieben.'),
    distTitle: 'Notenverteilung',
    distDesc: 'So oft hast du jede Note erhalten, über alle Kriterien deiner Berichte. Ein C− oder C+ zählt hier als C.',
    sectionsTitle: 'Ø Note pro Abschnitt',
    sectionsDesc: (role: string) => `Jeder Punkt ist deine Ø Note in einem Abschnitt des Formulars als ${role}. A steht links, E rechts; der graue Strich ist C, der Normalfall. Ein hohler Punkt steht für weniger als 3 Berichte.`,
    criteriaTitle: 'Ø Note pro Kriterium',
    criteriaDesc: (role: string) => `Jeder Punkt ist deine Ø Note in einem Kriterium des Formulars als ${role}, nach Abschnitt gruppiert. A steht links, E rechts; der graue Strich ist C, der Normalfall. Ein hohler Punkt steht für weniger als 3 Berichte.`,
    ghostDesc: (s: string) => ` Der graue Ring zeigt deine Ø Note in den Saisons vor ${s}, die Linie den Schritt seither.`,
    earlier: 'frühere Saisons',
    swTitle: 'Stärken & Baustellen',
    swDesc: (role: string) => `Jedes Kriterium verglichen mit deiner eigenen Ø Note als ${role}. Markiert wird ein Kriterium erst ab 3 Berichten und mit mindestens einem Drittel Note Abstand.`,
    strong: 'Gelingt dir besonders gut',
    weak: 'Daran kannst du arbeiten',
    swNone: 'Noch nichts markiert: Dafür braucht ein Kriterium Noten aus mindestens 3 Berichten, die sich deutlich von deinem Durchschnitt abheben.',
    empty: 'Sobald ein Bericht mit Noten abgelegt ist, siehst du hier deine Zahlen.',
    emptySeason: 'In dieser Saison gibt es noch keinen Bericht mit Noten.',
    methodTitle: 'So zählen wir',
    method: 'Gezählt werden alle deine Berichte ausser Testspielen. Eine Ø Note ist der Durchschnitt aller Noten auf der Skala von E bis A und wird als Buchstabe angezeigt; ein C− oder C+ zählt als C. Eine Saison dauert von September bis April. Die Zahlen kommen nur aus deinen eigenen Berichten — mit anderen Schiedsrichterinnen und Schiedsrichtern wird nichts verglichen.',
  },
  EN: {
    seasonPick: 'Pick a season',
    seasonAll: 'All seasons',
    rolePick: 'Role',
    roleName: { '1SR': '1st referee', '2SR': '2nd referee' } as Record<StatRole, string>,
    reports: 'Reports',
    avg: 'Avg. grade',
    grades: 'Grades received',
    coaches: 'Referee coaches',
    coachesSub: 'have observed you',
    normalCase: 'C = normal case',
    fromReports: (n: number) => `from ${n} report${n === 1 ? '' : 's'}`,
    roleSplit: (a: number, b: number) => `1st ${a} · 2nd ${b}`,
    vsSeason: (r: Reading, s: string) => (r === 'improved' ? `▲ better than ${s}` : r === 'worse' ? `▼ lower than ${s}` : `= about as ${s}`),
    nReports: (n: number) => (n === 0 ? 'no grade' : `${n} report${n === 1 ? '' : 's'}`),
    nGrades: (n: number) => `${n} grade${n === 1 ? '' : 's'}`,
    seasonsTitle: 'Your seasons compared',
    seasonsDesc: 'Each row is your average grade in one season, over every grade in your reports. Where you had both roles in a season, the grade as 1st and as 2nd referee is shown below it. A is on the left, E on the right; the grey mark is C, the normal case. A hollow dot stands for fewer than 3 reports.',
    seasonsLine: (r: Reading, s: string, p: string) => (r === 'improved'
      ? `Your average in ${s} is better than in ${p}.`
      : r === 'worse' ? `Your average in ${s} is lower than in ${p}.` : `Your average in ${s} is about the same as in ${p}.`),
    trendTitle: 'Over time',
    trendDesc: 'Each dot is the average grade of one report, the oldest on the left, the newest on the right. A is at the top, E at the bottom; the dashed line is C, the normal case. A hollow dot is a report with fewer than 3 grades.',
    trendLine: (r: Reading) => (r === 'improved'
      ? 'Since your first report your average has gone up.'
      : r === 'worse' ? 'Since your first report your average has gone down.' : 'Since your first report your average has stayed about the same.'),
    distTitle: 'Grade distribution',
    distDesc: 'How often you received each grade, over every criterion of your reports. A C− or C+ counts as a C here.',
    sectionsTitle: 'Average per section',
    sectionsDesc: (role: string) => `Each dot is your average grade in one section of the form as ${role}. A is on the left, E on the right; the grey mark is C, the normal case. A hollow dot stands for fewer than 3 reports.`,
    criteriaTitle: 'Average per criterion',
    criteriaDesc: (role: string) => `Each dot is your average grade in one criterion of the form as ${role}, grouped by section. A is on the left, E on the right; the grey mark is C, the normal case. A hollow dot stands for fewer than 3 reports.`,
    ghostDesc: (s: string) => ` The grey ring shows your average in the seasons before ${s}, and the line the step since.`,
    earlier: 'earlier seasons',
    swTitle: 'Strengths & areas to work on',
    swDesc: (role: string) => `Each criterion compared with your own average as ${role}. A criterion is marked only from 3 reports on and when it is at least a third of a grade apart.`,
    strong: 'Your strongest',
    weak: 'To work on',
    swNone: 'Nothing marked yet: a criterion needs grades from at least 3 reports that stand out clearly from your average.',
    empty: 'As soon as a report with grades is filed, your numbers show here.',
    emptySeason: 'There is no report with grades in this season yet.',
    methodTitle: 'How we count',
    method: 'Every report of yours counts except test games. An average is the mean of all grades on the scale from E to A and is shown as a letter; a C− or C+ counts as a C. A season runs from September to April. The numbers come from your own reports only — nothing is compared with other referees.',
  },
};

const FORMS: Record<StatRole, Record<Lang, typeof SECTIONS_1SR_DE>> = {
  '1SR': { DE: SECTIONS_1SR_DE, EN: SECTIONS_1SR_EN },
  '2SR': { DE: SECTIONS_2SR_DE, EN: SECTIONS_2SR_EN },
};

const shortDate = (iso: string) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${m[3]}.${m[2]}.${m[1].slice(2)}` : '';
};

const card = 'bg-white rounded-2xl shadow-card border border-stone-200/70';

function Block({ title, desc, testId, children }: { title: string; desc: string; testId: string; children: ReactNode }) {
  return (
    <section className={`${card} p-4 sm:p-5`} data-testid={testId}>
      <h3 className="text-[15px] font-semibold text-stone-900">{title}</h3>
      <p className="mt-1 mb-3 text-xs leading-relaxed text-stone-500">{desc}</p>
      {children}
    </section>
  );
}

function Toggle<T extends string | number>({ label, options, value, onChange, testId }: {
  label: string; options: Array<{ key: T; label: string }>; value: T; onChange: (v: T) => void; testId: string;
}) {
  return (
    <div role="group" aria-label={label} className="flex flex-wrap gap-1.5" data-testid={testId}>
      {options.map((o) => (
        <button
          key={String(o.key)} type="button" onClick={() => onChange(o.key)} aria-pressed={value === o.key}
          className={`h-8 px-3 rounded-full border text-xs font-semibold transition-colors ${value === o.key ? 'bg-stone-900 border-stone-900 text-white' : 'bg-white border-stone-200 text-stone-600 hover:border-stone-400'}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export default function CoacheeFileStats({ entries, lang }: { entries: FileStatsEntry[]; lang: Lang }) {
  const t = STR[lang];
  const seasons = useMemo(() => fileSeasons(entries), [entries]);
  const rows = useMemo(() => fileSeasonRows(entries), [entries]);
  const [season, setSeason] = useState<number | 'all'>('all');
  const picked = season === 'all' || seasons.includes(season) ? season : 'all';
  const stats = useMemo(() => fileStatistics(entries, picked === 'all' ? {} : { season: picked }), [entries, picked]);
  // What a season is compared with: every season before it, together.
  const earlier = useMemo(() => {
    if (picked === 'all') return null;
    const s = fileStatistics(entries, { before: picked });
    return s.graded > 0 ? s : null;
  }, [entries, picked]);

  const rolesWithGrades = (['1SR', '2SR'] as StatRole[]).filter((r) => stats.byRole[r].obs > 0);
  const [rolePick, setRolePick] = useState<StatRole | null>(null);
  const role: StatRole | null = rolePick && rolesWithGrades.includes(rolePick)
    ? rolePick
    : [...rolesWithGrades].sort((a, b) => stats.byRole[b].obs - stats.byRole[a].obs)[0] ?? null;

  const allTime = useMemo(() => fileStatistics(entries), [entries]);
  if (allTime.graded === 0) {
    return <div className={`${card} p-6 text-center text-sm text-stone-500`} data-testid="coachee-stats-empty">{t.empty}</div>;
  }

  const avg = gradeAvg(stats.grade);
  const change = picked === 'all' ? null : seasonChange(rows, picked);
  const pickedName = picked === 'all' ? '' : seasonLabel(picked);
  const ghostOn = !!earlier;

  // ── season rows (always every season: the comparison itself) ──
  const seasonRows: ScaleRow[] = [];
  for (const r of [...rows].reverse()) {
    seasonRows.push({
      key: String(r.season), label: seasonLabel(r.season), sub: t.nReports(r.reports), strong: picked === r.season,
      avg: gradeAvg(r.grade), n: r.grade.obs, testId: `coachee-stats-season-${r.season}`,
    });
    if (r.byRole['1SR'].obs > 0 && r.byRole['2SR'].obs > 0) {
      for (const k of ['1SR', '2SR'] as StatRole[]) {
        seasonRows.push({ key: `${r.season}-${k}`, label: t.roleName[k], indent: true, avg: gradeAvg(r.byRole[k]), n: r.byRole[k].obs });
      }
    }
  }
  const latestGraded = [...rows].reverse().find((r) => r.grade.obs > 0);
  const latestChange = latestGraded ? seasonChange(rows, latestGraded.season) : null;

  // ── each report's average ──
  const graded = stats.timeline.filter((p) => p.avg !== null);
  const step = Math.max(1, Math.ceil(graded.length / 6));
  const points: LinePoint[] = graded.map((p, i) => ({
    key: p.id,
    label: i % step === 0 || i === graded.length - 1 ? shortDate(p.date) : '',
    value: p.avg, n: p.n,
    hint: `${shortDate(p.date)} · ${t.roleName[p.role]}`,
  }));
  const sinceFirst = firstToLatest(stats);

  // ── letters ──
  const totalGrades = STAT_LETTERS.reduce((a, l) => a + stats.letters[l], 0);
  const letterRows: BarRow[] = STAT_LETTERS.map((l) => ({
    key: l, label: l, value: stats.letters[l],
    sub: totalGrades ? `${Math.round((stats.letters[l] / totalGrades) * 100)} %` : undefined,
  }));

  // ── per role: sections, criteria, strengths ──
  const ghostTitle = (label: string, now: number | null, n: number, before: number | null | undefined) =>
    typeof before === 'number'
      ? `${label}: ${now === null ? '–' : scoreToLetter(now)} · ${t.nReports(n)} · ${t.earlier}: ${scoreToLetter(before)}`
      : undefined;
  let sectionRows: ScaleRow[] = [];
  let criteriaGroups: Array<{ section: number; rows: ScaleRow[] }> = [];
  let sw: ReturnType<typeof fileStrengths> | null = null;
  if (role) {
    const before = new Map<string, number | null>();
    if (earlier) {
      for (const s of earlier.sections) if (s.role === role) before.set(`s${s.section}`, gradeAvg(s.grade));
      for (const c of earlier.criteria) if (c.role === role) before.set(`c${c.id}`, gradeAvg(c.grade));
    }
    sectionRows = stats.sections.filter((s) => s.role === role).map((s) => {
      const label = sectionTitle(role, s.section, lang);
      const a = gradeAvg(s.grade);
      const ghost = before.get(`s${s.section}`);
      return { key: `s${s.section}`, label, avg: a, n: s.grade.obs, ghost, title: ghostTitle(label, a, s.grade.obs, ghost), testId: 'coachee-stats-section' };
    });
    const form = FORMS[role][lang];
    const bySection = new Map<number, FileCriterionAgg[]>();
    for (const c of stats.criteria) {
      if (c.role !== role) continue;
      const list = bySection.get(c.section) ?? [];
      list.push(c);
      bySection.set(c.section, list);
    }
    criteriaGroups = [...bySection.entries()].sort((a, b) => a[0] - b[0]).map(([section, list]) => {
      // The form's own order; a criterion it no longer has goes last.
      const order = (form[section]?.items ?? []).map((it) => it.id);
      const at = (id: string) => { const i = order.indexOf(id); return i < 0 ? order.length : i; };
      return {
        section,
        rows: [...list].sort((a, b) => at(a.id) - at(b.id)).map((c) => {
          const label = criterionLabel(role, c.id, lang);
          const a = gradeAvg(c.grade);
          const ghost = before.get(`c${c.id}`);
          return { key: c.id, label, avg: a, n: c.grade.obs, ghost, title: ghostTitle(label, a, c.grade.obs, ghost), testId: 'coachee-stats-criterion' };
        }),
      };
    });
    sw = fileStrengths(stats, role);
  }
  const roleName = role ? t.roleName[role] : '';
  const ghostLegend = ghostOn && (
    <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-stone-500" data-testid="coachee-stats-ghost-legend">
      <span className="inline-flex items-center gap-1.5"><span className="inline-block h-3 w-3 rounded-full ring-2 ring-white" style={{ background: SERIES[0] }} /> {pickedName}</span>
      <span className="inline-flex items-center gap-1.5"><span className="inline-block h-2.5 w-2.5 rounded-full border-2 border-stone-400 bg-white" /> {t.earlier}</span>
    </div>
  );

  return (
    <div className="space-y-4" data-testid="coachee-stats" data-log-redact>
      {seasons.length > 1 && (
        <Toggle
          label={t.seasonPick} testId="coachee-stats-seasons" value={picked} onChange={setSeason}
          options={[{ key: 'all' as const, label: t.seasonAll }, ...seasons.map((s) => ({ key: s, label: seasonLabel(s) }))]}
        />
      )}

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2" data-testid="coachee-stats-tiles">
        <StatTile hero label={t.reports} value={fmtInt(stats.reports)} sub={t.roleSplit(stats.roles['1SR'], stats.roles['2SR'])} />
        <StatTile
          hero label={t.avg}
          value={avg === null ? '–' : <span className={isThin(stats.grade.obs) ? 'text-stone-500' : undefined}>{scoreToLetter(avg)}</span>}
          sub={avg === null ? undefined : isThin(stats.grade.obs) ? t.fromReports(stats.grade.obs) : t.normalCase}
          delta={change ? t.vsSeason(change.reading, seasonLabel(change.previous)) : null}
        />
        <StatTile label={t.grades} value={fmtInt(totalGrades)} />
        <StatTile label={t.coaches} value={fmtInt(stats.coaches)} sub={t.coachesSub} />
      </div>

      {rows.length > 1 && (
        <Block title={t.seasonsTitle} desc={t.seasonsDesc} testId="coachee-stats-seasons-block">
          <GradeScale rows={seasonRows} nLabel={t.nReports} />
          {latestChange && (
            <p className="mt-3 text-sm text-stone-700" data-testid="coachee-stats-season-line">
              {t.seasonsLine(latestChange.reading, seasonLabel(latestChange.season), seasonLabel(latestChange.previous))}
            </p>
          )}
        </Block>
      )}

      {stats.graded === 0 && (
        <div className={`${card} p-6 text-center text-sm text-stone-500`}>{t.emptySeason}</div>
      )}

      {points.length >= 2 && (
        <Block title={t.trendTitle} desc={t.trendDesc} testId="coachee-stats-trend">
          <GradeLine points={points} nLabel={t.nGrades} />
          {sinceFirst && <p className="mt-2 text-sm text-stone-700">{t.trendLine(sinceFirst.reading)}</p>}
        </Block>
      )}

      {totalGrades > 0 && (
        <Block title={t.distTitle} desc={t.distDesc} testId="coachee-stats-letters">
          <BarList rows={letterRows} />
        </Block>
      )}

      {role && (
        <>
          {rolesWithGrades.length > 1 && (
            <Toggle
              label={t.rolePick} testId="coachee-stats-roles" value={role} onChange={setRolePick}
              options={rolesWithGrades.map((r) => ({ key: r, label: t.roleName[r] }))}
            />
          )}

          <Block title={`${t.sectionsTitle} · ${roleName}`} desc={t.sectionsDesc(roleName) + (ghostOn ? t.ghostDesc(pickedName) : '')} testId="coachee-stats-sections">
            <GradeScale rows={sectionRows} nLabel={t.nReports} />
            {ghostLegend}
          </Block>

          {sw && (
            <Block title={`${t.swTitle} · ${roleName}`} desc={t.swDesc(roleName)} testId="coachee-stats-strengths">
              {sw.strong.length === 0 && sw.weak.length === 0 ? (
                <p className="text-sm text-stone-500">{t.swNone}</p>
              ) : (
                <div className="grid sm:grid-cols-2 gap-4">
                  {([['strong', sw.strong, '#1f7a4d', '▲'], ['weak', sw.weak, '#b00016', '▼']] as const).map(([key, list, color, mark]) => (
                    list.length > 0 && (
                      <div key={key} data-testid={`coachee-stats-${key}`}>
                        <p className="text-[11px] font-semibold uppercase tracking-wide" style={{ color }}>{mark} {key === 'strong' ? t.strong : t.weak}</p>
                        <ul className="mt-1.5 space-y-1.5">
                          {list.map((c) => (
                            <li key={c.id} className="flex items-start justify-between gap-3 text-sm text-stone-700">
                              <span className="leading-snug">{criterionLabel(role, c.id, lang)}</span>
                              <span className="font-semibold tabular-nums text-stone-800 shrink-0">{c.avg === null ? '–' : scoreToLetter(c.avg)}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )
                  ))}
                </div>
              )}
            </Block>
          )}

          <Block title={`${t.criteriaTitle} · ${roleName}`} desc={t.criteriaDesc(roleName) + (ghostOn ? t.ghostDesc(pickedName) : '')} testId="coachee-stats-criteria">
            <GradeScaleGrid>
              {criteriaGroups.map((g) => (
                <div key={g.section} className={`${WIDE_SCALE_ROW} mb-4 last:mb-0`}>
                  <GradeScale wide heading={sectionTitle(role, g.section, lang)} rows={g.rows} nLabel={t.nReports} />
                </div>
              ))}
            </GradeScaleGrid>
            {ghostLegend}
          </Block>
        </>
      )}

      <section className="rounded-2xl border border-dashed border-stone-300 px-4 py-3" data-testid="coachee-stats-method">
        <h3 className="text-xs font-semibold text-stone-600">{t.methodTitle}</h3>
        <p className="mt-1 text-xs leading-relaxed text-stone-500">{t.method}</p>
      </section>
    </div>
  );
}
