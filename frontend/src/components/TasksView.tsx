import { useEffect, useMemo, useState } from "react";
import type { FoundTask, SearchQuery, SearchResult, Status, TagCount } from "../api";
import { api } from "../api";
import { matchLinks, useLinks } from "../links";
import { ProjectChip, useProjects } from "../projects";
import { deadlineInfo, formatDayTitle, formatMinutes, isoDay, percent, shiftDay } from "../utils";
import { Icon } from "./Icon";
import { TaskLinks } from "./TaskLinks";

type Period = "week" | "month" | "prev-month" | "30" | "all" | "custom";
type StatusFilter = "" | "open" | Status;

const FILTERS_KEY = "planer-task-filters";

interface Filters {
  period: Period;
  start: string;
  end: string;
  project: string; // "" — все, "none" — без проекта, иначе id
  tag: string;
  status: StatusFilter;
  q: string;
}

function periodRange(f: Filters, today: string): { start?: string; end?: string } {
  const d = new Date(`${today}T12:00:00`);
  switch (f.period) {
    case "week": {
      const monday = shiftDay(today, -((d.getDay() + 6) % 7));
      return { start: monday, end: shiftDay(monday, 6) };
    }
    case "month":
      return {
        start: isoDay(new Date(d.getFullYear(), d.getMonth(), 1)),
        end: isoDay(new Date(d.getFullYear(), d.getMonth() + 1, 0)),
      };
    case "prev-month":
      return {
        start: isoDay(new Date(d.getFullYear(), d.getMonth() - 1, 1)),
        end: isoDay(new Date(d.getFullYear(), d.getMonth(), 0)),
      };
    case "30":
      return { start: shiftDay(today, -29), end: today };
    case "custom":
      return { start: f.start || undefined, end: f.end || undefined };
    default:
      return {};
  }
}

function loadFilters(today: string): Filters {
  const base: Filters = { period: "month", start: shiftDay(today, -29), end: today, project: "", tag: "", status: "", q: "" };
  try {
    return { ...base, ...JSON.parse(localStorage.getItem(FILTERS_KEY) || "{}") };
  } catch {
    return base;
  }
}

const STATUS_LABEL: Record<Status, string> = { todo: "открыта", done: "сделано", skipped: "пропущено", moved: "перенесено" };

export function TasksView({ today, onOpenDay }: { today: string; onOpenDay: (day: string) => void }) {
  const { projects, byId } = useProjects();
  const [f, setF] = useState<Filters>(() => loadFilters(today));
  const [tags, setTags] = useState<TagCount[]>([]);
  const [result, setResult] = useState<SearchResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const set = (patch: Partial<Filters>) => setF((prev) => ({ ...prev, ...patch }));

  useEffect(() => {
    api.tags().then(setTags, () => {});
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(FILTERS_KEY, JSON.stringify(f));
    } catch {
      /* ignore */
    }
    const query: SearchQuery = {
      ...periodRange(f, today),
      tag: f.tag || undefined,
      status: f.status || undefined,
      q: f.q.trim() || undefined,
    };
    if (f.project === "none") query.no_project = true;
    else if (f.project) query.project_id = Number(f.project);
    const h = setTimeout(() => {
      api.search(query).then(
        (r) => {
          setResult(r);
          setError(null);
        },
        (e) => setError(e.message),
      );
    }, 200);
    return () => clearTimeout(h);
  }, [f, today]);

  // группировка: день → задачи верхнего уровня выборки (подзадачи — под своими родителями)
  const groups = useMemo(() => {
    if (!result) return [];
    const ids = new Set(result.tasks.map((t) => t.id));
    const kids = new Map<number, FoundTask[]>();
    for (const t of result.tasks)
      if (t.parent_id !== null && ids.has(t.parent_id)) kids.set(t.parent_id, [...(kids.get(t.parent_id) ?? []), t]);
    const byDay = new Map<string, { task: FoundTask; kids: FoundTask[] }[]>();
    for (const t of result.tasks) {
      if (t.parent_id !== null && ids.has(t.parent_id)) continue;
      byDay.set(t.day, [...(byDay.get(t.day) ?? []), { task: t, kids: kids.get(t.id) ?? [] }]);
    }
    return [...byDay.entries()];
  }, [result]);

  const s = result?.summary;

  return (
    <div className="tasks-view">
      <section className="card filters">
        <div className="search-box">
          <Icon name="search" />
          <input placeholder="Поиск по названию…" value={f.q} onChange={(e) => set({ q: e.target.value })} />
        </div>
        <div className="filter-row">
          <select value={f.period} onChange={(e) => set({ period: e.target.value as Period })}>
            <option value="week">Эта неделя</option>
            <option value="month">Этот месяц</option>
            <option value="prev-month">Прошлый месяц</option>
            <option value="30">Последние 30 дней</option>
            <option value="all">Всё время</option>
            <option value="custom">Свой период…</option>
          </select>
          {f.period === "custom" && (
            <span className="range">
              <input type="date" value={f.start} onChange={(e) => set({ start: e.target.value })} />—
              <input type="date" value={f.end} onChange={(e) => set({ end: e.target.value })} />
            </span>
          )}
          <select value={f.project} onChange={(e) => set({ project: e.target.value })}>
            <option value="">Все проекты</option>
            <option value="none">Без проекта</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <select value={f.tag} onChange={(e) => set({ tag: e.target.value })}>
            <option value="">Все теги</option>
            {tags.map((t) => (
              <option key={t.tag} value={t.tag}>
                #{t.tag} ({t.count})
              </option>
            ))}
          </select>
          <select value={f.status} onChange={(e) => set({ status: e.target.value as StatusFilter })}>
            <option value="">Любой статус</option>
            <option value="open">Открытые</option>
            <option value="done">Сделанные</option>
            <option value="skipped">Пропущенные</option>
            <option value="moved">Перенесённые</option>
          </select>
        </div>
      </section>

      {error && <div className="error">{error}</div>}

      {s && (
        <section className="card summary-row">
          <div className="stat">
            <span className="stat-value">{s.total}</span>
            <span className="stat-label">задач</span>
          </div>
          <div className="stat">
            <span className="stat-value">
              {s.done} <span className="muted small">({percent(s.done, s.total)}%)</span>
            </span>
            <span className="stat-label">сделано</span>
          </div>
          <div className="stat">
            <span className="stat-value">{s.open}</span>
            <span className="stat-label">открыто</span>
          </div>
          <div className="stat">
            <span className="stat-value">{formatMinutes(s.estimate_min)}</span>
            <span className="stat-label">оценка</span>
          </div>
          <div className="stat">
            <span className="stat-value">{formatMinutes(s.actual_sec / 60)}</span>
            <span className="stat-label">затрачено</span>
          </div>
        </section>
      )}

      {result && !groups.length && <p className="muted center">Ничего не найдено — попробуйте изменить фильтры.</p>}

      {groups.map(([day, items]) => (
        <section key={day} className="found-day">
          <button className="found-day-title" onClick={() => onOpenDay(day)} title="Открыть день">
            {formatDayTitle(day)} <Icon name="chevron-right" />
          </button>
          <ul className="found-list">
            {items.map(({ task, kids }) => (
              <FoundRow key={task.id} task={task} kids={kids} today={today} byId={byId} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function FoundRow({
  task,
  kids,
  today,
  byId,
  nested = false,
}: {
  task: FoundTask;
  kids: FoundTask[];
  today: string;
  byId: ReturnType<typeof useProjects>["byId"];
  nested?: boolean;
}) {
  const project = task.project_id != null ? byId.get(task.project_id) : undefined;
  const { rules } = useLinks();
  const links = matchLinks(rules, `${task.title} ${project?.name ?? ""} ${task.tags.join(" ")}`);
  const kidProject = (k: FoundTask) => (k.project_id === task.project_id ? { ...k, project_id: null } : k);
  return (
    <li>
      <div className={`found-row ${task.status}`}>
        <span className={`dot ${task.status}`} />
        <span className="found-title">
          {task.parent_title && !nested && <span className="muted small">{task.parent_title} → </span>}
          {task.title} <TaskLinks matched={links} />
        </span>
        <span className="found-meta">
          {project && <ProjectChip project={project} />}
          {task.tags.map((t) => (
            <span key={t} className="tag">
              #{t}
            </span>
          ))}
          {task.deadline && task.status === "todo" && (
            <span className={`deadline ${deadlineInfo(task.deadline, today).tone}`}>
              {deadlineInfo(task.deadline, today).label}
            </span>
          )}
          {task.estimate_min != null && <span className="muted">{formatMinutes(task.estimate_min)}</span>}
          <span className={`status-tag ${task.status}`}>{STATUS_LABEL[task.status]}</span>
        </span>
      </div>
      {kids.length > 0 && (
        <ul className="found-list nested">
          {kids.map((k) => (
            <FoundRow key={k.id} task={kidProject(k)} kids={[]} today={today} byId={byId} nested />
          ))}
        </ul>
      )}
    </li>
  );
}
