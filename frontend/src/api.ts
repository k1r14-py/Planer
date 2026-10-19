export type Status = "todo" | "done" | "skipped" | "moved";

export interface Task {
  id: number;
  day: string;
  parent_id: number | null;
  title: string;
  notes: string;
  position: number;
  status: Status;
  planned: boolean;
  estimate_min: number | null;
  actual_sec: number;
  timer_started_at: string | null;
  moved_from: string | null;
  created_at: string;
  done_at: string | null;
}

export interface Summary {
  planned_total: number;
  planned_done: number;
  unplanned_total: number;
  unplanned_done: number;
  skipped: number;
  moved: number;
  open: number;
  estimate_planned_min: number;
  estimate_done_min: number;
  actual_sec: number;
}

export interface Day {
  day: string;
  plan_locked_at: string | null;
  note: string;
  tasks: Task[];
  summary: Summary;
}

export interface HistoryRow extends Summary {
  day: string;
}

export interface DraftItem {
  title: string;
  estimate_min: number | null;
  children: DraftItem[];
}

export interface VoiceStatus {
  available: boolean;
  model: string;
  language: string;
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method };
  if (body instanceof FormData) {
    init.body = body;
  } else if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { "Content-Type": "application/json" };
  }
  const res = await fetch(url, init);
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const data = await res.json();
      detail = typeof data.detail === "string" ? data.detail : JSON.stringify(data.detail);
    } catch {
      /* тело не JSON */
    }
    throw new Error(detail);
  }
  return res.json();
}

export const api = {
  day: (day: string) => request<Day>("GET", `/api/days/${day}`),
  setNote: (day: string, note: string) => request<Day>("PATCH", `/api/days/${day}`, { note }),
  lock: (day: string) => request<Day>("POST", `/api/days/${day}/lock`),
  unlock: (day: string) => request<Day>("POST", `/api/days/${day}/unlock`),
  carryOver: (day: string, to: string) =>
    request<{ moved: number; day: Day }>("POST", `/api/days/${day}/carry-over`, { to }),
  history: (start: string, end: string) =>
    request<HistoryRow[]>("GET", `/api/history?start=${start}&end=${end}`),

  addTask: (day: string, title: string, parent_id: number | null, estimate_min: number | null) =>
    request<Task>("POST", "/api/tasks", { day, title, parent_id, estimate_min }),
  addBulk: (day: string, items: DraftItem[]) => request<Day>("POST", "/api/tasks/bulk", { day, items }),
  patchTask: (id: number, patch: Partial<Pick<Task, "title" | "notes" | "status" | "estimate_min" | "actual_sec" | "position" | "planned">>) =>
    request<Day>("PATCH", `/api/tasks/${id}`, patch),
  deleteTask: (id: number) => request<Day>("DELETE", `/api/tasks/${id}`),
  timerStart: (id: number) => request<Day>("POST", `/api/tasks/${id}/timer/start`),
  timerStop: (id: number) => request<Day>("POST", `/api/tasks/${id}/timer/stop`),

  voiceStatus: () => request<VoiceStatus>("GET", "/api/voice/status"),
  transcribe: (blob: Blob) => {
    const fd = new FormData();
    const ext = blob.type.includes("ogg") ? "ogg" : blob.type.includes("mp4") ? "m4a" : "webm";
    fd.append("audio", blob, `rec.${ext}`);
    return request<{ text: string; items: DraftItem[] }>("POST", "/api/voice/transcribe", fd);
  },
  parse: (text: string) => request<{ items: DraftItem[] }>("POST", "/api/voice/parse", { text }),
};
