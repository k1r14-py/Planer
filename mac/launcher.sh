#!/bin/bash
# Исполняемый файл внутри Planer.app (пути и порт подставляет install.sh).
# Если сервер уже работает — просто открывает вкладку, иначе сначала запускает его в фоне.

REPO="__REPO__"
PORT="__PORT__"
URL="http://127.0.0.1:$PORT"
LOG="$HOME/Library/Logs/Planer.log"

# У приложений, запущенных из Finder, урезанный PATH и нет локали
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
export LANG="${LANG:-en_US.UTF-8}"
export PYTHONUNBUFFERED=1
export PLANER_WHISPER_MODEL="${PLANER_WHISPER_MODEL:-__MODEL__}"

alive() { curl -fsS -m 2 "$URL/api/health" >/dev/null 2>&1; }

fail() {
  local tail_log=""
  [ -f "$LOG" ] && tail_log="$(tail -n 6 "$LOG" | tr '"\\' "'/")"
  osascript -e "display alert \"Planer не запустился\" message \"$1\n\n$tail_log\n\nПолный лог откроется в TextEdit.\" as critical" >/dev/null 2>&1
  [ -f "$LOG" ] && open -e "$LOG"
  exit 1
}

if ! alive; then
  [ -x "$REPO/.venv/bin/uvicorn" ] || fail "Не найден $REPO/.venv — переместили папку? Запустите mac/install.sh заново."
  mkdir -p "$(dirname "$LOG")"
  echo "=== $(date) запуск на порту $PORT" >> "$LOG"
  cd "$REPO/backend" || fail "Нет папки $REPO/backend"
  nohup "$REPO/.venv/bin/uvicorn" planer.app:app --host 127.0.0.1 --port "$PORT" >> "$LOG" 2>&1 &
  PID=$!

  # Первый запуск на Маке может быть долгим: macOS проверяет новые библиотеки
  for i in $(seq 1 120); do
    alive && break
    kill -0 "$PID" 2>/dev/null || fail "Сервер завершился с ошибкой."
    if [ "$i" = 6 ]; then
      osascript -e 'display notification "Первый запуск может занять до минуты" with title "Planer запускается…"' >/dev/null 2>&1
    fi
    sleep 0.5
  done
  alive || fail "Сервер не ответил за минуту."
fi

open "$URL"
