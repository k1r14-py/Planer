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
  project_id: number | null;
  deadline: string | null;
  tags: string[];
}

export interface FoundTask extends Task {
  parent_title: string | null;
}

export interface Project {
  id: number;
  name: string;
  color: string;
  archived: boolean;
  task_count?: number;
  open_count?: number;
}

export interface TagCount {
  tag: string;
  count: number;
}

export interface SearchResult {
  tasks: FoundTask[];
  summary: { total: number; done: number; open: number; estimate_min: number; actual_sec: number };
}

export interface SearchQuery {
  start?: string;
  end?: string;
  project_id?: number;
  no_project?: boolean;
  tag?: string;
  status?: Status | "open";
  q?: string;
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
  deadline: string | null;
  project: string | null;
  tags: string[];
  children: DraftItem[];
}

export interface UpdateInfo {
  current: string;
  latest: string;
  available: boolean;
  notes: string;
  published_at: string | null;
  url: string | null;
  can_apply: boolean;
  reason: string;
}

export interface UpdateStatus {
  state: "idle" | "downloading" | "installing" | "restarting" | "error";
  message: string;
  version: string | null;
  current: string;
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
  deadlines: (day: string, days = 7) => request<Task[]>("GET", `/api/deadlines?day=${day}&days=${days}`),
  search: (q: SearchQuery) => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== "" && v !== false) params.set(k, String(v));
    return request<SearchResult>("GET", `/api/tasks/search?${params}`);
  },
  projects: () => request<Project[]>("GET", "/api/projects"),
  createProject: (name: string, color?: string) => request<Project>("POST", "/api/projects", { name, color }),
  patchProject: (id: number, patch: Partial<Pick<Project, "name" | "color" | "archived">>) =>
    request<Project>("PATCH", `/api/projects/${id}`, patch),
  deleteProject: (id: number) => request<{ ok: boolean }>("DELETE", `/api/projects/${id}`),
  tags: () => request<TagCount[]>("GET", "/api/tags"),
  history: (start: string, end: string) =>
    request<HistoryRow[]>("GET", `/api/history?start=${start}&end=${end}`),

  addTask: (day: string, title: string, parent_id: number | null, estimate_min: number | null) =>
    request<Task>("POST", "/api/tasks", { day, title, parent_id, estimate_min }),
  quickAdd: (day: string, text: string, parent_id: number | null = null) =>
    request<Day>("POST", "/api/tasks/quick", { day, text, parent_id }),
  addBulk: (day: string, items: DraftItem[]) => request<Day>("POST", "/api/tasks/bulk", { day, items }),
  patchTask: (
    id: number,
    patch: Partial<
      Pick<
        Task,
        | "title" | "notes" | "status" | "estimate_min" | "actual_sec" | "position" | "planned"
        | "project_id" | "deadline" | "tags" | "day"
      >
    >,
  ) =>
    request<Day>("PATCH", `/api/tasks/${id}`, patch),
  deleteTask: (id: number) => request<Day>("DELETE", `/api/tasks/${id}`),
  timerStart: (id: number) => request<Day>("POST", `/api/tasks/${id}/timer/start`),
  timerStop: (id: number) => request<Day>("POST", `/api/tasks/${id}/timer/stop`),

  health: () => request<{ ok: boolean; version: string }>("GET", "/api/health"),
  updateCheck: () => request<UpdateInfo>("GET", "/api/update/check"),
  updateApply: () => request<UpdateStatus>("POST", "/api/update/apply"),
  updateStatus: () => request<UpdateStatus>("GET", "/api/update/status"),

  voiceStatus: () => request<VoiceStatus>("GET", "/api/voice/status"),
  transcribe: (blob: Blob) => {
    const fd = new FormData();
    const ext = blob.type.includes("ogg") ? "ogg" : blob.type.includes("mp4") ? "m4a" : "webm";
    fd.append("audio", blob, `rec.${ext}`);
    return request<{ text: string; items: DraftItem[]; duration: number; peak: number }>(
      "POST",
      "/api/voice/transcribe",
      fd,
    );
  },
  parse: (text: string, day?: string) => request<{ items: DraftItem[] }>("POST", "/api/voice/parse", { text, day }),
};
