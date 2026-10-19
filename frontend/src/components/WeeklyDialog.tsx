import { useEffect, useState } from "react";
import type { WeeklyReview } from "../api";
import { api } from "../api";
import { formatMinutes } from "../utils";
import { Icon } from "./Icon";

function shortDate(day: string): string {
  return new Date(`${day}T12:00:00`).toLocaleDateString("ru-RU", {
    day: "numeric",
    month: "long",
  });
}

/** Обзор периода: факты считает Planer, ИИ объясняет их и советует, что поменять. */
export function WeeklyDialog({
  start,
  end,
  onClose,
  onOpenDay,
}: {
  start: string;
  end: string;
  onClose: () => void;
  onOpenDay: (day: string) => void;
}) {
  const [data, setData] = useState<WeeklyReview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let alive = true;
    api.aiWeekly(start, end).then(
      (d) => alive && setData(d),
      (e) => alive && setError(e.message),
    );
    return () => {
      alive = false;
    };
  }, [start, end]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const f = data?.facts;
  const r = data?.review;
  const advice = new Map(r?.stuck.map((s) => [s.id, s.advice]));

  const copy = async () => {
    if (!f || !r) return;
    const text = [
      `Обзор ${shortDate(f.start)} — ${shortDate(f.end)}`,
      r.summary,
      r.wins.length ? "Сделано:\n" + r.wins.map((w) => `- ${w}`).join("\n") : "",
      f.stuck.length
        ? "Буксует:\n" +
          f.stuck.map((s) => `- ${s.title}${advice.get(s.id) ? ` — ${advice.get(s.id)}` : ""}`).join("\n")
        : "",
      r.estimates,
      r.suggestions.length ? "На следующую неделю:\n" + r.suggestions.map((s) => `- ${s}`).join("\n") : "",
    ]
      .filter(Boolean)
      .join("\n\n");
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* буфер обмена недоступен */
    }
  };

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog wide" role="dialog" aria-label="Обзор периода">
        <header className="dialog-head">
          <h2>
            <Icon name="review" /> Обзор: {shortDate(start)} — {shortDate(end)}
          </h2>
          <button className="icon-btn" onClick={onClose} aria-label="Закрыть">
            <Icon name="x" />
          </button>
        </header>

        {error && <div className="error">{error}</div>}
        {!data && !error && (
          <div className="parsing">
            <Icon name="loader" /> Считаю итоги и спрашиваю ИИ…
          </div>
        )}

        {f && r && (
          <div className="weekly">
            <div className="weekly-facts">
              <div>
                <strong>
                  {f.planned_done} из {f.planned}
                </strong>
                <span>задач плана</span>
              </div>
              <div>
                <strong>{f.done}</strong>
                <span>
                  сделано
                  {f.unplanned_done ? `, ${f.unplanned_done} вне плана` : ""}
                </span>
              </div>
              <div>
                <strong>{formatMinutes(f.focus_min)}</strong>
                <span>по таймеру</span>
              </div>
              <div>
                <strong>{f.moved}</strong>
                <span>переносов</span>
              </div>
            </div>

            <p className="weekly-summary">{r.summary}</p>

            {r.wins.length > 0 && (
              <section>
                <div className="field-label">Главное</div>
                <ul className="weekly-list">
                  {r.wins.map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              </section>
            )}

            {f.stuck.length > 0 && (
              <section>
                <div className="field-label">Буксует</div>
                <ul className="weekly-list stuck">
                  {f.stuck.map((s) => (
                    <li key={s.id}>
                      <button className="link-like" onClick={() => onOpenDay(s.day)}>
                        {s.title}
                      </button>
                      <span className="muted small">
                        {s.carried >= 2 && ` · переносилась ${s.carried} раза`}
                        {s.overdue && s.deadline && ` · просрочена (срок ${shortDate(s.deadline)})`}
                      </span>
                      {advice.get(s.id) && <div className="weekly-advice">{advice.get(s.id)}</div>}
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {(r.estimates || f.estimates.tasks > 0) && (
              <section>
                <div className="field-label">Оценки времени</div>
                {f.estimates.ratio != null && (
                  <p className="muted small">
                    По {f.estimates.tasks} задачам с таймером: оценка {formatMinutes(f.estimates.estimate_min)}, факт{" "}
                    {formatMinutes(f.estimates.actual_min)} (×
                    {f.estimates.ratio.toString().replace(".", ",")})
                  </p>
                )}
                {r.estimates && <p>{r.estimates}</p>}
              </section>
            )}

            {r.suggestions.length > 0 && (
              <section>
                <div className="field-label">На следующую неделю</div>
                <ul className="weekly-list">
                  {r.suggestions.map((s, i) => (
                    <li key={i}>{s}</li>
                  ))}
                </ul>
              </section>
            )}
          </div>
        )}

        <footer className="dialog-foot">
          <span className="spacer" />
          {f && (
            <button className="btn ghost" onClick={copy}>
              <Icon name={copied ? "check" : "text"} /> {copied ? "Скопировано" : "Скопировать текст"}
            </button>
          )}
          <button className="btn" onClick={onClose}>
            Закрыть
          </button>
        </footer>
      </div>
    </div>
  );
}
