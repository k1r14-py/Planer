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
    # 2: проекты, созданные через «@Проект», получали один цвет по умолчанию — раскрашиваем по кругу
    """
    UPDATE projects SET color = CASE (
        (SELECT COUNT(*) FROM projects p2 WHERE p2.id < projects.id) % 8)
        WHEN 0 THEN '#6d5efc' WHEN 1 THEN '#16a36a' WHEN 2 THEN '#e5484d' WHEN 3 THEN '#d68a00'
        WHEN 4 THEN '#0091ff' WHEN 5 THEN '#d6409f' WHEN 6 THEN '#12a594' ELSE '#8e8c99' END
    WHERE color = '#6d5efc'
    """,
    # 3: настройки (ИИ-провайдер и т. п.) — ключ/значение
    """
    CREATE TABLE IF NOT EXISTS settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
    );
    """,
    # 4: ссылки по ключевым словам — у задачи, где встречаются все слова правила, появляется ссылка
    """
    CREATE TABLE IF NOT EXISTS link_rules (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        keywords   TEXT NOT NULL,              -- JSON-список слов
        url        TEXT NOT NULL,
        label      TEXT NOT NULL DEFAULT '',
        position   REAL NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
    );
    """,
]

# те же цвета, что PROJECT_COLORS во фронтенде
PROJECT_COLORS = ["#6d5efc", "#16a36a", "#e5484d", "#d68a00", "#0091ff", "#d6409f", "#12a594", "#8e8c99"]


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
