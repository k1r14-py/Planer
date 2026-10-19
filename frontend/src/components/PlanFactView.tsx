import { useEffect, useState } from "react";
import type { Day, Task, VoiceStatus } from "../api";
import { api } from "../api";
import { useAI } from "../ai";
import { childrenMap, formatClock, formatMinutes, liveSeconds } from "../utils";
import { Icon } from "./Icon";
import { ReviewDialog } from "./ReviewDialog";
import { SummaryCard } from "./SummaryCard";

const STATUS_LABEL: Record<Task["status"], string> = {
  todo: "не сделано",
  done: "сделано",
  skipped: "пропущено",
  moved: "перенесено",
};

export function PlanFactView({
  data,
  now,
  voice,
  onChange,
}: {
  data: Day;
  now: number;
  voice: VoiceStatus | null;
  onChange: (d: Day) => void;
}) {
  const ai = useAI();
  const [review, setReview] = useState(false);
  const kids = childrenMap(data.tasks);
  const top = kids.get(null) ?? [];
  const planned = top.filter((t) => t.planned);
  const doneAll = data.tasks.filter((t) => t.status === "done");
  const doneTop = top.filter((t) => t.status === "done");
  const extra = top.filter((t) => !t.planned);

  const [note, setNote] = useState(data.note);
  useEffect(() => setNote(data.note), [data.day, data.note]);

  const spent = (t: Task) =>
    liveSeconds(t, now) + (kids.get(t.id) ?? []).reduce((s, c) => s + liveSeconds(c, now), 0);

  return (
    <div className="planfact">
      <SummaryCard data={data} now={now} />

      <div className="columns">
        <section className="card column">
          <h3>
            <Icon name="list" /> План
            <span className="muted small">{data.plan_locked_at ? "зафиксирован" : "ещё не зафиксирован"}</span>
          </h3>
          {planned.length ? (
            <ul className="pf-list">
              {planned.map((t) => {
                const sub = kids.get(t.id) ?? [];
                return (
                  <li key={t.id} className={`pf-row ${t.status}`}>
                    <span className={`dot ${t.status}`} />
                    <span className="pf-title">
                      {t.title}
                      {sub.length > 0 && (
                        <span className="muted small">
                          {" "}
                          · подзадачи {sub.filter((c) => c.status === "done").length}/{sub.length}
                        </span>
                      )}
                    </span>
                    <span className="pf-meta">
                      {t.estimate_min != null && formatMinutes(t.estimate_min)}
                      <span className={`status-tag ${t.status}`}>{STATUS_LABEL[t.status]}</span>
                    </span>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="muted">Плановых задач нет.</p>
          )}
        </section>

        <section className="card column">
          <h3>
            <Icon name="check" /> Факт
            <span className="muted small">
              {doneAll.length} выполнено{extra.length ? `, ${extra.length} вне плана` : ""}
            </span>
          </h3>
          {doneTop.length || extra.length ? (
            <ul className="pf-list">
              {doneTop.map((t) => (
                <li key={t.id} className="pf-row done">
                  <span className="dot done" />
                  <span className="pf-title">
                    {t.title} {!t.planned && <span className="badge accent">вне плана</span>}
                  </span>
                  <span className="pf-meta">
                    {spent(t) > 0 && <span className="mono">{formatClock(spent(t))}</span>}
                    {t.estimate_min != null && <span className="muted">/ {formatMinutes(t.estimate_min)}</span>}
                    {t.done_at && (
                      <span className="muted">
                        {new Date(t.done_at).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}
                      </span>
                    )}
                  </span>
                </li>
              ))}
              {extra
                .filter((t) => t.status !== "done")
                .map((t) => (
                  <li key={t.id} className={`pf-row ${t.status}`}>
                    <span className={`dot ${t.status}`} />
                    <span className="pf-title">
                      {t.title} <span className="badge accent">вне плана</span>
                    </span>
                    <span className="pf-meta">
                      <span className={`status-tag ${t.status}`}>{STATUS_LABEL[t.status]}</span>
                    </span>
                  </li>
                ))}
              {doneAll
                .filter((t) => t.parent_id !== null && !doneTop.some((p) => p.id === t.parent_id))
                .map((t) => (
                  <li key={t.id} className="pf-row done sub">
                    <span className="dot done" />
                    <span className="pf-title">
                      {t.title}{" "}
                      <span className="muted small">
                        — подзадача «{data.tasks.find((p) => p.id === t.parent_id)?.title}»
                      </span>
                    </span>
                    <span className="pf-meta" />
                  </li>
                ))}
            </ul>
          ) : (
            <p className="muted">Пока ничего не выполнено.</p>
          )}
        </section>
      </div>

      <section className="card">
        <div className="card-head">
          <h3>
            <Icon name="edit" /> Итоги дня
          </h3>
          <button
            className="btn sm"
            onClick={() => (ai.ready ? setReview(true) : ai.openSettings())}
            title={ai.ready ? "Расскажите, как прошёл день — ИИ отметит задачи и заполнит итоги" : "Нужен ИИ-помощник"}
          >
            <Icon name="sparkles" /> Итоги голосом
          </button>
        </div>
        <textarea
          className="textarea"
          rows={3}
          value={note}
          placeholder="Что получилось, что помешало, что поменять завтра…"
          onChange={(e) => setNote(e.target.value)}
          onBlur={() => note !== data.note && api.setNote(data.day, note).then(onChange)}
        />
      </section>

      {review && <ReviewDialog data={data} voice={voice} onClose={() => setReview(false)} onApplied={onChange} />}
    </div>
  );
}
