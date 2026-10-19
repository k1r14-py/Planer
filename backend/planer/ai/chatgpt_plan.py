"""ChatGPT по подписке: «Sign in with ChatGPT» с расходом из лимитов плана Plus/Pro.

Официальный путь OpenAI для open-source приложений, работающих на компьютере пользователя
(https://developers.openai.com/siwc/token-sharing-open-source/). Протокол сверен с библиотекой
chatgpt-plan-auth (порт кода Home Assistant). Только стандартная библиотека.

  1. Вход: страница авторизации OpenAI в браузере → возврат на наш приёмник
     http://127.0.0.1:<порт>/auth/callback → обмен кода на токены (PKCE S256).
     Первый вход регистрирует приложение (client_id=dynamic_agent_client), OpenAI выдаёт
     свой client_id (oaiapp_…) — его храним и переиспользуем.
  2. Запросы: Responses API с токеном доступа; маршрут подписки требует store=false и
     stream=true и не принимает часть параметров (temperature, max_output_tokens…).
  3. Токен доступа живёт час — обновляем заранее; обновляющий токен ротируется при каждом обновлении.
"""

import base64
import hashlib
import json
import logging
import secrets
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from ..db import tx
from ..updater import _ssl_context
from .client import AIError

AUTHORIZE_URL = "https://auth.openai.com/api/accounts/authorize"
TOKEN_URL = "https://auth.openai.com/api/accounts/oauth/token"
ISSUER = "https://auth.openai.com"
RESOURCE = "https://api.openai.com/v1"
RESPONSES_URL = "https://api.openai.com/v1/responses"
MODELS_URL = "https://api.openai.com/v1/models"

DYNAMIC_AGENT_CLIENT = "dynamic_agent_client"
AGENT_NAME = "Planer"
SCOPE = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct"
PLAN_SCOPE = "chatgpt.tokens.use.direct"
CALLBACK_PATH = "/auth/callback"
LOGIN_TIMEOUT = 15 * 60
REFRESH_MARGIN = 5 * 60

# если каталог моделей недоступен (бывает), предлагаем модели, замеченные у планов ChatGPT
MODEL_SUGGESTIONS = ["gpt-5.5", "gpt-5.6-luna", "gpt-5.6-terra", "gpt-6-luna", "gpt-6-sol"]

FATAL_REFRESH_ERRORS = {
    "invalid_grant", "invalid_client", "invalid_refresh_token", "refresh_token_expired",
    "refresh_token_invalidated", "refresh_token_reused", "token_expired",
}

ERROR_HINTS = {
    "subscription_sharing_user_not_eligible":
        "Этот аккаунт ChatGPT не может использовать подписку в сторонних приложениях — нужен план Plus или Pro.",
    "subscription_sharing_usage_limit_exceeded":
        "Лимит подписки ChatGPT исчерпан. Остаток и время сброса видно в настройках ChatGPT.",
    "subscription_sharing_usage_unavailable": "Подписка ChatGPT сейчас недоступна — попробуйте позже.",
    "subscription_sharing_route_not_supported": "Этот запрос нельзя выполнить по подписке ChatGPT.",
    "subscription_sharing_unsupported_capability": "Эта возможность недоступна по подписке ChatGPT.",
    "subscription_sharing_invalid_user": "Вход в ChatGPT больше недействителен — войдите заново.",
}

CREDS_KEY = "chatgpt.credentials"
HOST_KEY = "chatgpt.host_id"
CLIENT_KEY = "chatgpt.client_id"

log = logging.getLogger("uvicorn.error.planer.chatgpt")


class SignInRequired(AIError):
    """Вход недействителен — нужно войти в ChatGPT заново."""


class APIError(AIError):
    def __init__(self, message: str, status: int):
        super().__init__(message)
        self.status = status


# ---------- хранение ----------


def _get(key: str) -> str | None:
    with tx() as conn:
        row = conn.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
    return row["value"] if row else None


def _put(key: str, value: str | None) -> None:
    with tx() as conn:
        if value is None:
            conn.execute("DELETE FROM settings WHERE key = ?", (key,))
        else:
            conn.execute(
                "INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                (key, value),
            )


def host_id() -> str:
    """Постоянный идентификатор этой установки (не аккаунта) — создаётся один раз."""
    value = _get(HOST_KEY)
    if not value:
        value = f"urn:uuid:{uuid.uuid4()}"
        _put(HOST_KEY, value)
    return value


def load_credentials() -> dict | None:
    raw = _get(CREDS_KEY)
    return json.loads(raw) if raw else None


def save_credentials(creds: dict) -> None:
    _put(CREDS_KEY, json.dumps(creds))
    _put(CLIENT_KEY, creds["client_id"])


def sign_out() -> None:
    _put(CREDS_KEY, None)


def account() -> dict | None:
    creds = load_credentials()
    if not creds:
        return None
    return {"email": creds.get("email"), "plan_scope": PLAN_SCOPE in creds.get("scopes", [])}


# ---------- HTTP ----------


def _post_form(url: str, data: dict) -> tuple[int, dict]:
    req = urllib.request.Request(
        url, data=urllib.parse.urlencode(data).encode(),
        headers={"Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json", "User-Agent": "Planer"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=30, context=_ssl_context() if url.startswith("https") else None) as r:
            return r.status, json.load(r)
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode() or "{}")
        except ValueError:
            return e.code, {}
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        raise AIError(f"Нет связи с OpenAI: {getattr(e, 'reason', e)}")


def _error_code(body: dict) -> str | None:
    err = body.get("error")
    if isinstance(err, dict):
        return err.get("code") or err.get("type")
    if isinstance(err, str):
        return err
    return body.get("code")


def _error_message(body: dict) -> str:
    err = body.get("error")
    if isinstance(err, dict) and err.get("message"):
        return err["message"]
    return body.get("error_description") or ""


def _jwt_claims(token: str) -> dict:
    """Утверждения ID-токена. Подпись не проверяем: токен пришёл напрямую с TLS-эндпоинта OpenAI
    в том же ответе, что и обмен кода (та же модель доверия, что у Home Assistant)."""
    parts = token.split(".")
    if len(parts) != 3:
        raise AIError("Неверный ID-токен")
    payload = parts[1] + "=" * (-len(parts[1]) % 4)
    try:
        return json.loads(base64.urlsafe_b64decode(payload))
    except ValueError:
        raise AIError("Неверный ID-токен")


def _creds_from_token(token: dict, client_id: str, previous: dict | None = None, **extra) -> dict:
    prev = previous or {}
    scopes = str(token.get("scope", "")).split() or prev.get("scopes", [])
    return {
        "client_id": client_id,
        "access_token": token["access_token"],
        "refresh_token": token.get("refresh_token") or prev.get("refresh_token", ""),
        "id_token": token.get("id_token") or prev.get("id_token", ""),
        "expires_at": time.time() + int(token.get("expires_in") or 3600),
        "earliest_refresh_at": _iso_to_ts(token.get("earliest_refresh_at")),
        "scopes": scopes,
        "email": extra.get("email", prev.get("email")),
        "sub": extra.get("sub", prev.get("sub")),
    }


def _iso_to_ts(value) -> float | None:
    if not value or not isinstance(value, str):
        return None
    from datetime import datetime

    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


# ---------- вход ----------

_login = {"state": "idle", "message": "", "url": None}
_login_lock = threading.Lock()
_server: ThreadingHTTPServer | None = None


def login_status() -> dict:
    return {**{k: v for k, v in _login.items() if not k.startswith("_")}, "account": account()}


def _finish_page(ok: bool, text: str) -> bytes:
    color = "#16a36a" if ok else "#e5484d"
    return f"""<!doctype html><html lang="ru"><meta charset="utf-8"><title>Planer</title>
<body style="font-family:system-ui,-apple-system,sans-serif;display:grid;place-items:center;height:100vh;margin:0;background:#f5f5f8">
<div style="text-align:center;max-width:420px;padding:24px"><div style="font-size:40px;color:{color}">{'✓' if ok else '✕'}</div>
<h2 style="margin:8px 0">{'Готово' if ok else 'Не получилось'}</h2><p style="color:#5d5d6c">{text}</p></div></body></html>""".encode()


def start_login() -> dict:
    """Готовит вход: PKCE, state, nonce, приёмник на 127.0.0.1 — и возвращает адрес страницы входа."""
    global _server
    with _login_lock:
        _stop_server()
        verifier = secrets.token_urlsafe(64)
        challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip("=")
        state, nonce = secrets.token_urlsafe(32), secrets.token_urlsafe(32)
        stored_client = _get(CLIENT_KEY)
        client_id = stored_client or DYNAMIC_AGENT_CLIENT

        server = ThreadingHTTPServer(("127.0.0.1", 0), _CallbackHandler)
        redirect_uri = f"http://127.0.0.1:{server.server_port}{CALLBACK_PATH}"
        params = {
            "response_type": "code",
            "client_id": client_id,
            "redirect_uri": redirect_uri,
            "scope": SCOPE,
            "resource": RESOURCE,
            "state": state,
            "nonce": nonce,
            "code_challenge": challenge,
            "code_challenge_method": "S256",
            "ext_agent_host_id": host_id(),
        }
        if not stored_client:
            params["agent_name_hint"] = AGENT_NAME  # только при первой регистрации
        url = f"{AUTHORIZE_URL}?{urllib.parse.urlencode(params)}"

        _login.update(state="waiting", message="Ждём входа в браузере…", url=url, _attempt={
            "state": state, "nonce": nonce, "verifier": verifier, "redirect_uri": redirect_uri,
            "client_id": client_id, "started": time.time(),
        })
        _server = server
        threading.Thread(target=server.serve_forever, daemon=True).start()
        timer = threading.Timer(LOGIN_TIMEOUT, _expire, args=(state,))
        timer.daemon = True
        timer.start()
        return login_status()


def _expire(state: str) -> None:
    with _login_lock:
        attempt = _login.get("_attempt") or {}
        if _login["state"] == "waiting" and attempt.get("state") == state:
            _login.update(state="error", message="Время на вход истекло — попробуйте ещё раз.")
            _stop_server()


def _stop_server() -> None:
    global _server
    if _server is not None:
        srv, _server = _server, None
        threading.Thread(target=srv.shutdown, daemon=True).start()


def complete_login(query: dict) -> tuple[bool, str]:
    """Обработка возврата из браузера: проверка state, обмен кода, проверка ID-токена и прав."""
    attempt = _login.get("_attempt")
    if not attempt or _login["state"] != "waiting":
        return False, "Вход не ожидался — начните его из Planer."
    if query.get("state") != attempt["state"]:
        return False, "Ответ не совпал с запросом входа — начните вход заново."
    if query.get("error"):
        reason = query.get("error_description") or query["error"]
        _login.update(state="error", message=f"Вход отменён: {reason}")
        return False, f"Вход отменён: {reason}"
    code = query.get("code")
    if not code:
        return False, "В ответе нет кода входа."

    client_id = query.get("client_id") or attempt["client_id"]
    if client_id == DYNAMIC_AGENT_CLIENT:
        _login.update(state="error", message="OpenAI не выдал идентификатор приложения — попробуйте ещё раз.")
        return False, _login["message"]
    status, token = _post_form(TOKEN_URL, {
        "grant_type": "authorization_code",
        "client_id": client_id,
        "code": code,
        "code_verifier": attempt["verifier"],
        "redirect_uri": attempt["redirect_uri"],
        "resource": RESOURCE,
    })
    if status != 200 or "access_token" not in token:
        msg = f"OpenAI не выдал доступ ({_error_code(token) or status}). {_error_message(token)}".strip()
        _login.update(state="error", message=msg)
        return False, msg

    email = sub = None
    if token.get("id_token"):
        claims = _jwt_claims(token["id_token"])
        aud = claims.get("aud")
        auds = [aud] if isinstance(aud, str) else list(aud or [])
        if claims.get("iss") != ISSUER or client_id not in auds or claims.get("nonce") != attempt["nonce"] \
                or float(claims.get("exp") or 0) <= time.time():
            _login.update(state="error", message="Ответ OpenAI не прошёл проверку — попробуйте ещё раз.")
            return False, _login["message"]
        email, sub = claims.get("email"), claims.get("sub")

    creds = _creds_from_token(token, client_id, email=email, sub=sub)
    save_credentials(creds)
    if PLAN_SCOPE not in creds["scopes"]:
        msg = ("Вход выполнен, но разрешение «использовать мою подписку» не дано. "
               "Войдите ещё раз и отметьте использование плана ChatGPT.")
        _login.update(state="error", message=msg)
        return False, msg
    _login.update(state="done", message=f"Вы вошли как {email or 'пользователь ChatGPT'}.")
    return True, "Можно закрыть эту вкладку и вернуться в Planer."


class _CallbackHandler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):  # noqa: N802
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path != CALLBACK_PATH:
            self.send_response(404)
            self.end_headers()
            return
        query = dict(urllib.parse.parse_qsl(parsed.query))
        try:
            ok, text = complete_login(query)
        except Exception as e:  # noqa: BLE001 — любую ошибку показываем в браузере и в Planer
            log.exception("Вход в ChatGPT не удался")
            ok, text = False, f"Ошибка: {e}"
            _login.update(state="error", message=text)
        body = _finish_page(ok, text)
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
        if ok or _login["state"] == "error":
            _stop_server()


# ---------- токены ----------

_token_lock = threading.Lock()


def _refresh(creds: dict) -> dict:
    status, token = _post_form(TOKEN_URL, {
        "grant_type": "refresh_token",
        "client_id": creds["client_id"],
        "refresh_token": creds["refresh_token"],
        "resource": RESOURCE,
    })
    if status != 200 or "access_token" not in token:
        code = _error_code(token)
        if code in FATAL_REFRESH_ERRORS:
            sign_out()
            raise SignInRequired("Вход в ChatGPT истёк — войдите заново в настройках ИИ.")
        raise AIError(f"Не удалось обновить вход в ChatGPT ({code or status}).")
    new = _creds_from_token(token, creds["client_id"], previous=creds)
    save_credentials(new)
    return new


def access_token(force_refresh: bool = False) -> str:
    with _token_lock:
        creds = load_credentials()
        if not creds:
            raise SignInRequired("Войдите в ChatGPT в настройках ИИ.")
        now = time.time()
        too_early = creds.get("earliest_refresh_at") and now < creds["earliest_refresh_at"]
        if (force_refresh or now >= creds["expires_at"] - REFRESH_MARGIN) and not too_early:
            creds = _refresh(creds)
        return creds["access_token"]


# ---------- модели и запросы ----------


def _api_request(method: str, url: str, body: dict | None, token: str, timeout: float):
    req = urllib.request.Request(
        url, data=json.dumps(body).encode() if body is not None else None, method=method,
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json",
                 "Accept": "text/event-stream" if body is not None else "application/json", "User-Agent": "Planer"},
    )
    return urllib.request.urlopen(req, timeout=timeout, context=_ssl_context() if url.startswith("https") else None)


def _call(method: str, url: str, body: dict | None, timeout: float = 120):
    """Запрос с токеном; на 401 — одно обновление токена и повтор."""
    for attempt in (0, 1):
        try:
            return _api_request(method, url, body, access_token(force_refresh=attempt == 1), timeout)
        except urllib.error.HTTPError as e:
            if e.code == 401 and attempt == 0:
                continue
            try:
                data = json.loads(e.read().decode() or "{}")
            except ValueError:
                data = {}
            code = _error_code(data)
            if code in ERROR_HINTS:
                raise AIError(ERROR_HINTS[code])
            if e.code == 401:
                raise SignInRequired(ERROR_HINTS["subscription_sharing_invalid_user"])
            raise APIError(f"OpenAI ответил ошибкой {e.code}. {_error_message(data)}".strip(), e.code)
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            raise AIError(f"Нет связи с OpenAI: {getattr(e, 'reason', e)}")
    raise AIError("Не удалось выполнить запрос к OpenAI.")


def list_models() -> list[str]:
    """Каталог моделей плана: нестандартный ответ {"models": [{"slug": …}]}."""
    try:
        with _call("GET", MODELS_URL, None, timeout=30) as r:
            data = json.load(r)
    except SignInRequired:
        raise
    except AIError:
        return list(MODEL_SUGGESTIONS)
    models = [m["slug"] for m in data.get("models", []) if isinstance(m, dict) and isinstance(m.get("slug"), str)]
    return models or list(MODEL_SUGGESTIONS)


def _read_stream(resp) -> str:
    """Собирает текст из потока событий Responses API (SSE)."""
    parts: list[str] = []
    final: str | None = None
    for raw in resp:
        line = raw.decode("utf-8", "replace").strip()
        if not line.startswith("data:"):
            continue
        payload = line[5:].strip()
        if not payload or payload == "[DONE]":
            continue
        try:
            event = json.loads(payload)
        except ValueError:
            continue
        kind = event.get("type", "")
        if kind == "response.output_text.delta":
            parts.append(event.get("delta", ""))
        elif kind == "response.output_text.done" and isinstance(event.get("text"), str):
            final = event["text"]
        elif kind in ("response.failed", "error", "response.error"):
            err = event.get("error") or (event.get("response") or {}).get("error") or {}
            code = err.get("code") if isinstance(err, dict) else None
            raise AIError(ERROR_HINTS.get(code) or f"OpenAI: {(err or {}).get('message') or code or 'ошибка'}")
        elif kind == "response.incomplete":
            reason = ((event.get("response") or {}).get("incomplete_details") or {}).get("reason")
            raise AIError(f"Ответ модели оборвался ({reason or 'без причины'}).")
    return final if final is not None else "".join(parts)


def chat_text(system: str, user: str, model: str, timeout: float = 120) -> str:
    body = {
        "model": model,
        "instructions": system,  # маршрут подписки не принимает system-сообщения во входе
        "input": [{"role": "user", "content": [{"type": "input_text", "text": user}]}],
        "store": False,
        "stream": True,
        "text": {"format": {"type": "json_object"}},
    }
    try:
        with _call("POST", RESPONSES_URL, body, timeout) as r:
            return _read_stream(r)
    except APIError as e:
        # формат json_object мог не поддерживаться маршрутом — повторяем без него (JSON всё равно просим в подсказке)
        if e.status != 400 or "format" not in str(e).lower():
            raise
    body.pop("text")
    with _call("POST", RESPONSES_URL, body, timeout) as r:
        return _read_stream(r)
