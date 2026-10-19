import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest
from fastapi.testclient import TestClient

from planer.ai import client as ai_client
from planer.ai import ollama

DAY = "2026-10-19"  # понедельник


class FakeLLM:
    """OpenAI-совместимый сервер: отвечает заготовкой по ключевому слову в system-промпте."""

    def __init__(self):
        self.replies = {}
        self.requests = []
        self.status = 200
        llm = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def _send(self, code, body):
                data = json.dumps(body).encode()
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def do_GET(self):
                if self.path.endswith("/models"):
                    return self._send(200, {"data": [{"id": "model-b"}, {"id": "model-a"}]})
                self._send(404, {})

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                llm.requests.append({"headers": dict(self.headers), "body": body})
                if llm.status != 200:
                    return self._send(llm.status, {"error": {"message": "bad key"}})
                system = body["messages"][0]["content"]
                key = next((k for k in llm.replies if k in system), None)
                content = llm.replies.get(key, '{"ok": true}')
                self._send(200, {"choices": [{"message": {"content": content}}]})

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), H)
        self.url = f"http://127.0.0.1:{self.server.server_port}/v1"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()


@pytest.fixture
def llm():
    f = FakeLLM()
    yield f
    f.server.shutdown()


@pytest.fixture
def client(tmp_path, monkeypatch, llm):
    monkeypatch.setenv("PLANER_DB", str(tmp_path / "t.db"))
    from planer.app import app

    with TestClient(app) as c:
        r = c.put("/api/ai/settings", json={"provider": "custom", "base_url": llm.url, "model": "m", "api_key": "sk-secret-1234"})
        assert r.json()["configured"]
        yield c


def test_extract_json_variants():
    assert ai_client.extract_json('```json\n{"a": 1}\n```') == {"a": 1}
    assert ai_client.extract_json('<think>хм</think>{"a": 2}') == {"a": 2}
    assert ai_client.extract_json('Вот ответ: {"a": 3} — готово') == {"a": 3}
    with pytest.raises(ai_client.AIError):
        ai_client.extract_json("не json")


def test_settings_hide_key_and_presets(client):
    s = client.get("/api/ai/settings").json()
    assert "api_key" not in s and s["has_key"] and s["key_hint"] == "…1234"
    # смена провайдера на пресет подставляет адрес и модель, чужой ключ сбрасывается
    s = client.put("/api/ai/settings", json={"provider": "deepseek"}).json()
    assert s["base_url"] == "https://api.deepseek.com/v1" and s["model"] == "deepseek-chat"
    assert not s["has_key"] and not s["configured"]
    ids = [p["id"] for p in client.get("/api/ai/providers").json()]
    assert {"ollama", "deepseek", "qwen", "openai", "openrouter", "custom"} <= set(ids)


def test_models_and_test_connection(client, llm):
    assert client.post("/api/ai/models", json={}).json() == ["model-a", "model-b"]
    assert client.post("/api/ai/test", json={}).json()["ok"]
    assert llm.requests[-1]["headers"]["Authorization"] == "Bearer sk-secret-1234"
    assert llm.requests[-1]["body"]["response_format"] == {"type": "json_object"}
    llm.status = 401
    r = client.post("/api/ai/test", json={})
    assert r.status_code == 502 and "Ключ не подошёл" in r.json()["detail"]


def test_parse_normalizes_model_output(client, llm):
    client.post("/api/tasks/quick", json={"day": DAY, "text": "x @Работа"})
    llm.replies["планировщика"] = json.dumps({"tasks": [
        {"title": "Доделать отчёт", "deadline": "2026-10-23", "project": "работа", "tags": ["#Срочно"],
         "estimate_min": "90", "subtasks": [{"title": "Собрать данные"}, {"title": ""}]},
        {"title": "Позвонить маме", "deadline": "завтра", "estimate_min": 99999, "project": None},
        {"title": ""},
    ]}, ensure_ascii=False)
    items = client.post("/api/ai/parse", json={"day": DAY, "text": "надо бы к пятнице отчёт доделать"}).json()["items"]
    a, b = items
    assert (a["deadline"], a["project"], a["tags"], a["estimate_min"]) == ("2026-10-23", "Работа", ["срочно"], 90)
    assert [c["title"] for c in a["children"]] == ["Собрать данные"]
    assert (b["deadline"], b["estimate_min"]) == (None, None)
    prompt = llm.requests[-1]["body"]["messages"][1]["content"]
    assert "2026-10-23 — пятница" in prompt and "Работа" in prompt


def test_breakdown_skips_existing(client, llm):
    day = client.post("/api/tasks/quick", json={"day": DAY, "text": "Переезд"}).json()
    tid = day["tasks"][0]["id"]
    client.post("/api/tasks/quick", json={"day": DAY, "text": "Купить коробки", "parent_id": tid})
    llm.replies["разбить задачу"] = json.dumps({"steps": [
        {"title": "Купить коробки"}, {"title": "Заказать грузчиков", "estimate_min": 20}, {"title": "Упаковать книги"},
    ]}, ensure_ascii=False)
    steps = client.post(f"/api/ai/breakdown/{tid}").json()["steps"]
    assert steps == [{"title": "Заказать грузчиков", "estimate_min": 20}, {"title": "Упаковать книги", "estimate_min": None}]


def test_review_proposal_and_apply(client, llm):
    def add(text):
        d = client.post("/api/tasks/quick", json={"day": DAY, "text": text}).json()
        return next(t["id"] for t in d["tasks"] if t["title"] == text)

    report, call, gym = add("Отчёт"), add("Созвон"), add("Спортзал")
    other = client.post("/api/tasks/quick", json={"day": "2026-10-18", "text": "Чужая"}).json()["tasks"][0]["id"]
    client.patch(f"/api/days/{DAY}", json={"note": "Утро было тяжёлым."})
    llm.replies["итоги рабочего дня"] = json.dumps({
        "done": [report, other, 99999], "skipped": [gym], "carry": [call, report],
        "new_tasks": [{"title": "Починил прод", "done": True}], "note": "Отчёт сдан, созвон перенёс.",
    }, ensure_ascii=False)
    prop = client.post("/api/ai/review", json={"day": DAY, "text": "сделал отчёт, созвон на завтра, в зал не пошёл"}).json()
    assert prop["done"] == [report] and prop["skipped"] == [gym] and prop["carry"] == [call]

    day = client.post("/api/ai/review/apply", json={"day": DAY, **prop}).json()
    st = {t["title"]: t for t in day["tasks"]}
    assert st["Отчёт"]["status"] == "done" and st["Спортзал"]["status"] == "skipped" and st["Созвон"]["status"] == "moved"
    assert st["Починил прод"]["status"] == "done" and st["Починил прод"]["planned"] is False
    assert day["note"] == "Утро было тяжёлым.\n\nОтчёт сдан, созвон перенёс."
    tomorrow = client.get("/api/days/2026-10-20").json()
    assert [t["title"] for t in tomorrow["tasks"]] == ["Созвон"]
    assert client.post("/api/ai/review/apply", json={"day": DAY, "done": [other]}).status_code == 400


def test_not_configured(tmp_path, monkeypatch):
    monkeypatch.setenv("PLANER_DB", str(tmp_path / "e.db"))
    from planer.app import app

    with TestClient(app) as c:
        r = c.post("/api/ai/parse", json={"day": DAY, "text": "что-то"})
        assert r.status_code == 502 and "не настроен" in r.json()["detail"]


def test_recommend_by_ram():
    assert ollama.recommend(32, "arm64")["model"] == "qwen2.5:7b"
    assert ollama.recommend(8, "arm64")["model"] == "qwen2.5:3b"
    low = ollama.recommend(4, "arm64")
    assert not low["ok"] and low["model"] is None


def test_ollama_setup_pulls_model_when_running(client, monkeypatch):
    pulled = []

    class H(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def do_GET(self):
            body = {"version": "0.9"} if self.path == "/api/version" else {"models": [{"name": m} for m in pulled]}
            data = json.dumps(body).encode()
            self.send_response(200)
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_POST(self):
            req = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            self.send_response(200)
            self.end_headers()
            for line in ({"status": "pulling", "total": 100, "completed": 50},
                         {"status": "pulling", "total": 100, "completed": 100}, {"status": "success"}):
                self.wfile.write((json.dumps(line) + "\n").encode())
            pulled.append(req["model"])

    srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    monkeypatch.setattr(ollama, "OLLAMA_URL", f"http://127.0.0.1:{srv.server_port}")
    try:
        client.post("/api/ai/ollama/setup", params={"model": "qwen2.5:3b"})
        for _ in range(50):
            if ollama._job["state"] in ("done", "error"):
                break
            time.sleep(0.1)
        assert ollama._job["state"] == "done", ollama._job
        assert pulled == ["qwen2.5:3b"]
        s = client.get("/api/ai/settings").json()
        assert s["provider"] == "ollama" and s["model"] == "qwen2.5:3b"
    finally:
        srv.shutdown()
        ollama._job.update(state="idle")
