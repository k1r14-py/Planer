"""ChatGPT по подписке: вход, обновление токена и запросы — против имитации серверов OpenAI."""

import base64
import json
import threading
import time
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest
from fastapi.testclient import TestClient

from planer.ai import chatgpt_plan as cg

CLIENT_ID = "oaiapp_test"


def _jwt(claims: dict) -> str:
    enc = lambda d: base64.urlsafe_b64encode(json.dumps(d).encode()).decode().rstrip("=")  # noqa: E731
    return f"{enc({'alg': 'none'})}.{enc(claims)}.sig"


class FakeOpenAI:
    """Токен-эндпоинт, каталог моделей и Responses API (SSE)."""

    def __init__(self):
        self.token_requests = []
        self.api_requests = []
        self.scope = cg.SCOPE
        self.refresh_error = None
        self.unauthorized_once = False
        self.responses_error = None  # (status, body) для следующего запроса
        self.reply = '{"ok": true}'
        self.nonce = None
        self.n = 0
        fake = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def _json(self, code, body):
                data = json.dumps(body).encode()
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def _auth_ok(self):
                if fake.unauthorized_once:
                    fake.unauthorized_once = False
                    self._json(401, {"error": {"message": "expired"}})
                    return False
                return True

            def do_GET(self):
                fake.api_requests.append({"path": self.path, "auth": self.headers.get("Authorization")})
                if self.path == "/v1/models" and self._auth_ok():
                    self._json(200, {"models": [{"slug": "gpt-plan-a"}, {"slug": "gpt-plan-b"}, {"id": "x"}]})

            def do_POST(self):
                raw = self.rfile.read(int(self.headers["Content-Length"]))
                if self.path == "/token":
                    form = dict(urllib.parse.parse_qsl(raw.decode()))
                    fake.token_requests.append(form)
                    if form["grant_type"] == "refresh_token" and fake.refresh_error:
                        return self._json(400, {"error": fake.refresh_error})
                    fake.n += 1
                    return self._json(200, {
                        "access_token": f"at-{fake.n}", "refresh_token": f"rt-{fake.n}", "expires_in": 3600,
                        "scope": fake.scope,
                        "id_token": _jwt({"iss": cg.ISSUER, "aud": [form["client_id"]], "nonce": fake.nonce,
                                          "exp": time.time() + 600, "email": "me@example.com", "sub": "u1"}),
                    })
                body = json.loads(raw)
                fake.api_requests.append({"path": self.path, "auth": self.headers.get("Authorization"), "body": body})
                if not self._auth_ok():
                    return
                if fake.responses_error:
                    status, err = fake.responses_error
                    fake.responses_error = None
                    return self._json(status, err)
                half = len(fake.reply) // 2
                events = [
                    {"type": "response.created"},
                    {"type": "response.output_text.delta", "delta": fake.reply[:half]},
                    {"type": "response.output_text.delta", "delta": fake.reply[half:]},
                    {"type": "response.completed"},
                ]
                data = "".join(f"event: {e['type']}\ndata: {json.dumps(e)}\n\n" for e in events).encode()
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), H)
        self.base = f"http://127.0.0.1:{self.server.server_port}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()


@pytest.fixture
def fake(monkeypatch):
    f = FakeOpenAI()
    monkeypatch.setattr(cg, "TOKEN_URL", f.base + "/token")
    monkeypatch.setattr(cg, "MODELS_URL", f.base + "/v1/models")
    monkeypatch.setattr(cg, "RESPONSES_URL", f.base + "/v1/responses")
    yield f
    f.server.shutdown()


@pytest.fixture
def client(tmp_path, monkeypatch, fake):
    monkeypatch.setenv("PLANER_DB", str(tmp_path / "t.db"))
    from planer.app import app

    with TestClient(app) as c:
        yield c


def _login(client, fake, client_id=CLIENT_ID):
    st = client.post("/api/ai/chatgpt/login").json()
    assert st["state"] == "waiting"
    q = dict(urllib.parse.parse_qsl(urllib.parse.urlparse(st["url"]).query))
    fake.nonce = q["nonce"]
    back = {"code": "c1", "state": q["state"], "client_id": client_id}
    with urllib.request.urlopen(f"{q['redirect_uri']}?{urllib.parse.urlencode(back)}") as r:
        page = r.read().decode()
    return q, page


def test_login_flow_and_requests(client, fake):
    q, page = _login(client, fake)
    assert q["client_id"] == cg.DYNAMIC_AGENT_CLIENT and q["agent_name_hint"] == "Planer"
    assert q["code_challenge_method"] == "S256" and q["resource"] == cg.RESOURCE
    assert q["ext_agent_host_id"].startswith("urn:uuid:")
    assert "Готово" in page
    st = client.get("/api/ai/chatgpt/status").json()
    assert st["state"] == "done" and st["account"] == {"email": "me@example.com", "plan_scope": True}
    tok = fake.token_requests[-1]
    assert tok["grant_type"] == "authorization_code" and tok["client_id"] == CLIENT_ID and tok["code_verifier"]

    # модели плана и сохранение провайдера
    assert client.post("/api/ai/models", json={"provider": "chatgpt"}).json() == ["gpt-plan-a", "gpt-plan-b"]
    s = client.put("/api/ai/settings", json={"provider": "chatgpt", "model": "gpt-plan-a"}).json()
    assert s["configured"]

    fake.reply = json.dumps({"tasks": [{"title": "Позвонить маме"}]}, ensure_ascii=False)
    items = client.post("/api/ai/parse", json={"day": "2026-10-19", "text": "маме позвонить"}).json()["items"]
    assert [i["title"] for i in items] == ["Позвонить маме"]
    body = fake.api_requests[-1]["body"]
    assert body["store"] is False and body["stream"] is True and body["model"] == "gpt-plan-a"
    assert body["instructions"] and body["input"][0]["content"][0]["type"] == "input_text"
    assert fake.api_requests[-1]["auth"] == "Bearer at-1"

    # повторный вход переиспользует выданный client_id и не шлёт имя приложения
    q2, _ = _login(client, fake)
    assert q2["client_id"] == CLIENT_ID and "agent_name_hint" not in q2


def test_login_without_plan_permission(client, fake):
    fake.scope = "openid profile email offline_access"
    _, page = _login(client, fake)
    assert "Не получилось" in page
    st = client.get("/api/ai/chatgpt/status").json()
    assert st["state"] == "error" and not st["account"]["plan_scope"]
    s = client.put("/api/ai/settings", json={"provider": "chatgpt", "model": "gpt-plan-a"}).json()
    assert not s["configured"]


def test_callback_rejects_wrong_state(client, fake):
    st = client.post("/api/ai/chatgpt/login").json()
    q = dict(urllib.parse.parse_qsl(urllib.parse.urlparse(st["url"]).query))
    back = {"code": "c1", "state": "чужой", "client_id": CLIENT_ID}
    with urllib.request.urlopen(f"{q['redirect_uri']}?{urllib.parse.urlencode(back)}") as r:
        assert "Не получилось" in r.read().decode()
    assert not fake.token_requests and client.get("/api/ai/chatgpt/status").json()["state"] == "waiting"


def test_refresh_retry_and_errors(client, fake):
    _login(client, fake)
    client.put("/api/ai/settings", json={"provider": "chatgpt", "model": "gpt-plan-a"})

    # 401 → обновление токена и повтор
    fake.unauthorized_once = True
    assert client.post("/api/ai/test", json={}).json()["ok"]
    assert fake.token_requests[-1]["grant_type"] == "refresh_token"
    assert fake.token_requests[-1]["refresh_token"] == "rt-1"
    assert fake.api_requests[-1]["auth"] == "Bearer at-2"

    # понятная ошибка лимита подписки
    fake.responses_error = (429, {"error": {"code": "subscription_sharing_usage_limit_exceeded", "message": "x"}})
    r = client.post("/api/ai/test", json={})
    assert r.status_code == 502 and "Лимит подписки" in r.json()["detail"]

    # формат json_object не принят — повтор без него
    fake.responses_error = (400, {"error": {"message": "Unsupported parameter: text.format"}})
    assert client.post("/api/ai/test", json={}).json()["ok"]
    assert "text" not in fake.api_requests[-1]["body"]

    # обновляющий токен отозван — выходим из аккаунта
    creds = cg.load_credentials()
    creds["expires_at"] = time.time()
    cg.save_credentials(creds)
    fake.refresh_error = "invalid_grant"
    r = client.post("/api/ai/test", json={})
    assert r.status_code == 502 and "войдите заново" in r.json()["detail"]
    assert client.get("/api/ai/chatgpt/status").json()["account"] is None
    assert not client.get("/api/ai/settings").json()["configured"]


def test_logout(client, fake):
    _login(client, fake)
    assert client.post("/api/ai/chatgpt/logout").json()["account"] is None
    r = client.post("/api/ai/models", json={"provider": "chatgpt"})
    assert r.status_code == 502


def test_read_stream_variants():
    lines = lambda *evs: [f"data: {json.dumps(e)}\n".encode() for e in evs]  # noqa: E731
    assert cg._read_stream(lines({"type": "response.output_text.done", "text": "целиком"})) == "целиком"
    with pytest.raises(cg.AIError, match="оборвался"):
        cg._read_stream(lines({"type": "response.incomplete", "response": {"incomplete_details": {"reason": "max"}}}))
    with pytest.raises(cg.AIError, match="Лимит"):
        cg._read_stream(lines({"type": "response.failed",
                               "response": {"error": {"code": "subscription_sharing_usage_limit_exceeded"}}}))
