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
  if (min <= 0) return "0 мин";
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
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

/** «Написать отчёт 30м» / «… 1.5ч» → заголовок + оценка в минутах. */
export function parseQuickAdd(input: string): { title: string; estimate: number | null } {
  const m = input.match(/\s+~?(\d+(?:[.,]\d+)?)\s*(m|м|мин|h|ч|час)\.?$/i);
  if (!m) return { title: input.trim(), estimate: null };
  const value = parseFloat(m[1].replace(",", "."));
  const hours = /^(h|ч|час)$/i.test(m[2]);
  return {
    title: input.slice(0, m.index).trim(),
    estimate: Math.round(hours ? value * 60 : value),
  };
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
