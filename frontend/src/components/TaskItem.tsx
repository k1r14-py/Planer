import { useEffect, useRef, useState } from "react";
import type { Day, Task } from "../api";
import { api } from "../api";
import { formatClock, formatMinutes, liveSeconds, parseQuickAdd } from "../utils";
import { Icon } from "./Icon";

export interface TaskCtx {
  children: Map<number | null, Task[]>;
  now: number;
  run: (p: Promise<Day | unknown>) => void;
}

// id перетаскиваемой задачи (HTML5 DnD не даёт прочитать данные в dragover)
let dragging: Task | null = null;

export function TaskList({ parent, ctx, depth = 0 }: { parent: number | null; ctx: TaskCtx; depth?: number }) {
  const items = ctx.children.get(parent) ?? [];
  if (!items.length) return null;
  return (
    <ul className={depth ? "task-list nested" : "task-list"}>
      {items.map((t) => (
        <TaskItem key={t.id} task={t} siblings={items} ctx={ctx} depth={depth} />
      ))}
    </ul>
  );
}

function TaskItem({ task, siblings, ctx, depth }: { task: Task; siblings: Task[]; ctx: TaskCtx; depth: number }) {
  const kids = ctx.children.get(task.id) ?? [];
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(task.title);
  const [collapsed, setCollapsed] = useState(false);
  const [adding, setAdding] = useState(false);
  const [menu, setMenu] = useState(false);
  const [estimating, setEstimating] = useState(false);
  const [dropHint, setDropHint] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => setTitle(task.title), [task.title]);
  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenu(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [menu]);

  const done = task.status === "done";
  const inactive = task.status === "skipped" || task.status === "moved";
  const running = !!task.timer_started_at;
  const spent = liveSeconds(task, ctx.now);
  const kidsDone = kids.filter((k) => k.status === "done").length;

  const saveTitle = () => {
    setEditing(false);
    const t = title.trim();
    if (t && t !== task.title) ctx.run(api.patchTask(task.id, { title: t }));
    else setTitle(task.title);
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDropHint(false);
    const src = dragging;
    dragging = null;
    if (!src || src.id === task.id || src.parent_id !== task.parent_id) return;
    const others = siblings.filter((s) => s.id !== src.id);
    const idx = others.findIndex((s) => s.id === task.id);
    const prev = others[idx - 1];
    const position = prev ? (prev.position + task.position) / 2 : task.position - 1;
    ctx.run(api.patchTask(src.id, { position }));
  };

  return (
    <li className={`task ${task.status} ${dropHint ? "drop-hint" : ""}`}>
      <div
        className="task-row"
        draggable={!editing}
        onDragStart={(e) => {
          e.stopPropagation();
          dragging = task;
          e.dataTransfer.effectAllowed = "move";
        }}
        onDragEnd={() => (dragging = null)}
        onDragOver={(e) => {
          if (dragging && dragging.parent_id === task.parent_id && dragging.id !== task.id) {
            e.preventDefault();
            setDropHint(true);
          }
        }}
        onDragLeave={() => setDropHint(false)}
        onDrop={onDrop}
      >
        <span className="grip" aria-hidden>
          <Icon name="grip" />
        </span>
        {kids.length > 0 ? (
          <button className="icon-btn caret" onClick={() => setCollapsed(!collapsed)} aria-label="Свернуть">
            <Icon name={collapsed ? "chevron-right" : "chevron-down"} />
          </button>
        ) : (
          <span className="caret-spacer" />
        )}
        <button
          className={`check ${done ? "checked" : ""}`}
          disabled={inactive}
          onClick={() => ctx.run(api.patchTask(task.id, { status: done ? "todo" : "done" }))}
          aria-label={done ? "Снять отметку" : "Выполнено"}
        >
          {done && <Icon name="check" />}
        </button>

        <div className="task-main">
          {editing ? (
            <input
              className="title-input"
              autoFocus
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onBlur={saveTitle}
              onKeyDown={(e) => {
                if (e.key === "Enter") saveTitle();
                if (e.key === "Escape") {
                  setTitle(task.title);
                  setEditing(false);
                }
              }}
            />
          ) : (
            <span className="title" onDoubleClick={() => setEditing(true)} title="Двойной клик — редактировать">
              {task.title}
            </span>
          )}
          <span className="badges">
            {depth === 0 && !task.planned && <span className="badge accent">вне плана</span>}
            {task.moved_from && <span className="badge">перенесено</span>}
            {task.status === "moved" && <span className="badge">→ перенесено</span>}
            {task.status === "skipped" && <span className="badge warn">пропущено</span>}
            {kids.length > 0 && (
              <span className="badge subtle">
                {kidsDone}/{kids.length}
              </span>
            )}
          </span>
        </div>

        {estimating ? (
          <EstimateInput
            initial={task.estimate_min}
            onDone={(v) => {
              setEstimating(false);
              if (v !== undefined) ctx.run(api.patchTask(task.id, { estimate_min: v }));
            }}
          />
        ) : (
          task.estimate_min != null && (
            <button className="chip" onClick={() => setEstimating(true)} title="Оценка">
              <Icon name="hourglass" /> {formatMinutes(task.estimate_min)}
            </button>
          )
        )}

        {(spent > 0 || running) && (
          <span className={`chip mono ${running ? "live" : ""}`} title="Затрачено">
            {formatClock(spent)}
          </span>
        )}

        {!done && !inactive && (
          <button
            className={`icon-btn timer ${running ? "on" : ""}`}
            onClick={() => ctx.run(running ? api.timerStop(task.id) : api.timerStart(task.id))}
            aria-label={running ? "Остановить таймер" : "Запустить таймер"}
            title={running ? "Стоп" : "Засечь время"}
          >
            <Icon name={running ? "pause" : "play"} />
          </button>
        )}

        <div className="menu-wrap" ref={menuRef}>
          <button className="icon-btn" onClick={() => setMenu(!menu)} aria-label="Действия">
            <Icon name="more" />
          </button>
          {menu && (
            <div className="menu" onClick={() => setMenu(false)}>
              <button onClick={() => { setAdding(true); setCollapsed(false); }}>
                <Icon name="plus" /> Подзадача
              </button>
              <button onClick={() => setEditing(true)}>
                <Icon name="edit" /> Переименовать
              </button>
              <button onClick={() => setEstimating(true)}>
                <Icon name="hourglass" /> Оценка времени
              </button>
              {task.status === "todo" && (
                <button onClick={() => ctx.run(api.patchTask(task.id, { status: "skipped" }))}>
                  <Icon name="skip" /> Пропустить
                </button>
              )}
              {inactive && (
                <button onClick={() => ctx.run(api.patchTask(task.id, { status: "todo" }))}>
                  <Icon name="undo" /> Вернуть в работу
                </button>
              )}
              {depth === 0 && (
                <button onClick={() => ctx.run(api.patchTask(task.id, { planned: !task.planned }))}>
                  <Icon name="flag" /> {task.planned ? "Отметить как внеплановую" : "Считать плановой"}
                </button>
              )}
              <button
                className="danger"
                onClick={() => {
                  if (!kids.length || confirm(`Удалить «${task.title}» вместе с подзадачами?`))
                    ctx.run(api.deleteTask(task.id));
                }}
              >
                <Icon name="trash" /> Удалить
              </button>
            </div>
          )}
        </div>
      </div>

      {!collapsed && <TaskList parent={task.id} ctx={ctx} depth={depth + 1} />}
      {adding && (
        <SubtaskInput
          onSubmit={(text) => {
            const { title, estimate } = parseQuickAdd(text);
            if (title) ctx.run(api.addTask(task.day, title, task.id, estimate));
          }}
          onClose={() => setAdding(false)}
        />
      )}
    </li>
  );
}

function SubtaskInput({ onSubmit, onClose }: { onSubmit: (t: string) => void; onClose: () => void }) {
  const [value, setValue] = useState("");
  return (
    <div className="subtask-input">
      <Icon name="corner" />
      <input
        autoFocus
        placeholder="Подзадача… (Enter — добавить, Esc — закрыть)"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => !value && onClose()}
        onKeyDown={(e) => {
          if (e.key === "Enter" && value.trim()) {
            onSubmit(value);
            setValue("");
          }
          if (e.key === "Escape") onClose();
        }}
      />
    </div>
  );
}

function EstimateInput({ initial, onDone }: { initial: number | null; onDone: (v: number | null | undefined) => void }) {
  const [value, setValue] = useState(initial?.toString() ?? "");
  const commit = () => {
    const n = parseInt(value, 10);
    onDone(value.trim() === "" ? null : Number.isFinite(n) ? n : undefined);
  };
  return (
    <input
      className="estimate-input"
      autoFocus
      inputMode="numeric"
      placeholder="мин"
      value={value}
      onChange={(e) => setValue(e.target.value.replace(/\D/g, ""))}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
        if (e.key === "Escape") onDone(undefined);
      }}
    />
  );
}
