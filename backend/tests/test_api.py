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
    monkeypatch.setattr(speech, "transcribe", lambda data, suffix: "Купить хлеб. Подзадача батон")
    r = client.post("/api/voice/transcribe", files={"audio": ("rec.webm", b"fake", "audio/webm")})
    assert r.status_code == 200, r.text
    assert r.json()["items"][0]["children"][0]["title"] == "Батон"


def test_transcribe_unavailable(client, monkeypatch):
    from planer import speech

    monkeypatch.setattr(speech, "available", lambda: False)
    r = client.post("/api/voice/transcribe", files={"audio": ("rec.webm", b"x", "audio/webm")})
    assert r.status_code == 503


def test_health(client):
    assert client.get("/api/health").json() == {"ok": True, "app": "planer"}
