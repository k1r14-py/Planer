import { useRef, useState } from "react";
import type { Day } from "../api";
import { api } from "../api";
import { childrenMap, parseQuickAdd } from "../utils";
import { Icon } from "./Icon";
import { SummaryCard } from "./SummaryCard";
import { TaskList, type TaskCtx } from "./TaskItem";

export function DayView({
  data,
  now,
  run,
  onDictate,
  onCarryOver,
}: {
  data: Day;
  now: number;
  run: TaskCtx["run"];
  onDictate: (record: boolean) => void;
  onCarryOver: () => void;
}) {
  const [value, setValue] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const ctx: TaskCtx = {
    children: childrenMap(data.tasks),
    now,
    run,
  };
  const locked = !!data.plan_locked_at;
  const open = data.summary.open;

  const submit = () => {
    const { title, estimate } = parseQuickAdd(value);
    if (!title) return;
    run(api.addTask(data.day, title, null, estimate));
    setValue("");
  };

  return (
    <div className="day-view">
      <SummaryCard data={data} now={now} />

      <div className="plan-state">
        {locked ? (
          <>
            <span className="state-pill locked">
              <Icon name="lock" /> План зафиксирован в{" "}
              {new Date(data.plan_locked_at!).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}
            </span>
            <span className="muted small">новые задачи пойдут как «вне плана»</span>
            <button className="btn ghost sm" onClick={() => run(api.unlock(data.day))}>
              Разблокировать
            </button>
          </>
        ) : (
          <>
            <span className="state-pill">
              <Icon name="edit" /> Составление плана
            </span>
            <span className="muted small">когда план готов — зафиксируйте, чтобы сравнивать план и факт</span>
            <button className="btn sm" onClick={() => run(api.lock(data.day))} disabled={!data.tasks.length}>
              <Icon name="lock" /> Зафиксировать план
            </button>
          </>
        )}
      </div>

      <div className="composer">
        <Icon name="plus" />
        <input
          ref={input}
          id="quick-add"
          value={value}
          placeholder={locked ? "Добавить внеплановую задачу…  (например «Созвон 30м»)" : "Добавить задачу…  (например «Отчёт 1.5ч»)"}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
        />
        <button className="icon-btn" title="Вставить список текстом" onClick={() => onDictate(false)}>
          <Icon name="text" />
        </button>
        <button className="mic-btn" title="Надиктовать (V)" onClick={() => onDictate(true)}>
          <Icon name="mic" />
        </button>
      </div>

      {data.tasks.length ? (
        <TaskList parent={null} ctx={ctx} />
      ) : (
        <div className="empty">
          <div className="empty-icon">
            <Icon name="list" size={28} />
          </div>
          <strong>На этот день задач нет</strong>
          <span className="muted">Впишите задачу выше или нажмите на микрофон и надиктуйте план.</span>
        </div>
      )}

      {open > 0 && (
        <div className="day-foot">
          <button className="btn ghost sm" onClick={onCarryOver}>
            <Icon name="forward" /> Перенести незавершённые ({open}) на завтра
          </button>
        </div>
      )}
    </div>
  );
}
