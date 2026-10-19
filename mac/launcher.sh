#!/bin/bash
# Исполняемый файл внутри Planer.app (пути и порт подставляет install.sh).
# Если сервер Planer уже работает — просто открывает вкладку, иначе сначала запускает его в фоне.
# Если порт занят чужой программой, выбирает свободный и запоминает его.

REPO="__REPO__"
DEFAULT_PORT="__PORT__"
LOG="$HOME/Library/Logs/Planer.log"
STATE="$HOME/Library/Application Support/Planer"
PORT_FILE="$STATE/port"
PY="$REPO/.venv/bin/python"

# У приложений, запущенных из Finder, урезанный PATH и нет локали
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
export LANG="${LANG:-en_US.UTF-8}"
export PYTHONUNBUFFERED=1
export PLANER_WHISPER_MODEL="${PLANER_WHISPER_MODEL:-__MODEL__}"

# Отвечает ли на порту именно Planer (а не другая программа)
is_planer() { curl -fsS -m 2 "http://127.0.0.1:$1/api/health" 2>/dev/null | grep -q '"app":"planer"'; }

port_free() {
  "$PY" -c 'import socket, sys; socket.socket().bind(("127.0.0.1", int(sys.argv[1])))' "$1" 2>/dev/null
}

fail() {
  local tail_log=""
  [ -f "$LOG" ] && tail_log="$(tail -n 6 "$LOG" | tr '"\\' "'/")"
  osascript -e "display alert \"Planer не запустился\" message \"$1\n\n$tail_log\n\nПолный лог откроется в TextEdit.\" as critical" >/dev/null 2>&1
  [ -f "$LOG" ] && open -e "$LOG"
  exit 1
}

PORT="$(cat "$PORT_FILE" 2>/dev/null)"
PORT="${PORT:-$DEFAULT_PORT}"

if ! is_planer "$PORT"; then
  [ -x "$PY" ] || fail "Не найден $REPO/.venv — переместили папку? Запустите mac/install.sh заново."

  if ! port_free "$PORT"; then
    FOUND=""
    for p in $(seq "$DEFAULT_PORT" $((DEFAULT_PORT + 40))); do
      if is_planer "$p"; then PORT="$p"; FOUND=running; break; fi
      if port_free "$p"; then PORT="$p"; FOUND=free; break; fi
    done
    [ -n "$FOUND" ] || fail "Не нашлось свободного порта в диапазоне $DEFAULT_PORT–$((DEFAULT_PORT + 40))."
  fi
  mkdir -p "$STATE" && echo "$PORT" > "$PORT_FILE"

  if ! is_planer "$PORT"; then
    mkdir -p "$(dirname "$LOG")"
    echo "=== $(date) запуск на порту $PORT" >> "$LOG"
    cd "$REPO/backend" || fail "Нет папки $REPO/backend"
    nohup "$REPO/.venv/bin/uvicorn" planer.app:app --host 127.0.0.1 --port "$PORT" >> "$LOG" 2>&1 &
    PID=$!

    # Первый запуск на Маке может быть долгим: macOS проверяет новые библиотеки
    for i in $(seq 1 120); do
      is_planer "$PORT" && break
      kill -0 "$PID" 2>/dev/null || fail "Сервер завершился с ошибкой."
      if [ "$i" = 6 ]; then
        osascript -e 'display notification "Первый запуск может занять до минуты" with title "Planer запускается…"' >/dev/null 2>&1
      fi
      sleep 0.5
    done
    is_planer "$PORT" || fail "Сервер не ответил за минуту."
  fi
fi

open "http://127.0.0.1:$PORT"
