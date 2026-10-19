import { useEffect, useState } from "react";
import type { HistoryRow } from "../api";
import { api } from "../api";
import { formatMinutes, percent, shiftDay } from "../utils";

const RANGE = 14;

export function HistoryView({ today, onPick }: { today: string; onPick: (day: string) => void }) {
  const [rows, setRows] = useState<HistoryRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.history(shiftDay(today, -(RANGE - 1)), today).then(setRows, (e) => setError(e.message));
  }, [today]);

  if (error) return <div className="error">{error}</div>;
  if (!rows) return <div className="muted">Загрузка…</div>;

  const max = Math.max(1, ...rows.map((r) => Math.max(r.planned_total, r.planned_done + r.unplanned_done)));
  const totals = rows.reduce(
    (a, r) => ({
      planned: a.planned + r.planned_total,
      done: a.done + r.planned_done,
      extra: a.extra + r.unplanned_done,
      sec: a.sec + r.actual_sec,
    }),
    { planned: 0, done: 0, extra: 0, sec: 0 },
  );

  return (
    <div className="history">
      <section className="card summary-row">
        <div className="stat">
          <span className="stat-value">{percent(totals.done, totals.planned)}%</span>
          <span className="stat-label">плана выполнено за {RANGE} дней</span>
        </div>
        <div className="stat">
          <span className="stat-value">
            {totals.done} / {totals.planned}
          </span>
          <span className="stat-label">задач из плана</span>
        </div>
        <div className="stat">
          <span className="stat-value">{totals.extra}</span>
          <span className="stat-label">внеплановых сделано</span>
        </div>
        <div className="stat">
          <span className="stat-value">{formatMinutes(totals.sec / 60)}</span>
          <span className="stat-label">засечено таймером</span>
        </div>
      </section>

      <section className="card">
        <div className="legend">
          <span>
            <i className="sw planned" /> в плане
          </span>
          <span>
            <i className="sw done" /> сделано из плана
          </span>
          <span>
            <i className="sw extra" /> сделано вне плана
          </span>
        </div>
        <div className="bars">
          {rows.map((r) => {
            const d = new Date(`${r.day}T12:00:00`);
            return (
              <button
                key={r.day}
                className={`bar-col ${r.day === today ? "today" : ""}`}
                onClick={() => onPick(r.day)}
                title={`${d.toLocaleDateString("ru-RU")}: ${r.planned_done}/${r.planned_total} из плана, +${r.unplanned_done} вне плана`}
              >
                <div className="bar-stack">
                  <div className="bar planned" style={{ height: `${(r.planned_total / max) * 100}%` }} />
                  <div className="bar-fact">
                    <div className="bar extra" style={{ height: `${(r.unplanned_done / max) * 100}%` }} />
                    <div className="bar done" style={{ height: `${(r.planned_done / max) * 100}%` }} />
                  </div>
                </div>
                <span className="bar-label">{d.toLocaleDateString("ru-RU", { weekday: "short" })}</span>
                <span className="bar-date">{d.getDate()}</span>
              </button>
            );
          })}
        </div>
      </section>
    </div>
  );
}
