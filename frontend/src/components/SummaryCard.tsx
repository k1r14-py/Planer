import type { Day } from "../api";
import { formatMinutes, liveSeconds, percent } from "../utils";

export function SummaryCard({ data, now }: { data: Day; now: number }) {
  const s = data.summary;
  const pct = percent(s.planned_done, s.planned_total);
  const actualMin = data.tasks.reduce((sum, t) => sum + liveSeconds(t, now), 0) / 60;
  const R = 26;
  const C = 2 * Math.PI * R;

  return (
    <section className="summary card">
      <div className="ring" aria-label={`План выполнен на ${pct}%`}>
        <svg viewBox="0 0 64 64" width="72" height="72">
          <circle cx="32" cy="32" r={R} className="ring-track" />
          <circle
            cx="32"
            cy="32"
            r={R}
            className="ring-value"
            strokeDasharray={C}
            strokeDashoffset={C * (1 - pct / 100)}
          />
        </svg>
        <span className="ring-label">{pct}%</span>
      </div>
      <div className="stats">
        <Stat label="Из плана" value={`${s.planned_done} / ${s.planned_total}`} />
        <Stat
          label="Вне плана"
          value={`${s.unplanned_done} / ${s.unplanned_total}`}
          hint="выполнено / добавлено"
        />
        <Stat label="Оценка плана" value={formatMinutes(s.estimate_planned_min)} />
        <Stat label="Затрачено" value={formatMinutes(actualMin)} />
        {(s.moved > 0 || s.skipped > 0) && (
          <Stat label="Перенесено · пропущено" value={`${s.moved} · ${s.skipped}`} />
        )}
      </div>
    </section>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="stat" title={hint}>
      <span className="stat-value">{value}</span>
      <span className="stat-label">{label}</span>
    </div>
  );
}
