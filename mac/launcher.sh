#!/bin/bash
# Исполняемый файл внутри Planer.app (пути и порт подставляет install.sh).
# Если сервер уже работает — просто открывает вкладку, иначе сначала запускает его в фоне.

REPO="__REPO__"
PORT="__PORT__"
URL="http://127.0.0.1:$PORT"
LOG="$HOME/Library/Logs/Planer.log"

# У приложений, запущенных из Finder, урезанный PATH
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
export PLANER_WHISPER_MODEL="${PLANER_WHISPER_MODEL:-__MODEL__}"

alive() { curl -fsS -m 1 "$URL/api/voice/status" >/dev/null 2>&1; }

fail() {
  osascript -e "display alert \"Planer не запустился\" message \"$1\n\nЛоги: ~/Library/Logs/Planer.log\" as critical" >/dev/null 2>&1
  exit 1
}

if ! alive; then
  [ -x "$REPO/.venv/bin/uvicorn" ] || fail "Не найден $REPO — переместили папку? Запустите mac/install.sh заново."
  mkdir -p "$(dirname "$LOG")"
  echo "=== $(date) запуск на порту $PORT" >> "$LOG"
  cd "$REPO/backend" || fail "Нет папки $REPO/backend"
  nohup "$REPO/.venv/bin/uvicorn" planer.app:app --host 127.0.0.1 --port "$PORT" >> "$LOG" 2>&1 &
  for _ in $(seq 1 75); do
    alive && break
    sleep 0.2
  done
  alive || fail "Сервер не ответил за 15 секунд."
fi

open "$URL"
