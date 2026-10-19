"""Перезапуск сервера после обновления (запускается из updater.restart отдельным процессом).

    python -m planer.restarter <pid старого сервера> <argv json> <cwd> <корень проекта>

Ждёт завершения старого процесса, запускает сервер с теми же аргументами и проверяет
/api/health. Если новая версия не поднялась за минуту — откатывает файлы и запускает
прежнюю. Остаётся родителем сервера, пока тот работает.
"""

import json
import os
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

from planer.updater import BACKUP_DIR, MANIFEST, mark_failed, rollback

HEALTH_TIMEOUT = 90


def log(msg: str) -> None:
    print(f"INFO:     [restarter] {msg}", flush=True)


def alive(pid: int) -> bool:
    if os.name == "nt":
        return False  # os.kill(pid, 0) в Windows завершает процесс; просто ждём фиксированно
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def port_of(argv: list[str]) -> int:
    for i, a in enumerate(argv):
        if a == "--port" and i + 1 < len(argv):
            return int(argv[i + 1])
        if a.startswith("--port="):
            return int(a.split("=", 1)[1])
    return 8000


def healthy(port: int) -> bool:
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/health", timeout=2) as r:
            return json.load(r).get("app") == "planer"
    except Exception:
        return False


def wait_healthy(proc: subprocess.Popen, port: int) -> bool:
    deadline = time.time() + HEALTH_TIMEOUT
    while time.time() < deadline:
        if proc.poll() is not None:
            return False
        if healthy(port):
            return True
        time.sleep(0.5)
    return False


def main(pid: int, argv: list[str], cwd: str, root: Path) -> int:
    deadline = time.time() + 30
    while alive(pid) and time.time() < deadline:
        time.sleep(0.2)
    time.sleep(0.5 if os.name != "nt" else 3)

    port = port_of(argv)
    log(f"запускаю новую версию на порту {port}")
    proc = subprocess.Popen(argv, cwd=cwd)
    if wait_healthy(proc, port):
        log("новая версия работает")
        return proc.wait()

    log("новая версия не запустилась — откатываюсь")
    if proc.poll() is None:
        proc.terminate()
        try:
            proc.wait(10)
        except subprocess.TimeoutExpired:
            proc.kill()

    manifest = root / BACKUP_DIR / MANIFEST
    version = json.loads(manifest.read_text()).get("to", "?") if manifest.exists() else "?"
    rollback(root)
    mark_failed(root, version)
    proc = subprocess.Popen(argv, cwd=cwd)
    log("прежняя версия запущена" if wait_healthy(proc, port) else "прежняя версия тоже не отвечает")
    return proc.wait()


if __name__ == "__main__":
    sys.exit(main(int(sys.argv[1]), json.loads(sys.argv[2]), sys.argv[3], Path(sys.argv[4])))
