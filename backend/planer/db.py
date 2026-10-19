"""SQLite-хранилище: дни и задачи (с подзадачами через parent_id)."""

import os
import sqlite3
from contextlib import contextmanager
from pathlib import Path

DEFAULT_DB = Path(__file__).resolve().parents[2] / "data" / "planer.db"

SCHEMA = """
CREATE TABLE IF NOT EXISTS days (
    day            TEXT PRIMARY KEY,           -- YYYY-MM-DD
    plan_locked_at TEXT,                       -- когда план был зафиксирован
    note           TEXT NOT NULL DEFAULT ''    -- заметка / итоги дня
);

CREATE TABLE IF NOT EXISTS tasks (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    day              TEXT NOT NULL,
    parent_id        INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
    title            TEXT NOT NULL,
    notes            TEXT NOT NULL DEFAULT '',
    position         REAL NOT NULL DEFAULT 0,
    status           TEXT NOT NULL DEFAULT 'todo',  -- todo | done | skipped | moved
    planned          INTEGER NOT NULL DEFAULT 1,     -- 1 = была в плане, 0 = добавлена после фиксации
    estimate_min     INTEGER,                        -- оценка, минуты
    actual_sec       INTEGER NOT NULL DEFAULT 0,     -- фактически затрачено, секунды
    timer_started_at TEXT,                           -- ISO-время запуска таймера
    moved_from       TEXT,                           -- день, из которого задача перенесена
    created_at       TEXT NOT NULL,
    done_at          TEXT
);

CREATE INDEX IF NOT EXISTS idx_tasks_day ON tasks(day);
CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_id);
"""


def db_path() -> Path:
    return Path(os.environ.get("PLANER_DB", DEFAULT_DB))


def connect() -> sqlite3.Connection:
    path = db_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    # встроенные lower()/LIKE в SQLite не понимают регистр кириллицы
    conn.create_function("casefold", 1, lambda v: v.casefold() if isinstance(v, str) else v, deterministic=True)
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


# Миграции применяются по порядку к существующей базе; номер хранится в PRAGMA user_version.
MIGRATIONS = [
    # 1: проекты, теги, сроки
    """
    CREATE TABLE IF NOT EXISTS projects (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        name       TEXT NOT NULL UNIQUE COLLATE NOCASE,
        color      TEXT NOT NULL DEFAULT '#6d5efc',
        archived   INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
    );
    ALTER TABLE tasks ADD COLUMN project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL;
    ALTER TABLE tasks ADD COLUMN deadline TEXT;
    CREATE TABLE IF NOT EXISTS task_tags (
        task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        tag     TEXT NOT NULL,
        PRIMARY KEY (task_id, tag)
    );
    CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_deadline ON tasks(deadline);
    CREATE INDEX IF NOT EXISTS idx_task_tags_tag ON task_tags(tag);
    """,
]


def init_db() -> None:
    conn = connect()
    try:
        conn.executescript(SCHEMA)
        version = conn.execute("PRAGMA user_version").fetchone()[0]
        for i, sql in enumerate(MIGRATIONS[version:], start=version + 1):
            conn.executescript(f"BEGIN; {sql}; PRAGMA user_version = {i}; COMMIT;")
    finally:
        conn.close()


@contextmanager
def tx():
    conn = connect()
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()
