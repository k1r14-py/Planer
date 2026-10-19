"""Автоустановка локальной модели: Ollama + подходящая под железо модель.

Шаги (фоновая задача с прогрессом):
  1. Ollama уже отвечает? — пропускаем установку.
  2. Установлена, но не запущена — запускаем.
  3. Нет — скачиваем и ставим без прав администратора:
     macOS — Ollama.app в ~/Applications; Windows — тихий установщик для текущего пользователя.
  4. Скачиваем модель (POST /api/pull, потоковый прогресс).
"""

import ctypes
import json
import os
import platform
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

from ..updater import _ssl_context
from .client import OLLAMA_URL, save_settings

MAC_URL = "https://ollama.com/download/Ollama-darwin.zip"
WIN_URL = "https://ollama.com/download/OllamaSetup.exe"

# модели по объёму памяти: (минимум ГБ ОЗУ, модель, размер для пользователя)
MODELS = [
    (14, "qwen2.5:7b", "4,7 ГБ"),
    (7, "qwen2.5:3b", "1,9 ГБ"),
]


# ---------- окружение ----------


def ram_gb() -> float | None:
    try:
        if sys.platform == "darwin":
            out = subprocess.run(["sysctl", "-n", "hw.memsize"], capture_output=True, text=True, timeout=5)
            return int(out.stdout.strip()) / 2**30
        if sys.platform.startswith("linux"):
            with open("/proc/meminfo") as f:
                for line in f:
                    if line.startswith("MemTotal:"):
                        return int(line.split()[1]) / 2**20
        if sys.platform == "win32":
            class MemStatus(ctypes.Structure):
                _fields_ = [("dwLength", ctypes.c_ulong), ("dwMemoryLoad", ctypes.c_ulong),
                            ("ullTotalPhys", ctypes.c_ulonglong), ("ullAvailPhys", ctypes.c_ulonglong),
                            ("ullTotalPageFile", ctypes.c_ulonglong), ("ullAvailPageFile", ctypes.c_ulonglong),
                            ("ullTotalVirtual", ctypes.c_ulonglong), ("ullAvailVirtual", ctypes.c_ulonglong),
                            ("ullAvailExtendedVirtual", ctypes.c_ulonglong)]
            st = MemStatus()
            st.dwLength = ctypes.sizeof(MemStatus)
            ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(st))  # type: ignore[attr-defined]
            return st.ullTotalPhys / 2**30
    except Exception:
        return None
    return None


def recommend(ram: float | None, machine: str | None = None) -> dict:
    """Модель под железо. На Intel-Маке и при малой памяти советуем облако."""
    machine = (machine or platform.machine()).lower()
    intel_mac = sys.platform == "darwin" and machine in ("x86_64", "amd64")
    if ram is None:
        return {"model": MODELS[1][1], "size": MODELS[1][2], "ok": True,
                "note": "Не удалось определить объём памяти — берём компактную модель."}
    for min_ram, model, size in MODELS:
        if ram >= min_ram:
            note = "Модель будет работать медленно на Intel-процессоре — облачный вариант будет быстрее." if intel_mac else ""
            return {"model": model, "size": size, "ok": True, "note": note}
    return {"model": None, "size": None, "ok": False,
            "note": f"Памяти {ram:.0f} ГБ — маловато для локальной модели. Лучше подключить облачный сервис (DeepSeek, Qwen и т. п.)."}


def installed_path() -> Path | None:
    candidates = []
    if sys.platform == "darwin":
        candidates = [Path.home() / "Applications/Ollama.app", Path("/Applications/Ollama.app")]
    elif sys.platform == "win32":
        local = os.environ.get("LOCALAPPDATA", "")
        candidates = [Path(local) / "Programs/Ollama/ollama.exe"] if local else []
    found = shutil.which("ollama")
    if found:
        candidates.append(Path(found))
    return next((p for p in candidates if p.exists()), None)


def _api(path: str, body: dict | None = None, timeout: float = 5):
    req = urllib.request.Request(
        OLLAMA_URL + path, data=json.dumps(body).encode() if body is not None else None,
        headers={"Content-Type": "application/json"}, method="POST" if body is not None else "GET",
    )
    return urllib.request.urlopen(req, timeout=timeout)


def running() -> bool:
    try:
        with _api("/api/version", timeout=2) as r:
            return r.status == 200
    except Exception:
        return False


def local_models() -> list[str]:
    try:
        with _api("/api/tags") as r:
            return sorted(m["name"] for m in json.load(r).get("models", []))
    except Exception:
        return []


def status() -> dict:
    ram = ram_gb()
    is_running = running()
    return {
        "platform": sys.platform,
        "supported": sys.platform in ("darwin", "win32"),
        "installed": bool(installed_path()) or is_running,
        "running": is_running,
        "models": local_models() if is_running else [],
        "ram_gb": round(ram, 1) if ram else None,
        "free_disk_gb": round(shutil.disk_usage(Path.home()).free / 2**30, 1),
        "recommended": recommend(ram),
        "job": dict(_job),
    }


# ---------- фоновая установка ----------

_job = {"state": "idle", "message": "", "progress": None, "model": None}
_lock = threading.Lock()


def _set(state: str, message: str, progress: float | None = None) -> None:
    _job.update(state=state, message=message, progress=progress)


def start_setup(model: str | None = None) -> dict:
    with _lock:
        if _job["state"] in ("downloading", "installing", "starting", "pulling"):
            raise RuntimeError("Установка уже идёт")
        model = model or recommend(ram_gb())["model"]
        if not model:
            raise RuntimeError("Для этого компьютера локальная модель не рекомендуется — подключите облачный сервис.")
        _job["model"] = model
        _set("starting", "Проверяю Ollama…", None)
    threading.Thread(target=_run, args=(model,), daemon=True).start()
    return dict(_job)


def _download(url: str, dest: Path, label: str) -> None:
    req = urllib.request.Request(url, headers={"User-Agent": "Planer"})
    with urllib.request.urlopen(req, timeout=60, context=_ssl_context()) as r, open(dest, "wb") as f:
        total = int(r.headers.get("Content-Length") or 0)
        done = 0
        while chunk := r.read(1 << 20):
            f.write(chunk)
            done += len(chunk)
            _set("downloading", label, done / total if total else None)


def _install() -> None:
    tmp = Path(tempfile.mkdtemp(prefix="planer-ollama-"))
    try:
        if sys.platform == "darwin":
            archive = tmp / "Ollama.zip"
            _download(MAC_URL, archive, "Скачиваю Ollama…")
            _set("installing", "Устанавливаю Ollama…")
            apps = Path.home() / "Applications"
            apps.mkdir(exist_ok=True)
            # ditto сохраняет атрибуты и симлинки .app (zipfile их теряет)
            subprocess.run(["ditto", "-x", "-k", str(archive), str(apps)], check=True, timeout=300)
        elif sys.platform == "win32":
            setup = tmp / "OllamaSetup.exe"
            _download(WIN_URL, setup, "Скачиваю Ollama…")
            _set("installing", "Устанавливаю Ollama…")
            subprocess.run([str(setup), "/VERYSILENT", "/NORESTART", "/SUPPRESSMSGBOXES"], check=True, timeout=900)
        else:
            raise RuntimeError("Автоустановка есть для macOS и Windows. На Linux: curl -fsSL https://ollama.com/install.sh | sh")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def _launch() -> None:
    path = installed_path()
    if sys.platform == "darwin" and path and path.suffix == ".app":
        subprocess.Popen(["open", "-g", "-a", str(path)])  # -g: не выводить окно на передний план
    elif path:
        flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        subprocess.Popen([str(path), "serve"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                         creationflags=flags, start_new_session=sys.platform != "win32")
    deadline = time.time() + 60
    while time.time() < deadline:
        if running():
            return
        time.sleep(1)
    raise RuntimeError("Ollama установлена, но не запустилась. Откройте её вручную и повторите.")


def _pull(model: str) -> None:
    _set("pulling", f"Скачиваю модель {model}…", 0)
    req = urllib.request.Request(
        OLLAMA_URL + "/api/pull", data=json.dumps({"model": model, "stream": True}).encode(),
        headers={"Content-Type": "application/json"}, method="POST",
    )
    with urllib.request.urlopen(req, timeout=3600) as r:
        for raw in r:
            if not raw.strip():
                continue
            msg = json.loads(raw)
            if msg.get("error"):
                raise RuntimeError(f"Ollama: {msg['error']}")
            total, done = msg.get("total"), msg.get("completed")
            if total and done is not None:
                _set("pulling", f"Скачиваю модель {model}…", done / total)
            elif msg.get("status") == "success":
                break


def _run(model: str) -> None:
    try:
        if not running():
            if not installed_path():
                _install()
            _set("starting", "Запускаю Ollama…")
            _launch()
        if model not in local_models():
            _pull(model)
        save_settings({"provider": "ollama", "base_url": f"{OLLAMA_URL}/v1", "model": model, "api_key": ""})
        _set("done", f"Готово: модель {model} работает на этом компьютере.", 1)
    except Exception as e:
        reason = getattr(e, "reason", None)
        _set("error", f"Не получилось: {reason or e}")
