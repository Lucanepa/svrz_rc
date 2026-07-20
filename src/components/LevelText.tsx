import { levelDisplay } from '../lib/niveauTargets';

// Renders a coachee's Niveau/Stufe, with the TBD part (unknown Stufe or
// unmappable Niveau) highlighted in red.
export default function LevelText({ level, stage, sep = '-' }: { level?: string; stage?: string; sep?: string }) {
  const d = levelDisplay(level, stage, sep);
  if (!d.tbd) return <>{d.text}</>;
  return <>{d.text.slice(0, -3)}<span className="text-red-600 font-semibold">TBD</span></>;
}
