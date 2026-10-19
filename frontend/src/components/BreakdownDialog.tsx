import { useEffect, useState } from "react";
import type { Day, Task } from "../api";
import { api } from "../api";
import { formatMinutes } from "../utils";
import { Icon } from "./Icon";

interface Step {
  title: string;
  estimate_min: number | null;
  on: boolean;
}

/** «Разбей на шаги»: ИИ предлагает подзадачи, пользователь выбирает нужные. */
export function BreakdownDialog({
  task,
  onClose,
  onDone,
}: {
  task: Task;
  onClose: () => void;
  onDone: (d: Promise<Day | unknown>) => void;
}) {
  const [steps, setSteps] = useState<Step[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = () => {
    setSteps(null);
    setError(null);
    api.aiBreakdown(task.id).then(
      (r) => setSteps(r.steps.map((s) => ({ ...s, on: true }))),
      (e) => setError(e.message),
    );
  };

  useEffect(load, [task.id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !saving && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [saving, onClose]);

  const chosen = steps?.filter((s) => s.on && s.title.trim()) ?? [];

  const add = async () => {
    setSaving(true);
    // по одной, по порядку — так сохраняется последовательность шагов
    const run = (async () => {
      let last: unknown = null;
      for (const s of chosen) last = await api.addTask(task.day, s.title.trim(), task.id, s.estimate_min);
      return last;
    })();
    onDone(run);
    try {
      await run;
      onClose();
    } catch (e) {
      setError((e as Error).message);
      setSaving(false);
    }
  };

  const update = (i: number, patch: Partial<Step>) =>
    setSteps((prev) => prev && prev.map((s, j) => (j === i ? { ...s, ...patch } : s)));

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && !saving && onClose()}>
      <div className="dialog" role="dialog" aria-label="Разбить на шаги">
        <header className="dialog-head">
          <h2>
            <Icon name="steps" /> Разбить на шаги
          </h2>
          <button className="icon-btn" onClick={onClose} aria-label="Закрыть">
            <Icon name="x" />
          </button>
        </header>
        <p className="muted dialog-intro">«{task.title}»</p>

        {!steps && !error && (
          <div className="parsing">
            <Icon name="loader" /> ИИ продумывает шаги…
          </div>
        )}
        {error && <div className="error">{error}</div>}

        {steps && (
          <ul className="step-list">
            {steps.map((s, i) => (
              <li key={i} className={s.on ? "" : "off"}>
                <input type="checkbox" checked={s.on} onChange={(e) => update(i, { on: e.target.checked })} aria-label="Добавить шаг" />
                <input className="draft-title" value={s.title} onChange={(e) => update(i, { title: e.target.value })} />
                <input
                  className="step-estimate"
                  inputMode="numeric"
                  value={s.estimate_min ?? ""}
                  placeholder="мин"
                  title={s.estimate_min ? formatMinutes(s.estimate_min) : "Оценка, минут"}
                  onChange={(e) => update(i, { estimate_min: e.target.value ? Number(e.target.value.replace(/\D/g, "")) || null : null })}
                />
              </li>
            ))}
          </ul>
        )}

        <footer className="dialog-foot">
          {(steps || error) && (
            <button className="btn ghost" onClick={load} disabled={saving}>
              Предложить заново
            </button>
          )}
          <span className="spacer" />
          <button className="btn ghost" onClick={onClose} disabled={saving}>
            Отмена
          </button>
          <button className="btn primary" onClick={add} disabled={!chosen.length || saving}>
            Добавить {chosen.length || ""} {chosen.length === 1 ? "подзадачу" : "подзадачи"}
          </button>
        </footer>
      </div>
    </div>
  );
}
