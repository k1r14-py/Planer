import pytest
from fastapi.testclient import TestClient

DAY = "2026-10-19"


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("PLANER_DB", str(tmp_path / "t.db"))
    from planer.app import app

    with TestClient(app) as c:
        yield c


def add(client, title, parent_id=None, day=DAY, **kw):
    r = client.post("/api/tasks", json={"day": day, "title": title, "parent_id": parent_id, **kw})
    assert r.status_code == 200, r.text
    return r.json()


def by_title(day_json):
    return {t["title"]: t for t in day_json["tasks"]}


def test_plan_vs_fact(client):
    a = add(client, "A", estimate_min=30)
    add(client, "B", estimate_min=60)
    client.post(f"/api/days/{DAY}/lock")
    c = add(client, "C")
    assert c["planned"] is False
    client.patch(f"/api/tasks/{a['id']}", json={"status": "done"})
    day = client.patch(f"/api/tasks/{c['id']}", json={"status": "done"}).json()
    s = day["summary"]
    assert (s["planned_total"], s["planned_done"]) == (2, 1)
    assert (s["unplanned_total"], s["unplanned_done"]) == (1, 1)
    assert s["estimate_planned_min"] == 90
    assert s["estimate_done_min"] == 30


def test_subtask_cascade(client):
    p = add(client, "Parent")
    s1 = add(client, "s1", p["id"])
    s2 = add(client, "s2", p["id"])
    client.patch(f"/api/tasks/{s1['id']}", json={"status": "done"})
    day = client.patch(f"/api/tasks/{s2['id']}", json={"status": "done"}).json()
    assert by_title(day)["Parent"]["status"] == "done"
    day = client.patch(f"/api/tasks/{s2['id']}", json={"status": "todo"}).json()
    assert by_title(day)["Parent"]["status"] == "todo"
    day = client.patch(f"/api/tasks/{p['id']}", json={"status": "done"}).json()
    assert {t["status"] for t in day["tasks"]} == {"done"}
    add(client, "s3", p["id"])
    day = client.get(f"/api/days/{DAY}").json()
    assert by_title(day)["Parent"]["status"] == "todo"


def test_carry_over(client):
    p = add(client, "Parent")
    s1 = add(client, "s1", p["id"])
    add(client, "s2", p["id"])
    d = add(client, "Done")
    client.patch(f"/api/tasks/{s1['id']}", json={"status": "done"})
    client.patch(f"/api/tasks/{d['id']}", json={"status": "done"})
    r = client.post(f"/api/days/{DAY}/carry-over", json={"to": "2026-10-20"}).json()
    assert r["moved"] == 1
    assert by_title(r["day"])["Parent"]["status"] == "moved"
    nxt = client.get("/api/days/2026-10-20").json()
    assert sorted(t["title"] for t in nxt["tasks"]) == ["Parent", "s2"]
    assert all(t["moved_from"] == DAY for t in nxt["tasks"])


def test_bulk_and_delete(client):
    day = client.post(
        "/api/tasks/bulk",
        json={"day": DAY, "items": [{"title": "X", "children": [{"title": "x1"}]}, {"title": "Y"}]},
    ).json()
    x = by_title(day)["X"]
    assert by_title(day)["x1"]["parent_id"] == x["id"]
    day = client.delete(f"/api/tasks/{x['id']}").json()
    assert [t["title"] for t in day["tasks"]] == ["Y"]


def test_timer(client):
    a = add(client, "A")
    b = add(client, "B")
    client.post(f"/api/tasks/{a['id']}/timer/start")
    day = client.post(f"/api/tasks/{b['id']}/timer/start").json()
    t = by_title(day)
    assert t["A"]["timer_started_at"] is None
    assert t["B"]["timer_started_at"] is not None
    day = client.patch(f"/api/tasks/{b['id']}", json={"status": "done"}).json()
    assert by_title(day)["B"]["timer_started_at"] is None


def test_history(client):
    a = add(client, "A")
    client.patch(f"/api/tasks/{a['id']}", json={"status": "done"})
    h = client.get("/api/history", params={"start": "2026-10-18", "end": "2026-10-20"}).json()
    assert [d["day"] for d in h] == ["2026-10-18", "2026-10-19", "2026-10-20"]
    assert h[1]["planned_done"] == 1


def test_parse_endpoint(client):
    r = client.post("/api/voice/parse", json={"text": "Купить хлеб. Потом спорт на час"}).json()
    assert [i["title"] for i in r["items"]] == ["Купить хлеб", "Спорт"]


def test_bad_day(client):
    assert client.get("/api/days/nope").status_code == 400


def test_transcribe_parses_text(client, monkeypatch):
    from planer import speech

    monkeypatch.setattr(speech, "available", lambda: True)
    monkeypatch.setattr(
        speech, "transcribe",
        lambda data: {"text": "Купить хлеб. Подзадача батон", "duration": 2.0, "peak": 0.4},
    )
    r = client.post("/api/voice/transcribe", files={"audio": ("rec.webm", b"fake", "audio/webm")})
    assert r.status_code == 200, r.text
    assert r.json()["items"][0]["children"][0]["title"] == "Батон"


def test_transcribe_unavailable(client, monkeypatch):
    from planer import speech

    monkeypatch.setattr(speech, "available", lambda: False)
    r = client.post("/api/voice/transcribe", files={"audio": ("rec.webm", b"x", "audio/webm")})
    assert r.status_code == 503


def test_health(client):
    body = client.get("/api/health").json()
    assert body["app"] == "planer" and body["version"]


def test_transcribe_error_is_explained(client, monkeypatch):
    from planer import speech

    def boom(data):
        raise RuntimeError("модель не найдена")

    monkeypatch.setattr(speech, "available", lambda: True)
    monkeypatch.setattr(speech, "transcribe", boom)
    r = client.post("/api/voice/transcribe", files={"audio": ("rec.webm", b"x", "audio/webm")})
    assert r.status_code == 500
    assert r.json()["detail"] == "Ошибка распознавания: RuntimeError: модель не найдена"


def quick(client, text, day=DAY, parent_id=None):
    r = client.post("/api/tasks/quick", json={"day": day, "text": text, "parent_id": parent_id})
    assert r.status_code == 200, r.text
    return r.json()


def test_quick_add_parses_everything(client):
    day = quick(client, "Сдать отчёт 1.5ч до пятницы @Работа #срочно #отчёты")
    t = by_title(day)["Сдать отчёт"]
    assert t["estimate_min"] == 90
    assert t["deadline"] == "2026-10-23"  # DAY — понедельник
    assert t["tags"] == ["отчёты", "срочно"]
    projects = client.get("/api/projects").json()
    assert [(p["name"], p["open_count"]) for p in projects] == [("Работа", 1)]
    assert t["project_id"] == projects[0]["id"]
    # подзадача наследует проект
    day = quick(client, "собрать данные", parent_id=t["id"])
    assert by_title(day)["Собрать данные"]["project_id"] == t["project_id"]
    # тот же проект другим регистром — не дубль
    quick(client, "ещё задача @работа")
    assert len(client.get("/api/projects").json()) == 1


def test_patch_tags_project_deadline(client):
    a = add(client, "A")
    p = client.post("/api/projects", json={"name": "Дом"}).json()
    day = client.patch(f"/api/tasks/{a['id']}", json={
        "tags": ["#Быт", "быт", "магазин"], "project_id": p["id"], "deadline": "2026-10-30",
    }).json()
    t = by_title(day)["A"]
    assert t["tags"] == ["быт", "магазин"] and t["project_id"] == p["id"] and t["deadline"] == "2026-10-30"
    day = client.patch(f"/api/tasks/{a['id']}", json={"project_id": None, "deadline": None, "tags": []}).json()
    t = by_title(day)["A"]
    assert t["project_id"] is None and t["deadline"] is None and t["tags"] == []
    assert client.patch(f"/api/tasks/{a['id']}", json={"deadline": "завтра"}).status_code == 400


def test_search_by_project_and_period(client):
    quick(client, "Отчёт @Работа #срочно", day="2026-10-05")
    quick(client, "Созвон @Работа", day="2026-10-19")
    quick(client, "Старое @Работа", day="2026-09-01")
    quick(client, "Уборка @Дом", day="2026-10-10")
    pid = next(p["id"] for p in client.get("/api/projects").json() if p["name"] == "Работа")
    r = client.get("/api/tasks/search", params={"project_id": pid, "start": "2026-10-01", "end": "2026-10-31"}).json()
    assert [t["title"] for t in r["tasks"]] == ["Созвон", "Отчёт"]
    assert r["summary"]["total"] == 2 and r["summary"]["done"] == 0
    r = client.get("/api/tasks/search", params={"tag": "#срочно"}).json()
    assert [t["title"] for t in r["tasks"]] == ["Отчёт"]
    r = client.get("/api/tasks/search", params={"q": "убор"}).json()
    assert [t["title"] for t in r["tasks"]] == ["Уборка"]
    assert {t["tag"] for t in client.get("/api/tags").json()} == {"срочно"}


def test_search_counts_subtasks_once(client):
    day = quick(client, "Родитель @Работа")
    pid = by_title(day)["Родитель"]["id"]
    quick(client, "ребёнок", parent_id=pid)
    r = client.get("/api/tasks/search", params={"q": ""}).json()
    assert r["summary"]["total"] == 1
    assert next(t for t in r["tasks"] if t["title"] == "Ребёнок")["parent_title"] == "Родитель"


def test_deadlines_and_move_to_day(client):
    quick(client, "Отчёт до пятницы", day="2026-10-16")  # пятница → следующая, 23.10
    quick(client, "Налоги до 01.12.2026", day="2026-10-15")
    quick(client, "Просрочено до 18.10", day="2026-10-10")
    d = client.get("/api/deadlines", params={"day": DAY, "days": 7}).json()
    assert [t["title"] for t in d] == ["Просрочено", "Отчёт"]
    # перенос на сегодня вместе с подзадачей
    tid = d[1]["id"]
    quick(client, "часть", day="2026-10-16", parent_id=tid)
    client.patch(f"/api/tasks/{tid}", json={"day": DAY})
    today = by_title(client.get(f"/api/days/{DAY}").json())
    assert today["Отчёт"]["moved_from"] == "2026-10-16" and today["Часть"]["parent_id"] == tid


def test_carry_over_keeps_meta(client):
    day = quick(client, "Отчёт до пятницы @Работа #срочно")
    client.post(f"/api/days/{DAY}/carry-over", json={"to": "2026-10-20"})
    t = by_title(client.get("/api/days/2026-10-20").json())["Отчёт"]
    assert t["deadline"] == "2026-10-23" and t["tags"] == ["срочно"] and t["project_id"]


def test_bulk_with_meta(client):
    day = client.post("/api/tasks/bulk", json={"day": DAY, "items": [
        {"title": "X", "deadline": "2026-10-23", "project": "Учёба", "tags": ["курс"], "children": [{"title": "x1"}]},
    ]}).json()
    t = by_title(day)
    assert t["X"]["deadline"] == "2026-10-23" and t["X"]["tags"] == ["курс"]
    assert t["x1"]["project_id"] == t["X"]["project_id"]


def test_dashboard(client):
    # прошлый период: 1 из 2 плановых сделана
    a = by_title(quick(client, "Старая A", day="2026-10-10"))["Старая A"]
    quick(client, "Старая B", day="2026-10-10")
    client.patch(f"/api/tasks/{a['id']}", json={"status": "done"})
    # текущий период 2026-10-14..2026-10-20
    t1 = by_title(quick(client, "Отчёт 1ч @Работа #срочно", day="2026-10-19"))["Отчёт"]
    quick(client, "Звонок @Работа", day="2026-10-19")
    client.post("/api/days/2026-10-19/lock")
    extra = by_title(quick(client, "Срочное", day="2026-10-19"))["Срочное"]
    for tid in (t1["id"], extra["id"]):
        client.patch(f"/api/tasks/{tid}", json={"status": "done"})
    client.patch(f"/api/tasks/{t1['id']}", json={"actual_sec": 5400})  # 1.5 ч при оценке 1 ч
    done18 = by_title(quick(client, "Вчера", day="2026-10-18"))["Вчера"]
    client.patch(f"/api/tasks/{done18['id']}", json={"status": "done"})
    quick(client, "Просрочено до 15.10", day="2026-10-14")

    r = client.get("/api/dashboard", params={"start": "2026-10-14", "end": "2026-10-20"}).json()
    k = r["kpi"]
    assert r["range"]["prev_start"] == "2026-10-07" and r["range"]["days"] == 7
    assert k["done"] == {"value": 3, "prev": 1}
    assert k["completion"]["prev"] == 0.5
    assert k["completion"]["value"] == round(2 / 4, 4)  # Отчёт, Звонок, Вчера, Просрочено — плановые
    assert k["accuracy"] == {"ratio": 1.5, "tasks": 1}
    assert k["unplanned_share"] == round(1 / 3, 4)
    assert k["overdue"] == 1
    assert len(r["daily"]) == 7
    day19 = next(d for d in r["daily"] if d["day"] == "2026-10-19")
    assert (day19["planned"], day19["planned_done"], day19["unplanned_done"]) == (2, 1, 1)
    assert r["projects"][0]["name"] == "Работа" and r["projects"][0]["done"] == 1
    assert r["tags"] == [{"tag": "срочно", "done": 1, "total": 1}]
    assert r["weekdays"][0]["done"] == 2  # понедельник 19.10

    pid = r["projects"][0]["id"]
    f = client.get("/api/dashboard", params={"start": "2026-10-14", "end": "2026-10-20", "project_id": pid}).json()
    assert f["kpi"]["done"]["value"] == 1 and f["projects"] == []
    assert client.get("/api/dashboard", params={"start": "2026-10-20", "end": "2026-10-14"}).status_code == 400


def test_projects_get_distinct_colors(client):
    quick(client, "a @Один")
    quick(client, "b @Два")
    colors = [p["color"] for p in client.get("/api/projects").json()]
    assert len(set(colors)) == 2


def test_migration_recolors_default_projects(tmp_path, monkeypatch):
    import sqlite3

    from planer import db

    monkeypatch.setenv("PLANER_DB", str(tmp_path / "old.db"))
    db.init_db()
    with sqlite3.connect(tmp_path / "old.db") as c:
        c.execute("PRAGMA user_version = 1")
        c.executemany("INSERT INTO projects(name) VALUES (?)", [("A",), ("B",), ("C",)])
    db.init_db()
    with sqlite3.connect(tmp_path / "old.db") as c:
        assert [r[0] for r in c.execute("SELECT color FROM projects ORDER BY id")] == ["#6d5efc", "#16a36a", "#e5484d"]
