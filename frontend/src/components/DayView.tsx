import { useEffect, useState } from "react";
import type { Day, Task } from "../api";
import { api } from "../api";
import { ProjectChip, useProjects } from "../projects";
import { childrenMap, deadlineInfo, shortDate } from "../utils";
import { Icon } from "./Icon";
import { SummaryCard } from "./SummaryCard";
import { TaskList, type TaskCtx } from "./TaskItem";

export function DayView({
  data,
  now,
  run,
  onDictate,
  onCarryOver,
  onOpenDay,
}: {
  data: Day;
  now: number;
  run: TaskCtx["run"];
  onDictate: (record: boolean) => void;
  onCarryOver: () => void;
  onOpenDay: (day: string) => void;
}) {
  const [value, setValue] = useState("");
  const ctx: TaskCtx = {
    children: childrenMap(data.tasks),
    now,
    day: data.day,
    run,
  };
  const locked = !!data.plan_locked_at;
  const open = data.summary.open;

  const submit = () => {
    if (!value.trim()) return;
    run(api.quickAdd(data.day, value));
    setValue("");
  };

  return (
    <div className="day-view">
      <SummaryCard data={data} now={now} />

      <DeadlinesPanel data={data} run={run} onOpenDay={onOpenDay} />

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

      <div className="composer-wrap">
        <div className="composer">
          <Icon name="plus" />
          <input
            id="quick-add"
            value={value}
            placeholder={locked ? "Добавить внеплановую задачу…" : "Добавить задачу…"}
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
        <div className="composer-hint muted small">
          Можно сразу указать: <code>1.5ч</code> · <code>до пятницы</code> · <code>@Проект</code> ·{" "}
          <code>#тег</code>
        </div>
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

/** Открытые задачи из других дней, у которых срок в ближайшую неделю или уже прошёл. */
function DeadlinesPanel({
  data,
  run,
  onOpenDay,
}: {
  data: Day;
  run: TaskCtx["run"];
  onOpenDay: (day: string) => void;
}) {
  const { byId } = useProjects();
  const [items, setItems] = useState<Task[]>([]);

  useEffect(() => {
    api.deadlines(data.day, 7).then(
      (list) => setItems(list.filter((t) => t.day !== data.day)),
      () => setItems([]),
    );
  }, [data]);

  if (!items.length) return null;

  return (
    <section className="card deadlines">
      <h3>
        <Icon name="flag" /> Сроки
        <span className="muted small">в других днях · ближайшие 7 дней и просроченные</span>
      </h3>
      <ul>
        {items.map((t) => {
          const info = deadlineInfo(t.deadline!, data.day);
          const project = t.project_id != null ? byId.get(t.project_id) : undefined;
          return (
            <li key={t.id}>
              <span className={`deadline ${info.tone}`}>
                <Icon name="flag" /> {info.label}
              </span>
              <span className="dl-title">{t.title}</span>
              {project && <ProjectChip project={project} />}
              <span className="dl-actions">
                <button className="btn ghost sm" onClick={() => onOpenDay(t.day)} title="Открыть день, где задача запланирована">
                  {shortDate(t.day)}
                </button>
                {t.parent_id === null && (
                  <button className="btn sm" onClick={() => run(api.patchTask(t.id, { day: data.day }))}>
                    Взять на этот день
                  </button>
                )}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
