import { useEffect, useState } from "react";
import type { Day, PlanCandidate, PlanProposal } from "../api";
import { api } from "../api";
import { formatMinutes } from "../utils";
import { Icon } from "./Icon";

const HOURS_KEY = "planer-plan-hours";

function storedHours(): number {
  try {
    return Number(localStorage.getItem(HOURS_KEY)) || 6;
  } catch {
    return 6;
  }
}

function shortDate(day: string): string {
  return new Date(`${day}T12:00:00`).toLocaleDateString("ru-RU", {
    day: "numeric",
    month: "short",
  });
}

function sourceLabel(c: PlanCandidate, day: string): string | null {
  if (c.source === "past") return `хвост с ${shortDate(c.day)}`;
  if (c.source === "future") return `из ${shortDate(c.day)}`;
  return c.day === day ? null : shortDate(c.day);
}

interface Row {
  key: string;
  id: number | null; // null — новая задача
  title: string;
  estimate: number | null;
  why: string;
  on: boolean;
  candidate?: PlanCandidate;
}

/** План утра: сколько есть часов и пожелания → ИИ предлагает порядок дня → пользователь правит и применяет. */
export function PlanDayDialog({
  day,
  onClose,
  onApplied,
}: {
  day: string;
  onClose: () => void;
  onApplied: (d: Day) => void;
}) {
  const [hours, setHours] = useState(storedHours);
  const [wishes, setWishes] = useState("");
  const [proposal, setProposal] = useState<PlanProposal | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [later, setLater] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !busy && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  const propose = async () => {
    setBusy(true);
    setError(null);
    try {
      localStorage.setItem(HOURS_KEY, String(hours));
    } catch {
      /* ignore */
    }
    try {
      const p = await api.aiPlanDay(day, hours, wishes);
      const byId = new Map(p.candidates.map((c) => [c.id, c]));
      setProposal(p);
      setRows([
        ...p.plan.map((x) => {
          const c = byId.get(x.id)!;
          return {
            key: `t${x.id}`,
            id: x.id,
            title: c.title,
            estimate: c.estimate_min ?? x.estimate_min,
            why: x.why,
            on: true,
            candidate: c,
          };
        }),
        ...p.new_tasks.map((t, i) => ({
          key: `n${i}`,
          id: null,
          title: t.title,
          estimate: t.estimate_min,
          why: "из ваших пожеланий",
          on: true,
        })),
      ]);
      setLater(new Set(p.later.map((x) => x.id)));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const move = (i: number, d: -1 | 1) =>
    setRows((rs) => {
      const j = i + d;
      if (j < 0 || j >= rs.length) return rs;
      const next = [...rs];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });

  const toggle = (key: string) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, on: !r.on } : r)));

  const apply = async () => {
    if (!proposal) return;
    setBusy(true);
    setError(null);
    const chosen = rows.filter((r) => r.on);
    const estimates: Record<number, number> = {};
    for (const r of chosen) if (r.id && r.estimate && !r.candidate?.estimate_min) estimates[r.id] = r.estimate;
    try {
      onApplied(
        await api.aiPlanApply({
          day,
          order: chosen.filter((r) => r.id).map((r) => r.id!),
          estimates,
          later: [...later],
          new_tasks: chosen.filter((r) => !r.id).map((r) => ({ title: r.title, estimate_min: r.estimate })),
        }),
      );
      onClose();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  const total = rows.filter((r) => r.on).reduce((s, r) => s + (r.estimate ?? 0), 0);
  const over = total > hours * 60;
  const title = (id: number) => proposal?.candidates.find((c) => c.id === id)?.title ?? `#${id}`;

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="dialog wide" role="dialog" aria-label="План дня">
        <header className="dialog-head">
          <h2>
            <Icon name="target" /> Спланировать день
          </h2>
          <button className="icon-btn" onClick={onClose} aria-label="Закрыть">
            <Icon name="x" />
          </button>
        </header>

        {!proposal ? (
          <>
            <p className="muted dialog-intro">
              ИИ посмотрит задачи на сегодня, хвосты прошлых дней и ближайшие сроки и предложит порядок дня, который
              влезает в ваше время. Ничего не изменится, пока вы не нажмёте «Применить».
            </p>
            <label className="form-field">
              <span>Сколько часов сегодня на задачи (без встреч и перерывов)</span>
              <div className="field-row">
                <input
                  type="number"
                  min={0.5}
                  max={16}
                  step={0.5}
                  value={hours}
                  onChange={(e) => setHours(Math.max(0.5, Math.min(16, Number(e.target.value) || 0)))}
                  className="hours-input"
                />
                <span className="muted">ч</span>
              </div>
            </label>
            <label className="form-field">
              <span>Пожелания (необязательно)</span>
              <textarea
                className="textarea"
                rows={3}
                value={wishes}
                onChange={(e) => setWishes(e.target.value)}
                placeholder="Например: главное — закончить отчёт; после обеда созвоны; ещё надо позвонить врачу"
              />
            </label>
            {busy && (
              <div className="parsing">
                <Icon name="loader" /> ИИ составляет план…
              </div>
            )}
          </>
        ) : (
          <div className="plan-proposal">
            {proposal.note && <p className="plan-note">{proposal.note}</p>}
            <div className={`plan-total ${over ? "over" : ""}`}>
              Запланировано {formatMinutes(total)} из {formatMinutes(hours * 60)}
              {over && " — больше, чем есть времени"}
            </div>
            <ol className="plan-list">
              {rows.map((r, i) => {
                const src = r.candidate ? sourceLabel(r.candidate, day) : "новая";
                return (
                  <li key={r.key} className={r.on ? "" : "off"}>
                    <input type="checkbox" checked={r.on} onChange={() => toggle(r.key)} aria-label="Взять в план" />
                    <span className="plan-main">
                      <span className="plan-title">{r.title}</span>
                      <span className="plan-meta muted small">
                        {src && <span className="badge">{src}</span>}
                        {r.candidate?.deadline && (
                          <span className="badge warn">срок {shortDate(r.candidate.deadline)}</span>
                        )}
                        {r.candidate && r.candidate.carried >= 2 && (
                          <span className="badge warn">переносилась {r.candidate.carried} раза</span>
                        )}
                        {r.why}
                      </span>
                    </span>
                    <span
                      className="plan-est muted small"
                      title={r.candidate?.estimate_min ? "ваша оценка" : "оценка ИИ"}
                    >
                      {r.estimate ? formatMinutes(r.estimate) : "—"}
                      {r.estimate && !r.candidate?.estimate_min ? " ✦" : ""}
                    </span>
                    <span className="plan-move">
                      <button className="icon-btn sm" onClick={() => move(i, -1)} disabled={i === 0} aria-label="Выше">
                        <Icon name="chevron-up" />
                      </button>
                      <button
                        className="icon-btn sm"
                        onClick={() => move(i, 1)}
                        disabled={i === rows.length - 1}
                        aria-label="Ниже"
                      >
                        <Icon name="chevron-down" />
                      </button>
                    </span>
                  </li>
                );
              })}
            </ol>
            <p className="muted small">✦ — оценка ИИ, её запишем в задачу. Ваши оценки не меняются.</p>
            {proposal.later.length > 0 && (
              <section>
                <div className="field-label">Отложить на завтра</div>
                {proposal.later.map((x) => (
                  <label key={x.id} className="review-row">
                    <input
                      type="checkbox"
                      checked={later.has(x.id)}
                      onChange={() =>
                        setLater((s) => {
                          const n = new Set(s);
                          if (n.has(x.id)) n.delete(x.id);
                          else n.add(x.id);
                          return n;
                        })
                      }
                    />
                    {title(x.id)}
                    {x.why && <span className="muted small"> — {x.why}</span>}
                  </label>
                ))}
              </section>
            )}
          </div>
        )}

        {error && <div className="error">{error}</div>}

        <footer className="dialog-foot">
          {proposal && (
            <button className="btn ghost" onClick={() => setProposal(null)} disabled={busy}>
              Заново
            </button>
          )}
          <span className="spacer" />
          <button className="btn ghost" onClick={onClose}>
            Отмена
          </button>
          {proposal ? (
            <button className="btn primary" onClick={apply} disabled={busy || !rows.some((r) => r.on)}>
              {busy ? <Icon name="loader" /> : <Icon name="check" />} Применить
            </button>
          ) : (
            <button className="btn primary" onClick={propose} disabled={busy}>
              {busy ? <Icon name="loader" /> : <Icon name="sparkles" />} Предложить план
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}
