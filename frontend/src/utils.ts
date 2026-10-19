import type { Task } from "./api";

export function isoDay(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function shiftDay(day: string, delta: number): string {
  const d = new Date(`${day}T12:00:00`);
  d.setDate(d.getDate() + delta);
  return isoDay(d);
}

export function formatDayTitle(day: string): string {
  const d = new Date(`${day}T12:00:00`);
  const s = d.toLocaleDateString("ru-RU", { weekday: "long", day: "numeric", month: "long" });
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function relativeLabel(day: string, today: string): string | null {
  const diff = Math.round(
    (new Date(`${day}T12:00:00`).getTime() - new Date(`${today}T12:00:00`).getTime()) / 86400000,
  );
  return { [-1]: "Вчера", 0: "Сегодня", 1: "Завтра" }[diff] ?? null;
}

export function formatMinutes(min: number): string {
  const total = Math.round(min); // сначала округляем, иначе выйдет «10 ч 60 мин»
  if (total <= 0) return "0 мин";
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (!h) return `${m} мин`;
  return m ? `${h} ч ${m} мин` : `${h} ч`;
}

export function formatClock(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(r).padStart(2, "0");
  return h ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}

/** Затраченное время с учётом идущего таймера. */
export function liveSeconds(t: Task, now: number): number {
  if (!t.timer_started_at) return t.actual_sec;
  return t.actual_sec + Math.max(0, (now - new Date(t.timer_started_at).getTime()) / 1000);
}

export function childrenMap(tasks: Task[]): Map<number | null, Task[]> {
  const map = new Map<number | null, Task[]>();
  for (const t of tasks) {
    const list = map.get(t.parent_id) ?? [];
    list.push(t);
    map.set(t.parent_id, list);
  }
  return map;
}

export function percent(part: number, total: number): number {
  return total ? Math.round((part / total) * 100) : 0;
}

const SHORT_DAYS = ["вс", "пн", "вт", "ср", "чт", "пт", "сб"];

export function daysBetween(from: string, to: string): number {
  return Math.round((new Date(`${to}T12:00:00`).getTime() - new Date(`${from}T12:00:00`).getTime()) / 86400000);
}

export function shortDate(day: string): string {
  const d = new Date(`${day}T12:00:00`);
  return `${SHORT_DAYS[d.getDay()]}, ${d.toLocaleDateString("ru-RU", { day: "numeric", month: "short" })}`;
}

/** Подпись и «тон» срока относительно дня, на который смотрим. */
export function deadlineInfo(deadline: string, today: string): { label: string; tone: "overdue" | "soon" | "normal" } {
  const diff = daysBetween(today, deadline);
  if (diff < 0) return { label: `просрочено · ${shortDate(deadline)}`, tone: "overdue" };
  if (diff === 0) return { label: "срок сегодня", tone: "soon" };
  if (diff === 1) return { label: "срок завтра", tone: "soon" };
  return { label: `до ${shortDate(deadline)}`, tone: diff <= 3 ? "soon" : "normal" };
}
