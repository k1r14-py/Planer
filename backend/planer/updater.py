"""Обновление из GitHub Releases: проверка, скачивание, замена кода, перезапуск.

Релиз (собирает .github/workflows/release.yml) — архив planer-vX.Y.Z.zip с папкой Planer/
внутри и файл .sha256 рядом. Обновление:
  1. скачать архив и сверить контрольную сумму;
  2. сделать копию базы в data/backups/;
  3. переместить заменяемые файлы в .update-backup/ и положить на их место новые
     (data/, .venv/, node_modules/ не трогаются никогда);
  4. если изменились зависимости — доустановить их;
  5. перезапустить сервер через planer.restarter, который откатит всё назад,
     если новая версия не поднялась.
"""

import hashlib
import json
import logging
import os
import re
import shutil
import signal
import sqlite3
import ssl
import subprocess
import sys
import tempfile
import threading
import urllib.error
import urllib.request
import zipfile
from pathlib import Path

from .version import ROOT, current_version, parse_version

REPO = os.environ.get("PLANER_UPDATE_REPO", "k1r14-py/Planer")
API_LATEST = os.environ.get(
    "PLANER_UPDATE_API", f"https://api.github.com/repos/{REPO}/releases/latest"
)

# Эти пути обновление не трогает никогда
KEEP = {"data", ".venv", "venv", "node_modules", ".update-backup", ".git"}
BACKUP_DIR = ".update-backup"
MANIFEST = "manifest.json"
DB_BACKUPS_KEPT = 5

log = logging.getLogger("uvicorn.error.planer.update")

# Запоминаем при старте: во время обновления папка backend переезжает в .update-backup/,
# и os.getcwd() начал бы указывать туда (на старый код)
START_CWD = os.getcwd()


class UpdateError(Exception):
    pass


# ---------- сеть ----------


def _ssl_context() -> ssl.SSLContext:
    # Python с python.org на macOS не видит системные сертификаты — берём certifi
    try:
        import certifi

        return ssl.create_default_context(cafile=certifi.where())
    except ImportError:
        return ssl.create_default_context()


def _open(url: str, timeout: float = 20):
    req = urllib.request.Request(
        url, headers={"Accept": "application/vnd.github+json", "User-Agent": "Planer-updater"}
    )
    return urllib.request.urlopen(req, timeout=timeout, context=_ssl_context())


def _fetch_latest() -> dict:
    try:
        with _open(API_LATEST) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        if e.code == 404:
            raise UpdateError("На GitHub не найдено релизов (или репозиторий приватный)")
        if e.code == 403:
            raise UpdateError("GitHub временно ограничил запросы — попробуйте через час")
        raise UpdateError(f"GitHub ответил ошибкой {e.code}")
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        raise UpdateError(f"Нет связи с GitHub: {getattr(e, 'reason', e)}")


# ---------- проверка ----------


def can_apply(root: Path = ROOT) -> tuple[bool, str]:
    if (root / ".git").exists():
        return False, "Planer установлен через git — обновляйтесь командой git pull"
    if not os.access(root, os.W_OK):
        return False, f"Нет прав на запись в {root}"
    return True, ""


def check(root: Path = ROOT) -> dict:
    rel = _fetch_latest()
    latest = rel.get("tag_name", "").lstrip("v")
    assets = rel.get("assets", [])
    archive = next((a for a in assets if a["name"].endswith(".zip")), None)
    checksum = next((a for a in assets if a["name"].endswith(".sha256")), None)
    current = current_version(root)
    ok, reason = can_apply(root)
    return {
        "current": current,
        "latest": latest,
        "available": bool(archive) and parse_version(latest) > parse_version(current),
        "notes": rel.get("body") or "",
        "published_at": rel.get("published_at"),
        "url": rel.get("html_url"),
        "can_apply": ok,
        "reason": reason,
        "_archive": archive and archive["browser_download_url"],
        "_checksum": checksum and checksum["browser_download_url"],
    }


def public(info: dict) -> dict:
    return {k: v for k, v in info.items() if not k.startswith("_")}


# ---------- установка ----------


def _download(url: str, dest: Path) -> None:
    try:
        with _open(url, timeout=60) as r, open(dest, "wb") as f:
            shutil.copyfileobj(r, f)
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        raise UpdateError(f"Не удалось скачать обновление: {getattr(e, 'reason', e)}")


def _verify(archive: Path, checksum_url: str | None) -> None:
    if not checksum_url:
        return
    with _open(checksum_url) as r:
        expected = r.read().decode().split()[0].lower()
    actual = hashlib.sha256(archive.read_bytes()).hexdigest()
    if actual != expected:
        raise UpdateError("Контрольная сумма архива не совпала — обновление отменено")


def extract(archive: Path, into: Path) -> Path:
    """Распаковывает архив и возвращает корень новой версии (папку с VERSION)."""
    with zipfile.ZipFile(archive) as z:
        z.extractall(into)  # extractall отбрасывает абсолютные пути и «..»
    entries = [p for p in into.iterdir() if not p.name.startswith("__MACOSX")]
    new_root = entries[0] if len(entries) == 1 and entries[0].is_dir() else into
    if not (new_root / "VERSION").is_file() or not (new_root / "backend" / "planer").is_dir():
        raise UpdateError("В архиве нет Planer — обновление отменено")
    return new_root


def _pairs(new_root: Path, root: Path):
    """(новый путь, куда положить): всё из архива, кроме KEEP; frontend — поэлементно,
    чтобы не задеть frontend/node_modules."""
    for entry in sorted(new_root.iterdir()):
        if entry.name in KEEP:
            continue
        if entry.name == "frontend" and entry.is_dir():
            for sub in sorted(entry.iterdir()):
                if sub.name not in KEEP:
                    yield sub, root / "frontend" / sub.name
        else:
            yield entry, root / entry.name


def install(new_root: Path, root: Path = ROOT) -> dict:
    """Заменяет файлы; старые уходят в .update-backup/. При ошибке возвращает всё как было."""
    backup = root / BACKUP_DIR
    if backup.exists():
        shutil.rmtree(backup)
    backup.mkdir(parents=True)
    manifest = {"from": current_version(root), "to": current_version(new_root), "moved": [], "installed": []}

    def save():
        (backup / MANIFEST).write_text(json.dumps(manifest, ensure_ascii=False, indent=1))

    try:
        for src, dst in _pairs(new_root, root):
            rel = dst.relative_to(root).as_posix()
            if dst.exists() or dst.is_symlink():
                target = backup / rel
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.move(str(dst), str(target))
                manifest["moved"].append(rel)
            manifest["installed"].append(rel)
            save()
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(str(src), str(dst))
        save()
    except Exception:
        rollback(root)
        raise
    return manifest


def rollback(root: Path = ROOT) -> bool:
    """Возвращает файлы из .update-backup/. True, если было что откатывать."""
    backup = root / BACKUP_DIR
    path = backup / MANIFEST
    if not path.exists():
        return False
    manifest = json.loads(path.read_text())
    for rel in manifest["installed"]:
        p = root / rel
        if p.is_dir() and not p.is_symlink():
            shutil.rmtree(p)
        elif p.exists() or p.is_symlink():
            p.unlink()
    for rel in manifest["moved"]:
        src = backup / rel
        if src.exists() or src.is_symlink():
            (root / rel).parent.mkdir(parents=True, exist_ok=True)
            shutil.move(str(src), str(root / rel))
    path.unlink()
    return True


def backup_db(root: Path, label: str) -> Path | None:
    db = Path(os.environ.get("PLANER_DB", root / "data" / "planer.db"))
    if not db.exists():
        return None
    folder = db.parent / "backups"
    folder.mkdir(parents=True, exist_ok=True)
    dest = folder / f"planer-before-{label}.db"
    # backup API даёт целостную копию даже во время записи
    src, dst = sqlite3.connect(db), sqlite3.connect(dest)
    try:
        src.backup(dst)
    finally:
        src.close()
        dst.close()
    for old in sorted(folder.glob("planer-before-*.db"), key=lambda p: p.stat().st_mtime)[:-DB_BACKUPS_KEPT]:
        old.unlink()
    return dest


def _requirements_changed(root: Path) -> bool:
    backup = root / BACKUP_DIR
    for name in ("requirements.txt", "requirements-voice.txt"):
        new, old = root / "backend" / name, backup / "backend" / name
        if new.exists() and (not old.exists() or new.read_bytes() != old.read_bytes()):
            return True
    return False


def install_requirements(root: Path) -> None:
    from . import speech

    files = ["requirements.txt"] + (["requirements-voice.txt"] if speech.available() else [])
    for name in files:
        res = subprocess.run(
            [sys.executable, "-m", "pip", "install", "-q", "-r", str(root / "backend" / name)],
            capture_output=True, text=True, timeout=1800,
        )
        if res.returncode != 0:
            raise UpdateError(f"Не установились зависимости ({name}): {res.stderr.strip()[-300:]}")


def refresh_mac_launcher(root: Path) -> None:
    """Пересобирает исполняемый файл Planer.app из нового mac/launcher.sh."""
    if sys.platform != "darwin":
        return
    exe = Path.home() / "Applications" / "Planer.app" / "Contents" / "MacOS" / "Planer"
    template = root / "mac" / "launcher.sh"
    if not exe.exists() or not template.exists():
        return
    old = exe.read_text()
    port = re.search(r'DEFAULT_PORT="(\d+)"', old) or re.search(r'PORT="(\d+)"', old)
    model = re.search(r"PLANER_WHISPER_MODEL:-([^}]+)\}", old)
    text = (
        template.read_text()
        .replace("__REPO__", str(root))
        .replace("__PORT__", port.group(1) if port else "8765")
        .replace("__MODEL__", model.group(1) if model else "small")
    )
    exe.write_text(text)
    exe.chmod(0o755)


# ---------- фоновая задача ----------

_state = {"state": "idle", "message": "", "version": None}
_lock = threading.Lock()
BUSY = ("downloading", "installing", "restarting")


FAILED = "failed.json"


def status(root: Path = ROOT) -> dict:
    failed = root / BACKUP_DIR / FAILED
    if _state["state"] == "idle" and failed.exists():
        # restarter откатил версию, которая не запустилась, — сообщаем об этом
        info = json.loads(failed.read_text())
        return {"state": "error", "message": info["message"], "version": info["version"]}
    return dict(_state)


def mark_failed(root: Path, version: str) -> None:
    (root / BACKUP_DIR).mkdir(exist_ok=True)
    (root / BACKUP_DIR / FAILED).write_text(json.dumps({
        "version": version,
        "message": f"Версия {version} не запустилась — вернулась прежняя. Подробности в логе.",
    }, ensure_ascii=False))


def _set(state: str, message: str) -> None:
    _state.update(state=state, message=message)
    log.info("Обновление: %s — %s", state, message)


def start(root: Path = ROOT) -> dict:
    with _lock:
        if _state["state"] in BUSY:
            raise UpdateError("Обновление уже идёт")
        ok, reason = can_apply(root)
        if not ok:
            raise UpdateError(reason)
        info = check(root)
        if not info["available"]:
            raise UpdateError("Уже установлена последняя версия")
        _state["version"] = info["latest"]
        _set("downloading", f"Скачиваю версию {info['latest']}…")
    threading.Thread(target=_run, args=(info, root), daemon=True).start()
    return status()


def _run(info: dict, root: Path) -> None:
    installed = False
    try:
        with tempfile.TemporaryDirectory(prefix="planer-update-") as tmp:
            archive = Path(tmp) / "update.zip"
            _download(info["_archive"], archive)
            _verify(archive, info["_checksum"])
            new_root = extract(archive, Path(tmp) / "new")

            _set("installing", "Сохраняю копию базы…")
            backup_db(root, info["current"])
            _set("installing", "Устанавливаю новую версию…")
            install(new_root, root)
            installed = True

        if _requirements_changed(root):
            _set("installing", "Доустанавливаю зависимости… (может занять пару минут)")
            install_requirements(root)
        refresh_mac_launcher(root)

        _set("restarting", "Перезапускаю…")
        restart(root)
    except Exception as e:
        log.exception("Обновление не удалось")
        if installed:
            rollback(root)
        msg = str(e) if isinstance(e, UpdateError) else f"{type(e).__name__}: {e}"
        _set("error", f"{msg}. Осталась текущая версия.")


def restart(root: Path = ROOT) -> None:
    """Запускает planer.restarter (уже из новых файлов) и завершает текущий сервер."""
    env = dict(os.environ, PYTHONPATH=str(root / "backend"))
    subprocess.Popen(
        [sys.executable, "-m", "planer.restarter", str(os.getpid()),
         json.dumps(sys.orig_argv), START_CWD, str(root)],
        cwd=str(root / "backend"),
        env=env,
        start_new_session=True,
    )
    # даём ответу на /api/update/status уйти и мягко гасим uvicorn
    threading.Timer(1.0, lambda: os.kill(os.getpid(), signal.SIGTERM)).start()
