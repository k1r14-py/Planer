import { useEffect, useState } from "react";
import type { Dashboard } from "../../api";
import { api } from "../../api";
import { useAI } from "../../ai";
import { useProjects } from "../../projects";
import { formatMinutes, isoDay, shiftDay } from "../../utils";
import { Icon } from "../Icon";
import { WeeklyDialog } from "../WeeklyDialog";
import { DailyChart, DailyTable, DoneBars, Heatmap, WeekdayChart } from "./charts";

type Period = "7" | "30" | "90" | "month" | "prev-month";

const PERIODS: [Period, string][] = [
  ["7", "7 дней"],
  ["30", "30 дней"],
  ["90", "90 дней"],
  ["month", "Этот месяц"],
  ["prev-month", "Прошлый месяц"],
];

const PREV_LABEL: Record<Period, string> = {
  "7": "к прошлым 7 дням",
  "30": "к прошлым 30 дням",
  "90": "к прошлым 90 дням",
  month: "к прошлому периоду",
  "prev-month": "к позапрошлому месяцу",
};

const STATE_KEY = "planer-dashboard";

function range(period: Period, today: string): [string, string] {
  const d = new Date(`${today}T12:00:00`);
  switch (period) {
    case "month":
      return [isoDay(new Date(d.getFullYear(), d.getMonth(), 1)), today];
    case "prev-month":
      return [isoDay(new Date(d.getFullYear(), d.getMonth() - 1, 1)), isoDay(new Date(d.getFullYear(), d.getMonth(), 0))];
    default:
      return [shiftDay(today, -(Number(period) - 1)), today];
  }
}

function loadState(): { period: Period; project: string } {
  try {
    return { period: "30", project: "", ...JSON.parse(localStorage.getItem(STATE_KEY) || "{}") };
  } catch {
    return { period: "30", project: "" };
  }
}

export function DashboardView({ today, onOpenDay }: { today: string; onOpenDay: (day: string) => void }) {
  const { projects, byId } = useProjects();
  const [state, setState] = useState(loadState);
  const [data, setData] = useState<Dashboard | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [table, setTable] = useState(false);
  const [review, setReview] = useState<[string, string] | null>(null);
  const ai = useAI();

  useEffect(() => {
    try {
      localStorage.setItem(STATE_KEY, JSON.stringify(state));
    } catch {
      /* ignore */
    }
    const [start, end] = range(state.period, today);
    setLoading(true);
    api
      .dashboard(start, end, state.project ? Number(state.project) : undefined)
      .then(
        (d) => {
          setData(d);
          setError(null);
        },
        (e) => setError(e.message),
      )
      .finally(() => setLoading(false));
  }, [state, today]);

  const set = (patch: Partial<typeof state>) => setState((s) => ({ ...s, ...patch }));
  const k = data?.kpi;
  const prevLabel = PREV_LABEL[state.period];

  return (
    <div className="dashboard">
      <div className="dash-filters">
        <div className="segmented" role="tablist" aria-label="Период">
          {PERIODS.map(([id, label]) => (
            <button
              key={id}
              role="tab"
              aria-selected={state.period === id}
              className={state.period === id ? "active" : ""}
              onClick={() => set({ period: id })}
            >
              {label}
            </button>
          ))}
        </div>
        <select value={state.project} onChange={(e) => set({ project: e.target.value })} aria-label="Проект">
          <option value="">Все проекты</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <span className="spacer" />
        <button
          className="btn sm"
          onClick={() => (ai.ready ? setReview(range(state.period, today)) : ai.openSettings())}
          title="ИИ объяснит итоги периода: что получилось, что буксует, где расходятся оценки"
        >
          <Icon name="sparkles" /> Обзор с ИИ
        </button>
      </div>
      {review && <WeeklyDialog start={review[0]} end={review[1]} onClose={() => setReview(null)} onOpenDay={onOpenDay} />}

      {error && <div className="error">{error}</div>}

      {data && k && (
        <div className={`dash-body ${loading ? "refetching" : ""}`}>
          <section className="kpi-row">
            <Kpi
              label="Выполнение плана"
              value={k.completion.value == null ? "—" : `${Math.round(k.completion.value * 100)}%`}
              delta={
                k.completion.value != null && k.completion.prev != null
                  ? { diff: Math.round((k.completion.value - k.completion.prev) * 100), unit: " п.п.", hint: prevLabel }
                  : null
              }
            />
            <Kpi
              label="Сделано задач"
              value={String(k.done.value)}
              delta={{ diff: k.done.value - k.done.prev, unit: "", hint: prevLabel }}
            />
            <Kpi
              label="Время по таймеру"
              value={formatMinutes(k.focus_sec.value / 60)}
              delta={
                k.focus_sec.value || k.focus_sec.prev
                  ? {
                      diff: Math.round((k.focus_sec.value - k.focus_sec.prev) / 60),
                      unit: " мин",
                      hint: prevLabel,
                    }
                  : null
              }
            />
            <Kpi
              label="Точность оценок"
              value={k.accuracy.ratio == null ? "—" : `×${k.accuracy.ratio.toFixed(1).replace(".", ",")}`}
              note={
                k.accuracy.ratio == null
                  ? "засеките таймер у задач с оценкой"
                  : k.accuracy.ratio > 1.1
                    ? `задачи идут дольше оценки · ${k.accuracy.tasks} шт.`
                    : k.accuracy.ratio < 0.9
                      ? `задачи идут быстрее оценки · ${k.accuracy.tasks} шт.`
                      : `оценки точные · ${k.accuracy.tasks} шт.`
              }
            />
            <Kpi
              label="Серия"
              value={`${k.streak} ${plural(k.streak, "день", "дня", "дней")}`}
              note="подряд с выполненными задачами"
            />
            <Kpi
              label="Просрочено"
              value={String(k.overdue)}
              status={k.overdue > 0 ? "critical" : "good"}
              note={k.overdue > 0 ? "открытых задач со сроком в прошлом" : "просроченных задач нет"}
            />
          </section>

          <section className="card">
            <div className="card-head">
              <h3>Сделано по дням</h3>
              <span className="muted small">
                {k.unplanned_share != null && `вне плана — ${Math.round(k.unplanned_share * 100)}% сделанного`}
              </span>
              <button className="btn ghost sm" onClick={() => setTable(!table)}>
                <Icon name={table ? "chart" : "list"} /> {table ? "График" : "Таблица"}
              </button>
            </div>
            <div className="viz-legend">
              <span>
                <i className="swatch ghost" /> в плане
              </span>
              <span>
                <i className="swatch series-1" /> сделано из плана
              </span>
              <span>
                <i className="swatch series-2" /> сделано вне плана
              </span>
            </div>
            {table ? (
              <DailyTable data={data.daily} onPick={onOpenDay} />
            ) : (
              <DailyChart data={data.daily} onPick={onOpenDay} />
            )}
          </section>

          <div className="dash-grid">
            <section className="card">
              <div className="card-head">
                <h3>Активность</h3>
                <span className="muted small">сделанные задачи по дням</span>
              </div>
              <Heatmap data={data.daily} onPick={onOpenDay} />
            </section>

            <section className="card">
              <div className="card-head">
                <h3>По дням недели</h3>
                <span className="muted small">доля выполненного плана</span>
              </div>
              <WeekdayChart data={data.weekdays} />
            </section>

            {!state.project && (
              <section className="card">
                <div className="card-head">
                  <h3>Проекты</h3>
                  <span className="muted small">сделано / всего задач</span>
                </div>
                <DoneBars
                  empty="Задач с проектами за этот период нет. Добавьте проект: «@Работа» в строке ввода."
                  items={data.projects.map((p) => ({
                    key: String(p.id),
                    label: (
                      <>
                        <i
                          className="db-dot"
                          style={{ background: p.color ?? (p.id != null ? byId.get(p.id)?.color : undefined) ?? "var(--text-3)" }}
                        />
                        {p.name}
                      </>
                    ),
                    done: p.done,
                    total: p.total,
                    note: p.focus_sec ? formatMinutes(p.focus_sec / 60) : undefined,
                  }))}
                />
              </section>
            )}

            <section className="card">
              <div className="card-head">
                <h3>Теги</h3>
                <span className="muted small">сделано / всего задач</span>
              </div>
              <DoneBars
                empty="Тегов за этот период нет. Добавьте тег: «#срочно» в строке ввода."
                items={data.tags.map((t) => ({ key: t.tag, label: `#${t.tag}`, done: t.done, total: t.total }))}
              />
            </section>
          </div>

          <BestDays data={data} onOpenDay={onOpenDay} />
        </div>
      )}
    </div>
  );
}

function plural(n: number, one: string, few: string, many: string) {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

function Kpi({
  label,
  value,
  delta,
  note,
  status,
}: {
  label: string;
  value: string;
  delta?: { diff: number; unit: string; hint: string } | null;
  note?: string;
  status?: "good" | "critical";
}) {
  return (
    <div className="kpi">
      <span className="kpi-label">
        {status && <Icon name={status === "critical" ? "flag" : "check"} />}
        {label}
      </span>
      <span className={`kpi-value ${status ?? ""}`}>{value}</span>
      {delta ? (
        <span className={`kpi-delta ${delta.diff > 0 ? "up" : delta.diff < 0 ? "down" : ""}`}>
          {delta.diff > 0 ? "▲ +" : delta.diff < 0 ? "▼ −" : ""}
          {delta.diff === 0 ? "без изменений" : `${Math.abs(delta.diff)}${delta.unit}`}
          <span className="muted"> {delta.hint}</span>
        </span>
      ) : (
        note && <span className="kpi-note muted">{note}</span>
      )}
    </div>
  );
}

/** Лучшие дни периода — быстрые ссылки на дни, где сделано больше всего. */
function BestDays({ data, onOpenDay }: { data: Dashboard; onOpenDay: (day: string) => void }) {
  const best = [...data.daily].filter((d) => d.done > 0).sort((a, b) => b.done - a.done).slice(0, 5);
  if (!best.length) return null;
  return (
    <section className="card">
      <div className="card-head">
        <h3>Самые продуктивные дни</h3>
      </div>
      <ul className="best-days">
        {best.map((d) => (
          <li key={d.day}>
            <button className="btn ghost sm" onClick={() => onOpenDay(d.day)}>
              {new Date(`${d.day}T12:00:00`).toLocaleDateString("ru-RU", { weekday: "short", day: "numeric", month: "long" })}
            </button>
            <span>
              <strong>{d.done}</strong> <span className="muted">сделано</span>
            </span>
            {d.planned > 0 && (
              <span className="muted">
                план {d.planned_done}/{d.planned}
              </span>
            )}
            {d.focus_sec > 0 && <span className="muted">{formatMinutes(d.focus_sec / 60)}</span>}
          </li>
        ))}
      </ul>
    </section>
  );
}
