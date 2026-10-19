"""Сводная статистика для дашборда за период (с необязательным фильтром по проекту).

План/факт считается по задачам верхнего уровня — так же, как summarize() в app.py.
"""

from collections import defaultdict
from datetime import date, timedelta


def _load(conn, start: str, end: str, project_id: int | None) -> list[dict]:
    sql = "SELECT * FROM tasks WHERE day BETWEEN ? AND ?"
    args: list = [start, end]
    if project_id is not None:
        sql += " AND project_id = ?"
        args.append(project_id)
    return [dict(r) for r in conn.execute(sql, args)]


def _period(tasks: list[dict]) -> dict:
    ids = {t["id"] for t in tasks}
    # подзадача, чей родитель не попал в выборку (фильтр по проекту), считается самостоятельной
    top = [t for t in tasks if t["parent_id"] not in ids]
    planned = [t for t in top if t["planned"]]
    return {
        "planned": len(planned),
        "planned_done": sum(t["status"] == "done" for t in planned),
        "done": sum(t["status"] == "done" for t in top),
        "unplanned_done": sum(t["status"] == "done" and not t["planned"] for t in top),
        "focus_sec": sum(t["actual_sec"] for t in tasks),
    }


def _rate(done: int, total: int) -> float | None:
    return round(done / total, 4) if total else None


def dashboard(conn, start: date, end: date, project_id: int | None = None, today: date | None = None) -> dict:
    today = today or date.today()
    days = (end - start).days + 1
    prev_end = start - timedelta(days=1)
    prev_start = prev_end - timedelta(days=days - 1)

    tasks = _load(conn, start.isoformat(), end.isoformat(), project_id)
    prev = _load(conn, prev_start.isoformat(), prev_end.isoformat(), project_id)
    cur_p, prev_p = _period(tasks), _period(prev)

    # ---- по дням
    by_day: dict[str, list[dict]] = defaultdict(list)
    for t in tasks:
        by_day[t["day"]].append(t)
    daily = []
    d = start
    while d <= end:
        p = _period(by_day.get(d.isoformat(), []))
        daily.append({"day": d.isoformat(), **p})
        d += timedelta(days=1)

    # ---- точность оценок: задачи с собственной оценкой и засечённым временем
    measured = [t for t in tasks if t["status"] == "done" and t["estimate_min"] and t["actual_sec"] > 0]
    est = sum(t["estimate_min"] * 60 for t in measured)
    accuracy = {"ratio": round(sum(t["actual_sec"] for t in measured) / est, 2) if est else None, "tasks": len(measured)}

    # ---- серия: дни подряд (до сегодня или конца периода), в которые что-то сделано
    streak_end = min(end, today)
    pq = " AND project_id = ?" if project_id is not None else ""
    done_days = {
        r[0] for r in conn.execute(
            f"SELECT DISTINCT day FROM tasks WHERE status = 'done' AND day <= ?{pq}",
            [streak_end.isoformat()] + ([project_id] if project_id is not None else []),
        )
    }
    streak, d = 0, streak_end
    if d.isoformat() not in done_days:
        d -= timedelta(days=1)  # сегодня ещё не вечер — серия не обрывается
    while d.isoformat() in done_days:
        streak += 1
        d -= timedelta(days=1)

    overdue = conn.execute(
        f"SELECT COUNT(*) FROM tasks WHERE status = 'todo' AND deadline IS NOT NULL AND deadline < ?{pq}",
        [today.isoformat()] + ([project_id] if project_id is not None else []),
    ).fetchone()[0]

    # ---- проекты (без фильтра по проекту — иначе разбивка бессмысленна)
    projects = []
    if project_id is None:
        rows = conn.execute(
            """SELECT p.id, p.name, p.color,
                      SUM(t.status = 'done' AND t.parent_id IS NULL) AS done,
                      SUM(t.parent_id IS NULL) AS total,
                      SUM(t.actual_sec) AS focus_sec
               FROM tasks t JOIN projects p ON p.id = t.project_id
               WHERE t.day BETWEEN ? AND ?
               GROUP BY p.id ORDER BY done DESC, total DESC""",
            (start.isoformat(), end.isoformat()),
        ).fetchall()
        projects = [
            {"id": r["id"], "name": r["name"], "color": r["color"], "done": r["done"] or 0,
             "total": r["total"] or 0, "focus_sec": r["focus_sec"] or 0}
            for r in rows
        ]
        no_project = [t for t in tasks if t["project_id"] is None and t["parent_id"] is None]
        if no_project:
            projects.append({
                "id": None, "name": "Без проекта", "color": None,
                "done": sum(t["status"] == "done" for t in no_project), "total": len(no_project),
                "focus_sec": sum(t["actual_sec"] for t in tasks if t["project_id"] is None),
            })

    # ---- теги
    ids = [t["id"] for t in tasks]
    tag_stats: dict[str, dict] = {}
    status = {t["id"]: t["status"] for t in tasks}
    for i in range(0, len(ids), 500):
        chunk = ids[i:i + 500]
        for r in conn.execute(
            f"SELECT task_id, tag FROM task_tags WHERE task_id IN ({','.join('?' * len(chunk))})", chunk
        ):
            s = tag_stats.setdefault(r["tag"], {"tag": r["tag"], "done": 0, "total": 0})
            s["total"] += 1
            s["done"] += status[r["task_id"]] == "done"
    tags = sorted(tag_stats.values(), key=lambda s: (-s["total"], s["tag"]))[:10]

    # ---- дни недели (0 = понедельник)
    weekdays = [{"weekday": i, "planned": 0, "planned_done": 0, "done": 0} for i in range(7)]
    for row in daily:
        w = weekdays[date.fromisoformat(row["day"]).weekday()]
        w["planned"] += row["planned"]
        w["planned_done"] += row["planned_done"]
        w["done"] += row["done"]

    return {
        "range": {"start": start.isoformat(), "end": end.isoformat(), "days": days,
                  "prev_start": prev_start.isoformat(), "prev_end": prev_end.isoformat()},
        "kpi": {
            "completion": {"value": _rate(cur_p["planned_done"], cur_p["planned"]),
                           "prev": _rate(prev_p["planned_done"], prev_p["planned"])},
            "done": {"value": cur_p["done"], "prev": prev_p["done"]},
            "focus_sec": {"value": cur_p["focus_sec"], "prev": prev_p["focus_sec"]},
            "unplanned_share": _rate(cur_p["unplanned_done"], cur_p["done"]),
            "accuracy": accuracy,
            "streak": streak,
            "overdue": overdue,
        },
        "daily": daily,
        "projects": projects,
        "tags": tags,
        "weekdays": weekdays,
    }
