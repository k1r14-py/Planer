"""Подключение к языковой модели через OpenAI-совместимый API.

Один клиент на всех: OpenAI (ChatGPT), DeepSeek, Qwen (Alibaba Cloud), OpenRouter
и локальная Ollama — все принимают POST {base_url}/chat/completions.
Ответ просим в JSON (response_format json_object поддерживают все перечисленные).
"""

import json
import re
import urllib.error
import urllib.request

from ..db import tx
from ..updater import _ssl_context

OLLAMA_URL = "http://127.0.0.1:11434"

# id → описание пресета. model — значение по умолчанию; список моделей подтягивается из /models.
PROVIDERS = {
    "ollama": {
        "name": "На этом компьютере (Ollama)",
        "hint": "Бесплатно и приватно: модель работает на вашем компьютере. Нужно 8 ГБ памяти и 3–6 ГБ на диске.",
        "base_url": f"{OLLAMA_URL}/v1",
        "model": "qwen2.5:7b",
        "needs_key": False,
        "key_url": None,
    },
    "deepseek": {
        "name": "DeepSeek",
        "hint": "Недорого, хорошо понимает русский. Нужен API-ключ.",
        "base_url": "https://api.deepseek.com/v1",
        "model": "deepseek-chat",
        "needs_key": True,
        "key_url": "https://platform.deepseek.com/api_keys",
    },
    "qwen": {
        "name": "Qwen (Alibaba Cloud)",
        "hint": "Модели Qwen через Alibaba Cloud Model Studio. Нужен API-ключ.",
        "base_url": "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
        "model": "qwen-plus",
        "needs_key": True,
        "key_url": "https://modelstudio.console.alibabacloud.com/",
    },
    "openai": {
        "name": "ChatGPT (OpenAI)",
        "hint": "Модели OpenAI. Нужен API-ключ (это не подписка ChatGPT Plus — оплата отдельная).",
        "base_url": "https://api.openai.com/v1",
        "model": "gpt-4o-mini",
        "needs_key": True,
        "key_url": "https://platform.openai.com/api-keys",
    },
    "openrouter": {
        "name": "OpenRouter",
        "hint": "Один ключ — сотни моделей: Claude, Gemini, Llama, DeepSeek, Qwen и другие.",
        "base_url": "https://openrouter.ai/api/v1",
        "model": "deepseek/deepseek-chat",
        "needs_key": True,
        "key_url": "https://openrouter.ai/keys",
    },
    "custom": {
        "name": "Другой (OpenAI-совместимый)",
        "hint": "Любой сервис или локальный сервер с OpenAI-совместимым API (LM Studio, vLLM, корпоративный шлюз).",
        "base_url": "",
        "model": "",
        "needs_key": False,
        "key_url": None,
    },
}

DEFAULTS = {"provider": "", "base_url": "", "model": "", "api_key": ""}


class AIError(Exception):
    pass


# ---------- настройки ----------


def load_settings() -> dict:
    with tx() as conn:
        rows = conn.execute("SELECT key, value FROM settings WHERE key LIKE 'ai.%'").fetchall()
    cfg = dict(DEFAULTS)
    for r in rows:
        cfg[r["key"][3:]] = r["value"]
    return cfg


def save_settings(patch: dict) -> dict:
    cfg = {**load_settings(), **{k: v for k, v in patch.items() if k in DEFAULTS and v is not None}}
    if cfg["provider"] in PROVIDERS and cfg["provider"] != "custom":
        preset = PROVIDERS[cfg["provider"]]
        cfg["base_url"] = cfg["base_url"] or preset["base_url"]
        cfg["model"] = cfg["model"] or preset["model"]
    with tx() as conn:
        conn.executemany(
            "INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [(f"ai.{k}", str(v)) for k, v in cfg.items()],
        )
    return cfg


def public_settings(cfg: dict) -> dict:
    """Настройки для интерфейса — ключ не отдаём целиком."""
    key = cfg.get("api_key", "")
    return {
        **{k: v for k, v in cfg.items() if k != "api_key"},
        "has_key": bool(key),
        "key_hint": f"…{key[-4:]}" if len(key) > 8 else ("задан" if key else ""),
        "configured": is_configured(cfg),
    }


def is_configured(cfg: dict | None = None) -> bool:
    cfg = cfg or load_settings()
    if not cfg["provider"] or not cfg["base_url"] or not cfg["model"]:
        return False
    preset = PROVIDERS.get(cfg["provider"], {})
    return bool(cfg["api_key"]) or not preset.get("needs_key")


# ---------- HTTP ----------


def _request(cfg: dict, path: str, body: dict | None = None, timeout: float = 120) -> dict:
    url = cfg["base_url"].rstrip("/") + path
    headers = {"Content-Type": "application/json", "User-Agent": "Planer"}
    if cfg.get("api_key"):
        headers["Authorization"] = f"Bearer {cfg['api_key']}"
    if cfg.get("provider") == "openrouter":
        headers["X-Title"] = "Planer"
    req = urllib.request.Request(
        url, data=json.dumps(body).encode() if body is not None else None, headers=headers,
        method="POST" if body is not None else "GET",
    )
    try:
        ctx = _ssl_context() if url.startswith("https") else None
        with urllib.request.urlopen(req, timeout=timeout, context=ctx) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        detail = ""
        try:
            data = json.loads(e.read().decode())
            detail = (data.get("error") or {}).get("message") if isinstance(data.get("error"), dict) else data.get("error") or ""
        except Exception:
            pass
        if e.code == 401:
            raise AIError("Ключ не подошёл (401). Проверьте API-ключ.")
        if e.code == 402:
            raise AIError("На счёте сервиса закончились деньги (402).")
        if e.code == 404:
            raise AIError(f"Модель или адрес не найдены (404). {detail}".strip())
        if e.code == 429:
            raise AIError("Слишком много запросов или исчерпан лимит (429). Попробуйте позже.")
        raise AIError(f"Сервис ответил ошибкой {e.code}. {detail}".strip())
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        reason = getattr(e, "reason", e)
        if cfg.get("provider") == "ollama":
            raise AIError("Ollama не отвечает. Запустите её или нажмите «Установить и настроить» в настройках ИИ.")
        raise AIError(f"Нет связи с сервисом: {reason}")


def list_models(cfg: dict | None = None) -> list[str]:
    cfg = cfg or load_settings()
    data = _request(cfg, "/models", timeout=20)
    return sorted(m["id"] for m in data.get("data", []) if m.get("id"))


_FENCE = re.compile(r"^```(?:json)?\s*|\s*```$", re.MULTILINE)
_THINK = re.compile(r"<think>.*?</think>", re.DOTALL)


def extract_json(text: str) -> dict:
    """JSON из ответа модели: убираем «рассуждения» и обёртку ```json … ```."""
    text = _THINK.sub("", text or "").strip()
    text = _FENCE.sub("", text).strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        # модель иногда пишет текст вокруг — берём первый {...} блок
        start, end = text.find("{"), text.rfind("}")
        if start != -1 and end > start:
            try:
                return json.loads(text[start:end + 1])
            except json.JSONDecodeError:
                pass
    raise AIError("Модель ответила не в формате JSON — попробуйте ещё раз или выберите другую модель.")


def chat_json(system: str, user: str, cfg: dict | None = None, timeout: float = 120) -> dict:
    cfg = cfg or load_settings()
    if not is_configured(cfg):
        raise AIError("ИИ не настроен — откройте настройки ИИ.")
    body = {
        "model": cfg["model"],
        "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
        "temperature": 0.2,
        "response_format": {"type": "json_object"},
    }
    data = _request(cfg, "/chat/completions", body, timeout=timeout)
    try:
        content = data["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError):
        raise AIError("Неожиданный ответ сервиса.")
    return extract_json(content)


def test_connection(cfg: dict) -> dict:
    """Короткий запрос к модели — проверка ключа, адреса и модели."""
    reply = chat_json(
        'Ответь JSON-объектом {"ok": true}. Только JSON.',
        "Проверка связи. Верни {\"ok\": true}.",
        cfg,
        timeout=60,
    )
    return {"ok": bool(reply.get("ok", True)), "model": cfg["model"]}
