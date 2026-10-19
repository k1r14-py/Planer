"""HTTP API планера + раздача собранного фронтенда."""

import logging
import sqlite3
from contextlib import asynccontextmanager
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Literal

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from starlette.concurrency import run_in_threadpool

from . import speech, stats, updater
from .ai import client as ai_client
from .ai import features as ai_features
from .ai import ollama as ai_ollama
from .db import PROJECT_COLORS, init_db, tx
from .dictation import parse_dictation, parse_line
from .version import current_version

# дочерний логгер uvicorn — сообщения попадают в тот же лог (Planer.log)
log = logging.getLogger("uvicorn.error.planer")

Status = Literal["todo", "done", "skipped", "moved"]

@asynccontextmanager
async def lifespan(_app: FastAPI):
    init_db()
    yield


app = FastAPI(title="Planer", lifespan=lifespan)

# Версия запущенного кода. Читаем один раз: после установки обновления файл VERSION
# уже новый, а процесс — ещё старый, пока не перезапустится.
RUNNING_VERSION = current_version()


def now_iso() -> str:
    return datetime.now().isoformat(timespec="seconds")


def check_day(day: str) -> str:
    try:
        date.fromisoformat(day)
    except ValueError:
        raise HTTPException(400, "day должен быть в формате YYYY-MM-DD")
    return day


# ---------- модели ----------


class TaskIn(BaseModel):
    day: str
    title: str = Field(min_length=1)
    parent_id: int | None = None
    estimate_min: int | None = Field(default=None, ge=0)
    notes: str = ""
    project_id: int | None = None
    deadline: str | None = None
    tags: list[str] = []


class QuickIn(BaseModel):
    """Строка из поля ввода: «Отчёт 1.5ч до пятницы @Работа #срочно»."""
    day: str
    text: str = Field(min_length=1)
    parent_id: int | None = None


class TaskPatch(BaseModel):
    title: str | None = Field(default=None, min_length=1)
    notes: str | None = None
    status: Status | None = None
    estimate_min: int | None = Field(default=None, ge=0)
    actual_sec: int | None = Field(default=None, ge=0)
    position: float | None = None
    planned: bool | None = None
    project_id: int | None = None
    deadline: str | None = None
    tags: list[str] | None = None
    day: str | None = None  # перенести задачу (с подзадачами) на другой день


class TreeItem(BaseModel):
    title: str = Field(min_length=1)
    estimate_min: int | None = Field(default=None, ge=0)
    deadline: str | None = None
    project: str | None = None
    tags: list[str] = []
    children: list["TreeItem"] = []


class ProjectIn(BaseModel):
    name: str = Field(min_length=1, max_length=60)
    color: str = "#6d5efc"


class ProjectPatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=60)
    color: str | None = None
    archived: bool | None = None


class BulkIn(BaseModel):
    day: str
    items: list[TreeItem]


class DayPatch(BaseModel):
    note: str


class CarryIn(BaseModel):
    to: str


class ParseIn(BaseModel):
    text: str
    day: str | None = None  # от какого дня считать «до пятницы»


# ---------- helpers ----------


def task_row(conn, task_id: int):
    row = conn.execute("SELECT * FROM tasks WHERE id = ?", (task_id,)).fetchone()
    if row is None:
        raise HTTPException(404, "Задача не найдена")
    return row


def task_dict(row) -> dict:
    d = dict(row)
    d["planned"] = bool(d["planned"])
    d.setdefault("tags", [])
    return d


def attach_tags(conn, tasks: list[dict]) -> list[dict]:
    if not tasks:
        return tasks
    by_id = {t["id"]: t for t in tasks}
    for t in tasks:
        t["tags"] = []
    ids = list(by_id)
    for i in range(0, len(ids), 500):
        chunk = ids[i:i + 500]
        for r in conn.execute(
            f"SELECT task_id, tag FROM task_tags WHERE task_id IN ({','.join('?' * len(chunk))}) "
            "ORDER BY tag",
            chunk,
        ):
            by_id[r["task_id"]]["tags"].append(r["tag"])
    return tasks


def normalize_tags(tags: list[str]) -> list[str]:
    out: list[str] = []
    for t in tags:
        t = t.strip().lstrip("#").lower()
        if t and t not in out:
            out.append(t[:40])
    return out


def set_tags(conn, task_id: int, tags: list[str]) -> None:
    conn.execute("DELETE FROM task_tags WHERE task_id = ?", (task_id,))
    conn.executemany(
        "INSERT INTO task_tags(task_id, tag) VALUES (?, ?)",
        [(task_id, t) for t in normalize_tags(tags)],
    )


def project_by_name(conn, name: str) -> int:
    """id проекта по имени (без учёта регистра); создаёт, если такого нет."""
    name = name.strip()
    row = conn.execute("SELECT id FROM projects WHERE name = ? COLLATE NOCASE", (name,)).fetchone()
    if row:
        return row["id"]
    count = conn.execute("SELECT COUNT(*) FROM projects").fetchone()[0]
    color = PROJECT_COLORS[count % len(PROJECT_COLORS)]
    return conn.execute("INSERT INTO projects(name, color) VALUES (?, ?)", (name, color)).lastrowid


def check_deadline(value: str | None) -> str | None:
    if value is None:
        return None
    try:
        return date.fromisoformat(value).isoformat()
    except ValueError:
        raise HTTPException(400, "deadline должен быть в формате YYYY-MM-DD")


def day_info(conn, day: str) -> dict:
    row = conn.execute("SELECT * FROM days WHERE day = ?", (day,)).fetchone()
    return dict(row) if row else {"day": day, "plan_locked_at": None, "note": ""}


def ensure_day(conn, day: str) -> None:
    conn.execute("INSERT OR IGNORE INTO days(day) VALUES (?)", (day,))


def is_locked(conn, day: str) -> bool:
    return bool(day_info(conn, day)["plan_locked_at"])


def next_position(conn, day: str, parent_id: int | None) -> float:
    row = conn.execute(
        "SELECT COALESCE(MAX(position), 0) FROM tasks WHERE day = ? AND parent_id IS ?",
        (day, parent_id),
    ).fetchone()
    return row[0] + 1


def insert_task(
    conn, day, title, parent_id=None, estimate_min=None, notes="", moved_from=None,
    project_id=None, deadline=None, tags=(),
) -> int:
    ensure_day(conn, day)
    if project_id is None and parent_id is not None:
        # подзадача по умолчанию — в проекте родителя
        project_id = task_row(conn, parent_id)["project_id"]
    cur = conn.execute(
        """INSERT INTO tasks(day, parent_id, title, notes, position, planned, estimate_min,
                             moved_from, created_at, project_id, deadline)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            day, parent_id, title.strip(), notes, next_position(conn, day, parent_id),
            0 if is_locked(conn, day) else 1, estimate_min, moved_from, now_iso(),
            project_id, deadline,
        ),
    )
    if tags:
        set_tags(conn, cur.lastrowid, list(tags))
    return cur.lastrowid


def carry_task(conn, task_id: int, from_day: str, to_day: str, parent_id: int | None = None) -> None:
    """Копирует задачу с открытыми подзадачами на другой день; оригинал помечается «перенесено»."""
    src = task_row(conn, task_id)
    tags = [r["tag"] for r in conn.execute("SELECT tag FROM task_tags WHERE task_id = ?", (task_id,))]
    new_id = insert_task(
        conn, to_day, src["title"], parent_id, src["estimate_min"], src["notes"],
        moved_from=from_day, project_id=src["project_id"], deadline=src["deadline"], tags=tags,
    )
    for child in conn.execute(
        "SELECT id FROM tasks WHERE parent_id = ? AND status = 'todo' ORDER BY position, id", (task_id,)
    ).fetchall():
        carry_task(conn, child["id"], from_day, to_day, new_id)
    set_status(conn, task_id, "moved")


def subtree_ids(conn, task_id: int) -> list[int]:
    ids, queue = [], [task_id]
    while queue:
        tid = queue.pop()
        ids.append(tid)
        queue += [r["id"] for r in conn.execute("SELECT id FROM tasks WHERE parent_id = ?", (tid,))]
    return ids


def move_to_day(conn, task_id: int, day: str) -> None:
    """Переносит задачу вместе с подзадачами на другой день (в конец списка)."""
    row = task_row(conn, task_id)
    if row["parent_id"] is not None:
        raise HTTPException(400, "Переносить можно только задачу верхнего уровня")
    if row["day"] == day:
        return
    ensure_day(conn, day)
    ids = subtree_ids(conn, task_id)
    conn.execute(
        f"UPDATE tasks SET day = ?, moved_from = COALESCE(moved_from, ?), planned = ? "
        f"WHERE id IN ({','.join('?' * len(ids))})",
        (day, row["day"], 0 if is_locked(conn, day) else 1, *ids),
    )
    conn.execute(
        "UPDATE tasks SET position = ? WHERE id = ?", (next_position(conn, day, None), task_id)
    )


def stop_timer(conn, row) -> None:
    if not row["timer_started_at"]:
        return
    elapsed = (datetime.now() - datetime.fromisoformat(row["timer_started_at"])).total_seconds()
    conn.execute(
        "UPDATE tasks SET actual_sec = actual_sec + ?, timer_started_at = NULL WHERE id = ?",
        (max(0, int(elapsed)), row["id"]),
    )


def set_status(conn, task_id: int, status: str) -> None:
    row = task_row(conn, task_id)
    if status != "todo":
        stop_timer(conn, row)
    conn.execute(
        "UPDATE tasks SET status = ?, done_at = ? WHERE id = ?",
        (status, now_iso() if status == "done" else None, task_id),
    )


def cascade_status(conn, task_id: int, status: str) -> None:
    """Отметка родителя распространяется на незавершённые подзадачи и наоборот."""
    row = task_row(conn, task_id)
    if status in ("done", "skipped"):
        for child in conn.execute(
            "SELECT id FROM tasks WHERE parent_id = ? AND status = 'todo'", (task_id,)
        ).fetchall():
            set_status(conn, child["id"], status)
            cascade_status(conn, child["id"], status)

    parent_id = row["parent_id"]
    if parent_id is None:
        return
    parent = task_row(conn, parent_id)
    siblings = conn.execute(
        "SELECT status FROM tasks WHERE parent_id = ?", (parent_id,)
    ).fetchall()
    open_count = sum(1 for s in siblings if s["status"] == "todo")
    if status == "todo" and parent["status"] == "done":
        set_status(conn, parent_id, "todo")
        cascade_status(conn, parent_id, "todo")
    elif open_count == 0 and parent["status"] == "todo" and any(
        s["status"] == "done" for s in siblings
    ):
        set_status(conn, parent_id, "done")
        cascade_status(conn, parent_id, "done")


def insert_tree(conn, day: str, items: list[TreeItem], parent_id: int | None = None) -> None:
    for item in items:
        tid = insert_task(
            conn, day, item.title, parent_id, item.estimate_min,
            project_id=project_by_name(conn, item.project) if item.project else None,
            deadline=check_deadline(item.deadline),
            tags=item.tags,
        )
        insert_tree(conn, day, item.children, tid)


def summarize(tasks: list[dict]) -> dict:
    """План/факт по задачам верхнего уровня одного дня."""
    top = [t for t in tasks if t["parent_id"] is None]
    children: dict[int, list[dict]] = {}
    for t in tasks:
        if t["parent_id"] is not None:
            children.setdefault(t["parent_id"], []).append(t)

    def estimate(t: dict) -> int:
        if t["estimate_min"] is not None:
            return t["estimate_min"]
        return sum(estimate(c) for c in children.get(t["id"], []))

    planned = [t for t in top if t["planned"]]
    unplanned = [t for t in top if not t["planned"]]
    return {
        "planned_total": len(planned),
        "planned_done": sum(t["status"] == "done" for t in planned),
        "unplanned_total": len(unplanned),
        "unplanned_done": sum(t["status"] == "done" for t in unplanned),
        "skipped": sum(t["status"] == "skipped" for t in top),
        "moved": sum(t["status"] == "moved" for t in top),
        "open": sum(t["status"] == "todo" for t in top),
        "estimate_planned_min": sum(estimate(t) for t in planned),
        "estimate_done_min": sum(estimate(t) for t in top if t["status"] == "done"),
        "actual_sec": sum(t["actual_sec"] for t in tasks),
    }


def load_day(conn, day: str) -> dict:
    rows = conn.execute(
        "SELECT * FROM tasks WHERE day = ? ORDER BY position, id", (day,)
    ).fetchall()
    tasks = attach_tags(conn, [task_dict(r) for r in rows])
    return {**day_info(conn, day), "tasks": tasks, "summary": summarize(tasks)}


# ---------- дни ----------


@app.get("/api/days/{day}")
def get_day(day: str):
    check_day(day)
    with tx() as conn:
        return load_day(conn, day)


@app.patch("/api/days/{day}")
def patch_day(day: str, body: DayPatch):
    check_day(day)
    with tx() as conn:
        ensure_day(conn, day)
        conn.execute("UPDATE days SET note = ? WHERE day = ?", (body.note, day))
        return load_day(conn, day)


@app.post("/api/days/{day}/lock")
def lock_day(day: str):
    """Фиксирует план: всё, что добавлено позже, считается внеплановым."""
    check_day(day)
    with tx() as conn:
        ensure_day(conn, day)
        conn.execute("UPDATE days SET plan_locked_at = ? WHERE day = ?", (now_iso(), day))
        return load_day(conn, day)


@app.post("/api/days/{day}/unlock")
def unlock_day(day: str):
    check_day(day)
    with tx() as conn:
        ensure_day(conn, day)
        conn.execute("UPDATE days SET plan_locked_at = NULL WHERE day = ?", (day,))
        return load_day(conn, day)


@app.post("/api/days/{day}/carry-over")
def carry_over(day: str, body: CarryIn):
    """Переносит незавершённые задачи (с открытыми подзадачами) на другой день."""
    check_day(day)
    check_day(body.to)
    if body.to == day:
        raise HTTPException(400, "Нельзя перенести на тот же день")
    with tx() as conn:
        open_top = conn.execute(
            "SELECT id FROM tasks WHERE day = ? AND parent_id IS NULL AND status = 'todo' "
            "ORDER BY position, id",
            (day,),
        ).fetchall()
        for row in open_top:
            carry_task(conn, row["id"], day, body.to)
        return {"moved": len(open_top), "day": load_day(conn, day)}


@app.get("/api/history")
def history(start: str, end: str):
    check_day(start)
    check_day(end)
    d0, d1 = date.fromisoformat(start), date.fromisoformat(end)
    if (d1 - d0).days > 366:
        raise HTTPException(400, "Слишком большой диапазон")
    with tx() as conn:
        rows = conn.execute(
            "SELECT * FROM tasks WHERE day BETWEEN ? AND ?", (start, end)
        ).fetchall()
        by_day: dict[str, list[dict]] = {}
        for r in rows:
            by_day.setdefault(r["day"], []).append(task_dict(r))
        out = []
        d = d0
        while d <= d1:
            key = d.isoformat()
            out.append({"day": key, **summarize(by_day.get(key, []))})
            d += timedelta(days=1)
        return out


# ---------- задачи ----------


@app.post("/api/tasks")
def create_task(body: TaskIn):
    check_day(body.day)
    with tx() as conn:
        if body.parent_id is not None:
            parent = task_row(conn, body.parent_id)
            if parent["day"] != body.day:
                raise HTTPException(400, "Подзадача должна быть в том же дне")
        tid = insert_task(
            conn, body.day, body.title, body.parent_id, body.estimate_min, body.notes,
            project_id=body.project_id, deadline=check_deadline(body.deadline), tags=body.tags,
        )
        if body.parent_id is not None:
            # новая открытая подзадача «переоткрывает» выполненного родителя
            cascade_status(conn, tid, "todo")
        return attach_tags(conn, [task_dict(task_row(conn, tid))])[0]


@app.post("/api/tasks/quick")
def create_quick(body: QuickIn):
    """Задача из одной строки: оценка, срок, @проект и #теги разбираются из текста."""
    check_day(body.day)
    item = parse_line(body.text, date.fromisoformat(body.day))
    if not item:
        raise HTTPException(400, "Пустое название задачи")
    with tx() as conn:
        if body.parent_id is not None and task_row(conn, body.parent_id)["day"] != body.day:
            raise HTTPException(400, "Подзадача должна быть в том же дне")
        tid = insert_task(
            conn, body.day, item["title"], body.parent_id, item["estimate_min"],
            project_id=project_by_name(conn, item["project"]) if item["project"] else None,
            deadline=item["deadline"], tags=item["tags"],
        )
        if body.parent_id is not None:
            cascade_status(conn, tid, "todo")
        return load_day(conn, body.day)


@app.post("/api/tasks/bulk")
def create_bulk(body: BulkIn):
    check_day(body.day)
    with tx() as conn:
        insert_tree(conn, body.day, body.items)
        return load_day(conn, body.day)


@app.patch("/api/tasks/{task_id}")
def patch_task(task_id: int, body: TaskPatch):
    with tx() as conn:
        original_day = task_row(conn, task_id)["day"]
        fields = body.model_dump(exclude_unset=True)
        status = fields.pop("status", None)
        tags = fields.pop("tags", None)
        new_day = fields.pop("day", None)
        if "deadline" in fields:
            fields["deadline"] = check_deadline(fields["deadline"])
        if fields.get("project_id") is not None:
            if not conn.execute("SELECT 1 FROM projects WHERE id = ?", (fields["project_id"],)).fetchone():
                raise HTTPException(404, "Проект не найден")
        if "planned" in fields:
            fields["planned"] = int(fields["planned"])
        if "title" in fields:
            fields["title"] = fields["title"].strip()
        if fields:
            cols = ", ".join(f"{k} = ?" for k in fields)
            conn.execute(f"UPDATE tasks SET {cols} WHERE id = ?", (*fields.values(), task_id))
        if tags is not None:
            set_tags(conn, task_id, tags)
        if status is not None:
            set_status(conn, task_id, status)
            cascade_status(conn, task_id, status)
        if new_day is not None:
            move_to_day(conn, task_id, check_day(new_day))
        return load_day(conn, original_day)


@app.get("/api/tasks/search")
def search_tasks(
    start: str | None = None,
    end: str | None = None,
    project_id: int | None = None,
    no_project: bool = False,
    tag: str | None = None,
    status: Status | Literal["open"] | None = None,
    q: str | None = None,
    limit: int = 1000,
):
    """Задачи за период с фильтрами — для вкладки «Задачи» («всё по проекту X за месяц»)."""
    where, args = [], []
    if start:
        where.append("t.day >= ?")
        args.append(check_day(start))
    if end:
        where.append("t.day <= ?")
        args.append(check_day(end))
    if project_id is not None:
        where.append("t.project_id = ?")
        args.append(project_id)
    elif no_project:
        where.append("t.project_id IS NULL")
    if tag:
        where.append("EXISTS (SELECT 1 FROM task_tags g WHERE g.task_id = t.id AND g.tag = ?)")
        args.append(tag.lstrip("#").lower())
    if status == "open":
        where.append("t.status = 'todo'")
    elif status:
        where.append("t.status = ?")
        args.append(status)
    if q:
        where.append("casefold(t.title) LIKE ?")
        args.append(f"%{q.strip().casefold()}%")
    sql = (
        "SELECT t.*, p.title AS parent_title FROM tasks t LEFT JOIN tasks p ON p.id = t.parent_id"
        + (" WHERE " + " AND ".join(where) if where else "")
        + " ORDER BY t.day DESC, t.parent_id IS NOT NULL, t.position, t.id LIMIT ?"
    )
    with tx() as conn:
        tasks = attach_tags(conn, [task_dict(r) for r in conn.execute(sql, (*args, max(1, min(limit, 5000))))])
    ids = {t["id"] for t in tasks}
    # «задачи» в сводке — без подзадач, чей родитель тоже попал в выборку
    roots = [t for t in tasks if t["parent_id"] not in ids]
    return {
        "tasks": tasks,
        "summary": {
            "total": len(roots),
            "done": sum(t["status"] == "done" for t in roots),
            "open": sum(t["status"] == "todo" for t in roots),
            "estimate_min": sum(t["estimate_min"] or 0 for t in roots),
            "actual_sec": sum(t["actual_sec"] for t in tasks),
        },
    }


@app.get("/api/deadlines")
def deadlines(day: str, days: int = 7):
    """Открытые задачи со сроком до day + days (включая просроченные) — блок «Сроки»."""
    check_day(day)
    until = (date.fromisoformat(day) + timedelta(days=days)).isoformat()
    with tx() as conn:
        rows = conn.execute(
            "SELECT * FROM tasks WHERE status = 'todo' AND deadline IS NOT NULL AND deadline <= ? "
            "ORDER BY deadline, day",
            (until,),
        ).fetchall()
        return attach_tags(conn, [task_dict(r) for r in rows])


@app.get("/api/dashboard")
def dashboard(start: str, end: str, project_id: int | None = None):
    d0, d1 = date.fromisoformat(check_day(start)), date.fromisoformat(check_day(end))
    if d1 < d0 or (d1 - d0).days > 366:
        raise HTTPException(400, "Период — от 1 до 366 дней")
    with tx() as conn:
        return stats.dashboard(conn, d0, d1, project_id)


# ---------- проекты и теги ----------


@app.get("/api/projects")
def list_projects():
    with tx() as conn:
        rows = conn.execute(
            """SELECT p.*, COUNT(t.id) AS task_count,
                      SUM(t.status = 'todo') AS open_count
               FROM projects p LEFT JOIN tasks t ON t.project_id = p.id AND t.parent_id IS NULL
               GROUP BY p.id ORDER BY p.archived, p.name COLLATE NOCASE"""
        ).fetchall()
        return [{**dict(r), "archived": bool(r["archived"]), "open_count": r["open_count"] or 0} for r in rows]


@app.post("/api/projects")
def create_project(body: ProjectIn):
    with tx() as conn:
        if conn.execute("SELECT 1 FROM projects WHERE name = ? COLLATE NOCASE", (body.name.strip(),)).fetchone():
            raise HTTPException(409, "Такой проект уже есть")
        pid = conn.execute(
            "INSERT INTO projects(name, color) VALUES (?, ?)", (body.name.strip(), body.color)
        ).lastrowid
        return dict(conn.execute("SELECT * FROM projects WHERE id = ?", (pid,)).fetchone())


@app.patch("/api/projects/{project_id}")
def patch_project(project_id: int, body: ProjectPatch):
    fields = body.model_dump(exclude_unset=True)
    if "archived" in fields:
        fields["archived"] = int(fields["archived"])
    with tx() as conn:
        if not conn.execute("SELECT 1 FROM projects WHERE id = ?", (project_id,)).fetchone():
            raise HTTPException(404, "Проект не найден")
        if fields:
            cols = ", ".join(f"{k} = ?" for k in fields)
            try:
                conn.execute(f"UPDATE projects SET {cols} WHERE id = ?", (*fields.values(), project_id))
            except sqlite3.IntegrityError:
                raise HTTPException(409, "Такой проект уже есть")
        return dict(conn.execute("SELECT * FROM projects WHERE id = ?", (project_id,)).fetchone())


@app.delete("/api/projects/{project_id}")
def delete_project(project_id: int):
    """Удаляет проект; задачи остаются, просто без проекта."""
    with tx() as conn:
        conn.execute("UPDATE tasks SET project_id = NULL WHERE project_id = ?", (project_id,))
        conn.execute("DELETE FROM projects WHERE id = ?", (project_id,))
        return {"ok": True}


@app.get("/api/tags")
def list_tags():
    with tx() as conn:
        return [
            dict(r) for r in conn.execute(
                "SELECT tag, COUNT(*) AS count FROM task_tags GROUP BY tag ORDER BY count DESC, tag"
            )
        ]


@app.delete("/api/tasks/{task_id}")
def delete_task(task_id: int):
    with tx() as conn:
        row = task_row(conn, task_id)
        conn.execute("DELETE FROM tasks WHERE id = ?", (task_id,))
        return load_day(conn, row["day"])


@app.post("/api/tasks/{task_id}/timer/start")
def timer_start(task_id: int):
    """Запускает таймер; одновременно идёт только один."""
    with tx() as conn:
        row = task_row(conn, task_id)
        for running in conn.execute(
            "SELECT * FROM tasks WHERE timer_started_at IS NOT NULL"
        ).fetchall():
            stop_timer(conn, running)
        conn.execute(
            "UPDATE tasks SET timer_started_at = ? WHERE id = ?", (now_iso(), task_id)
        )
        return load_day(conn, row["day"])


@app.post("/api/tasks/{task_id}/timer/stop")
def timer_stop(task_id: int):
    with tx() as conn:
        row = task_row(conn, task_id)
        stop_timer(conn, row)
        return load_day(conn, row["day"])


# ---------- ИИ ----------


class AISettingsIn(BaseModel):
    provider: str | None = None
    base_url: str | None = None
    model: str | None = None
    api_key: str | None = None  # пустая строка — оставить сохранённый


class AIParseIn(BaseModel):
    text: str = Field(min_length=1, max_length=8000)
    day: str


class AIReviewIn(BaseModel):
    day: str
    text: str = Field(min_length=1, max_length=8000)


class NewTaskIn(BaseModel):
    title: str = Field(min_length=1)
    done: bool = True


class AIReviewApply(BaseModel):
    day: str
    done: list[int] = []
    skipped: list[int] = []
    carry: list[int] = []
    new_tasks: list[NewTaskIn] = []
    note: str = ""


def _ai_call(fn, *args):
    try:
        return fn(*args)
    except ai_client.AIError as e:
        raise HTTPException(502, str(e))


def _draft_cfg(body: AISettingsIn) -> dict:
    """Несохранённые настройки из формы поверх сохранённых (ключ — из сохранённых, если поле пустое)."""
    cfg = ai_client.load_settings()
    patch = {k: v for k, v in body.model_dump().items() if v not in (None, "")}
    if patch.get("provider") and patch["provider"] != cfg["provider"]:
        # другой сервис — адрес, модель и ключ прежнего не подходят
        cfg.update(base_url="", model="", api_key="")
    cfg.update(patch)
    preset = ai_client.PROVIDERS.get(cfg["provider"], {})
    cfg["base_url"] = cfg["base_url"] or preset.get("base_url", "")
    cfg["model"] = cfg["model"] or preset.get("model", "")
    return cfg


@app.get("/api/ai/providers")
def ai_providers():
    return [{"id": k, **v} for k, v in ai_client.PROVIDERS.items()]


@app.get("/api/ai/settings")
def ai_get_settings():
    return ai_client.public_settings(ai_client.load_settings())


@app.put("/api/ai/settings")
def ai_put_settings(body: AISettingsIn):
    cfg = _draft_cfg(body)
    return ai_client.public_settings(ai_client.save_settings(cfg))


@app.delete("/api/ai/settings")
def ai_reset_settings():
    return ai_client.public_settings(ai_client.save_settings(dict(ai_client.DEFAULTS)))


@app.post("/api/ai/test")
def ai_test(body: AISettingsIn):
    return _ai_call(ai_client.test_connection, _draft_cfg(body))


@app.post("/api/ai/models")
def ai_models(body: AISettingsIn):
    return _ai_call(ai_client.list_models, _draft_cfg(body))


@app.get("/api/ai/ollama")
def ai_ollama_status():
    return ai_ollama.status()


@app.post("/api/ai/ollama/setup")
def ai_ollama_setup(model: str | None = None):
    try:
        return ai_ollama.start_setup(model)
    except RuntimeError as e:
        raise HTTPException(409, str(e))


@app.post("/api/ai/parse")
def ai_parse(body: AIParseIn):
    base = date.fromisoformat(check_day(body.day))
    with tx() as conn:
        projects = [r["name"] for r in conn.execute("SELECT name FROM projects WHERE archived = 0")]
        tags = [r["tag"] for r in conn.execute("SELECT DISTINCT tag FROM task_tags")]
    return {"items": _ai_call(ai_features.parse, body.text, base, projects, tags)}


@app.post("/api/ai/breakdown/{task_id}")
def ai_breakdown(task_id: int):
    with tx() as conn:
        row = task_row(conn, task_id)
        existing = [r["title"] for r in conn.execute("SELECT title FROM tasks WHERE parent_id = ?", (task_id,))]
        project = None
        if row["project_id"]:
            p = conn.execute("SELECT name FROM projects WHERE id = ?", (row["project_id"],)).fetchone()
            project = p["name"] if p else None
    return {"steps": _ai_call(ai_features.breakdown, row["title"], row["notes"], existing, project)}


@app.post("/api/ai/review")
def ai_review(body: AIReviewIn):
    check_day(body.day)
    with tx() as conn:
        tasks = [task_dict(r) for r in conn.execute(
            "SELECT * FROM tasks WHERE day = ? ORDER BY position, id", (body.day,)
        )]
    return _ai_call(ai_features.review, body.text, tasks)


@app.post("/api/ai/review/apply")
def ai_review_apply(body: AIReviewApply):
    """Применяет предложенные (и одобренные пользователем) итоги дня одним действием."""
    day = check_day(body.day)
    with tx() as conn:
        def own(tid: int):
            row = task_row(conn, tid)
            if row["day"] != day:
                raise HTTPException(400, "Задача из другого дня")
            return row

        for tid in body.done:
            own(tid)
            set_status(conn, tid, "done")
            cascade_status(conn, tid, "done")
        for tid in body.skipped:
            if own(tid)["status"] == "todo":
                set_status(conn, tid, "skipped")
                cascade_status(conn, tid, "skipped")
        to = (date.fromisoformat(day) + timedelta(days=1)).isoformat()
        for tid in body.carry:
            row = own(tid)
            if row["status"] == "todo" and row["parent_id"] is None:
                carry_task(conn, tid, day, to)
        for t in body.new_tasks:
            tid = insert_task(conn, day, t.title)
            conn.execute("UPDATE tasks SET planned = 0 WHERE id = ?", (tid,))  # сделано вне плана
            if t.done:
                set_status(conn, tid, "done")
        if body.note.strip():
            ensure_day(conn, day)
            old = day_info(conn, day)["note"].strip()
            note = f"{old}\n\n{body.note.strip()}" if old else body.note.strip()
            conn.execute("UPDATE days SET note = ? WHERE day = ?", (note, day))
        return load_day(conn, day)


# ---------- служебное ----------


@app.get("/api/health")
def health():
    return {"ok": True, "app": "planer", "version": RUNNING_VERSION}


# ---------- обновления ----------


@app.get("/api/update/check")
def update_check():
    try:
        return updater.public(updater.check())
    except updater.UpdateError as e:
        raise HTTPException(502, str(e))


@app.post("/api/update/apply")
def update_apply():
    try:
        return updater.start()
    except updater.UpdateError as e:
        raise HTTPException(409, str(e))


@app.get("/api/update/status")
def update_status():
    return {**updater.status(), "current": RUNNING_VERSION}


# ---------- голос ----------


@app.get("/api/voice/status")
def voice_status():
    return {
        "available": speech.available(),
        "model": speech.MODEL_NAME,
        "language": speech.LANGUAGE,
    }


@app.post("/api/voice/transcribe")
async def voice_transcribe(audio: UploadFile = File(...)):
    if not speech.available():
        raise HTTPException(
            503, "faster-whisper не установлен: pip install -r backend/requirements-voice.txt"
        )
    data = await audio.read()
    if not data:
        raise HTTPException(400, "Пустая запись")
    try:
        result = await run_in_threadpool(speech.transcribe, data)
    except Exception as e:
        # полный traceback — в лог, причину — в интерфейс
        log.exception("Ошибка распознавания")
        raise HTTPException(500, f"Ошибка распознавания: {type(e).__name__}: {e}")
    log.info("Распознано %.1f с, пик %.3f: %r", result["duration"], result["peak"], result["text"])
    return {**result, "items": parse_dictation(result["text"])}


@app.post("/api/voice/parse")
def voice_parse(body: ParseIn):
    base = date.fromisoformat(check_day(body.day)) if body.day else None
    return {"items": parse_dictation(body.text, base)}


# ---------- фронтенд ----------

DIST = Path(__file__).resolve().parents[2] / "frontend" / "dist"

if DIST.exists():
    app.mount("/assets", StaticFiles(directory=DIST / "assets"), name="assets")

    @app.get("/{path:path}", include_in_schema=False)
    def spa(path: str):
        file = (DIST / path).resolve()
        if path and file.is_file() and DIST in file.parents:
            return FileResponse(file)
        return FileResponse(DIST / "index.html")
