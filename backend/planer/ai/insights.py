"""Данные для ИИ: обзор недели, план утра, вопросы к планеру.

Цифры считаем здесь, а не просим модель: она только толкует готовые факты,
поэтому не может ошибиться в подсчётах или выдумать задачи.
"""

from collections import Counter, defaultdict
from datetime import date, timedelta

STATUS_RU = {"todo": "не сделана", "done": "сделана", "skipped": "пропущена", "moved": "перенесена"}


def _projects(conn) -> dict[int, str]:
    return {r["id"]: r["name"] for r in conn.execute("SELECT id, name FROM projects")}


def _tags(conn, ids: list[int]) -> dict[int, list[str]]:
    out: dict[int, list[str]] = defaultdict(list)
    for i in range(0, len(ids), 500):
        chunk = ids[i:i + 500]
        for r in conn.execute(
            f"SELECT task_id, tag FROM task_tags WHERE task_id IN ({','.join('?' * len(chunk))}) ORDER BY tag", chunk
        ):
            out[r["task_id"]].append(r["tag"])
    return out


def _key(title: str) -> str:
    return " ".join(title.casefold().split())


def carry_counts(conn, since: str) -> Counter:
    """Сколько раз задачу с таким названием переносили (оригиналы со статусом moved) с даты since."""
    return Counter(
        _key(r["title"])
        for r in conn.execute("SELECT title FROM tasks WHERE status = 'moved' AND day >= ? AND parent_id IS NULL", (since,))
    )


def task_line(t: dict, projects: dict[int, str], tags: dict[int, list[str]], with_day: bool = True) -> str:
    parts = [f"id {t['id']}"]
    if with_day:
        parts.append(t["day"])
    parts.append(f"[{STATUS_RU.get(t['status'], t['status'])}]")
    parts.append(t["title"])
    if t.get("project_id") in projects:
        parts.append(f"(проект {projects[t['project_id']]})")
    if tags.get(t["id"]):
        parts.append(" ".join(f"#{g}" for g in tags[t["id"]]))
    if t.get("estimate_min"):
        parts.append(f"оценка {t['estimate_min']} мин")
    if t.get("actual_sec"):
        parts.append(f"факт {round(t['actual_sec'] / 60)} мин")
    if t.get("deadline"):
        parts.append(f"срок {t['deadline']}")
    if not t.get("planned", 1):
        parts.append("вне плана")
    if t.get("parent_title"):
        parts.append(f"подзадача «{t['parent_title']}»")
    return " · ".join(parts)


# ---------- обзор недели ----------


def week_facts(conn, start: str, end: str) -> dict:
    rows = [dict(r) for r in conn.execute("SELECT * FROM tasks WHERE day BETWEEN ? AND ? ORDER BY day, position, id", (start, end))]
    top = [t for t in rows if t["parent_id"] is None]
    projects = _projects(conn)

    planned = [t for t in top if t["planned"] and t["status"] != "moved"]
    moved = [t for t in top if t["status"] == "moved"]
    done = [t for t in top if t["status"] == "done"]
    focus_min = round(sum(t["actual_sec"] for t in rows) / 60)

    by_project: dict[str, dict] = defaultdict(lambda: {"done": 0, "open": 0, "focus_min": 0})
    for t in top:
        name = projects.get(t["project_id"], "Без проекта")
        if t["status"] == "done":
            by_project[name]["done"] += 1
        elif t["status"] == "todo":
            by_project[name]["open"] += 1
    for t in rows:
        by_project[projects.get(t["project_id"], "Без проекта")]["focus_min"] += round(t["actual_sec"] / 60)

    # «буксует»: переносилась 2+ раза за последние 30 дней или просрочена, и всё ещё не сделана
    since = (date.fromisoformat(end) - timedelta(days=30)).isoformat()
    carries = carry_counts(conn, since)
    stuck, seen = [], set()
    for r in conn.execute(
        "SELECT * FROM tasks WHERE status = 'todo' AND parent_id IS NULL AND day <= ? ORDER BY day DESC", (end,)
    ):
        k = _key(r["title"])
        if k in seen:
            continue
        overdue = r["deadline"] and r["deadline"] < end
        if carries[k] >= 2 or overdue:
            seen.add(k)
            stuck.append({"id": r["id"], "title": r["title"], "day": r["day"], "carried": carries[k],
                          "deadline": r["deadline"], "overdue": bool(overdue)})

    # точность оценок: задачи с оценкой и замеренным временем
    measured = [t for t in rows if t["estimate_min"] and t["actual_sec"] >= 60]
    est_total = sum(t["estimate_min"] for t in measured)
    act_total = round(sum(t["actual_sec"] for t in measured) / 60)
    misses = sorted(measured, key=lambda t: abs(t["actual_sec"] / 60 - t["estimate_min"]), reverse=True)[:5]

    notes = [{"day": r["day"], "note": r["note"].strip()} for r in conn.execute(
        "SELECT day, note FROM days WHERE day BETWEEN ? AND ? AND trim(note) != '' ORDER BY day", (start, end)
    )]

    return {
        "start": start,
        "end": end,
        "planned": len(planned),
        "planned_done": sum(t["status"] == "done" for t in planned),
        "done": len(done),
        "unplanned_done": sum(not t["planned"] for t in done),
        "moved": len(moved),
        "focus_min": focus_min,
        "projects": sorted(
            ({"name": k, **v} for k, v in by_project.items()), key=lambda p: (-p["done"], -p["focus_min"], p["name"])
        ),
        "done_titles": [
            {"id": t["id"], "day": t["day"], "title": t["title"], "project": projects.get(t["project_id"])} for t in done
        ],
        "stuck": stuck[:10],
        "estimates": {
            "tasks": len(measured),
            "estimate_min": est_total,
            "actual_min": act_total,
            "ratio": round(act_total / est_total, 2) if est_total else None,
            "misses": [
                {"id": t["id"], "title": t["title"], "estimate_min": t["estimate_min"], "actual_min": round(t["actual_sec"] / 60)}
                for t in misses
            ],
        },
        "notes": notes,
    }


# ---------- план утра ----------


def plan_candidates(conn, day: str) -> list[dict]:
    """Задачи, из которых складывается день: сегодняшние, хвосты прошлых дней и ближайшие сроки."""
    projects = _projects(conn)
    since = (date.fromisoformat(day) - timedelta(days=14)).isoformat()
    soon = (date.fromisoformat(day) + timedelta(days=7)).isoformat()
    carries = carry_counts(conn, (date.fromisoformat(day) - timedelta(days=30)).isoformat())
    rows = conn.execute(
        """SELECT t.*, (SELECT COUNT(*) FROM tasks c WHERE c.parent_id = t.id AND c.status = 'todo') AS open_subtasks
           FROM tasks t
           WHERE t.parent_id IS NULL AND t.status = 'todo'
             AND (t.day = ? OR t.day BETWEEN ? AND ? OR (t.deadline IS NOT NULL AND t.deadline <= ?))
           ORDER BY t.day = ? DESC, t.deadline IS NULL, t.deadline, t.day DESC, t.position""",
        (day, since, day, soon, day),
    ).fetchall()
    out, seen = [], set()
    for r in rows:
        k = _key(r["title"])
        # одна и та же задача могла остаться открытой в нескольких днях — берём самую свежую
        if r["day"] != day and k in seen:
            continue
        seen.add(k)
        source = "today" if r["day"] == day else ("past" if r["day"] < day else "future")
        out.append({
            "id": r["id"], "title": r["title"], "day": r["day"], "source": source,
            "estimate_min": r["estimate_min"], "deadline": r["deadline"],
            "project": projects.get(r["project_id"]), "open_subtasks": r["open_subtasks"],
            "carried": carries[k],
        })
    return out[:60]


# ---------- вопросы к планеру ----------


def stem(word: str) -> str:
    """Грубая основа слова: «лонгрида» и «лонгрид» должны находить друг друга."""
    w = word.casefold().replace("ё", "е")
    return w if len(w) <= 4 else w[: max(4, len(w) - 2)]


def query_tasks(conn, f: dict, limit: int = 250) -> dict:
    where, args = [], []
    if f.get("start"):
        where.append("t.day >= ?")
        args.append(f["start"])
    if f.get("end"):
        where.append("t.day <= ?")
        args.append(f["end"])
    if f.get("project"):
        where.append("t.project_id IN (SELECT id FROM projects WHERE casefold(name) = ?)")
        args.append(f["project"].casefold())
    if f.get("tag"):
        where.append("EXISTS (SELECT 1 FROM task_tags g WHERE g.task_id = t.id AND g.tag = ?)")
        args.append(f["tag"])
    if f.get("status"):
        where.append("t.status = ?")
        args.append(f["status"])
    words = [stem(w) for w in f.get("keywords") or [] if w.strip()]
    if words:
        where.append("(" + " OR ".join(
            "replace(casefold(t.title || ' ' || t.notes || ' ' || COALESCE(p.title, '')), 'ё', 'е') LIKE ?" for _ in words
        ) + ")")
        args += [f"%{w}%" for w in words]
    sql = (
        "SELECT t.*, p.title AS parent_title FROM tasks t LEFT JOIN tasks p ON p.id = t.parent_id"
        + (" WHERE " + " AND ".join(where) if where else "")
        + " ORDER BY t.day DESC, t.parent_id IS NOT NULL, t.position, t.id"
    )
    rows = [dict(r) for r in conn.execute(sql, args)]
    projects = _projects(conn)
    shown = rows[:limit]
    tags = _tags(conn, [t["id"] for t in shown])

    top = [t for t in rows if t["parent_id"] is None or t["parent_id"] not in {x["id"] for x in rows}]
    by_project: Counter = Counter()
    for t in rows:
        by_project[projects.get(t["project_id"], "Без проекта")] += t["actual_sec"]
    summary = {
        "found": len(rows),
        "shown": len(shown),
        "done": sum(t["status"] == "done" for t in top),
        "open": sum(t["status"] == "todo" for t in top),
        "focus_min": round(sum(t["actual_sec"] for t in rows) / 60),
        "focus_by_project_min": {k: round(v / 60) for k, v in by_project.most_common() if v},
    }
    notes = []
    if f.get("start") or f.get("end"):
        notes = [{"day": r["day"], "note": r["note"].strip()} for r in conn.execute(
            "SELECT day, note FROM days WHERE day BETWEEN ? AND ? AND trim(note) != '' ORDER BY day DESC LIMIT 14",
            (f.get("start") or "0000-01-01", f.get("end") or "9999-12-31"),
        )]
    return {
        "tasks": shown,
        "lines": [task_line(t, projects, tags) for t in shown],
        "summary": summary,
        "notes": notes,
    }
