"""HTTP API планера + раздача собранного фронтенда."""

import logging
from contextlib import asynccontextmanager
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Literal

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from starlette.concurrency import run_in_threadpool

from . import speech
from .db import init_db, tx
from .dictation import parse_dictation

log = logging.getLogger("planer")

Status = Literal["todo", "done", "skipped", "moved"]

@asynccontextmanager
async def lifespan(_app: FastAPI):
    init_db()
    yield


app = FastAPI(title="Planer", lifespan=lifespan)


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


class TaskPatch(BaseModel):
    title: str | None = Field(default=None, min_length=1)
    notes: str | None = None
    status: Status | None = None
    estimate_min: int | None = Field(default=None, ge=0)
    actual_sec: int | None = Field(default=None, ge=0)
    position: float | None = None
    planned: bool | None = None


class TreeItem(BaseModel):
    title: str = Field(min_length=1)
    estimate_min: int | None = Field(default=None, ge=0)
    children: list["TreeItem"] = []


class BulkIn(BaseModel):
    day: str
    items: list[TreeItem]


class DayPatch(BaseModel):
    note: str


class CarryIn(BaseModel):
    to: str


class ParseIn(BaseModel):
    text: str


# ---------- helpers ----------


def task_row(conn, task_id: int):
    row = conn.execute("SELECT * FROM tasks WHERE id = ?", (task_id,)).fetchone()
    if row is None:
        raise HTTPException(404, "Задача не найдена")
    return row


def task_dict(row) -> dict:
    d = dict(row)
    d["planned"] = bool(d["planned"])
    return d


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


def insert_task(conn, day, title, parent_id=None, estimate_min=None, notes="", moved_from=None) -> int:
    ensure_day(conn, day)
    cur = conn.execute(
        """INSERT INTO tasks(day, parent_id, title, notes, position, planned, estimate_min,
                             moved_from, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            day, parent_id, title.strip(), notes, next_position(conn, day, parent_id),
            0 if is_locked(conn, day) else 1, estimate_min, moved_from, now_iso(),
        ),
    )
    return cur.lastrowid


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
        tid = insert_task(conn, day, item.title, parent_id, item.estimate_min)
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
    tasks = [task_dict(r) for r in rows]
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
        def copy(task_id: int, parent_id: int | None) -> None:
            src = task_row(conn, task_id)
            new_id = insert_task(
                conn, body.to, src["title"], parent_id, src["estimate_min"], src["notes"],
                moved_from=day,
            )
            for child in conn.execute(
                "SELECT id FROM tasks WHERE parent_id = ? AND status = 'todo' ORDER BY position, id",
                (task_id,),
            ).fetchall():
                copy(child["id"], new_id)
            set_status(conn, task_id, "moved")

        open_top = conn.execute(
            "SELECT id FROM tasks WHERE day = ? AND parent_id IS NULL AND status = 'todo' "
            "ORDER BY position, id",
            (day,),
        ).fetchall()
        for row in open_top:
            copy(row["id"], None)
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
        tid = insert_task(conn, body.day, body.title, body.parent_id, body.estimate_min, body.notes)
        if body.parent_id is not None:
            # новая открытая подзадача «переоткрывает» выполненного родителя
            cascade_status(conn, tid, "todo")
        return task_dict(task_row(conn, tid))


@app.post("/api/tasks/bulk")
def create_bulk(body: BulkIn):
    check_day(body.day)
    with tx() as conn:
        insert_tree(conn, body.day, body.items)
        return load_day(conn, body.day)


@app.patch("/api/tasks/{task_id}")
def patch_task(task_id: int, body: TaskPatch):
    with tx() as conn:
        task_row(conn, task_id)
        fields = body.model_dump(exclude_unset=True)
        status = fields.pop("status", None)
        if "planned" in fields:
            fields["planned"] = int(fields["planned"])
        if "title" in fields:
            fields["title"] = fields["title"].strip()
        if fields:
            cols = ", ".join(f"{k} = ?" for k in fields)
            conn.execute(f"UPDATE tasks SET {cols} WHERE id = ?", (*fields.values(), task_id))
        if status is not None:
            set_status(conn, task_id, status)
            cascade_status(conn, task_id, status)
        return load_day(conn, task_row(conn, task_id)["day"])


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


# ---------- служебное ----------


@app.get("/api/health")
def health():
    return {"ok": True, "app": "planer"}


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
    suffix = Path(audio.filename or "rec.webm").suffix or ".webm"
    try:
        text = await run_in_threadpool(speech.transcribe, data, suffix)
    except Exception as e:
        # полный traceback — в лог, причину — в интерфейс
        log.exception("Ошибка распознавания")
        raise HTTPException(500, f"Ошибка распознавания: {type(e).__name__}: {e}")
    return {"text": text, "items": parse_dictation(text)}


@app.post("/api/voice/parse")
def voice_parse(body: ParseIn):
    return {"items": parse_dictation(body.text)}


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
