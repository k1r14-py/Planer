#!/bin/bash
# Исполняемый файл внутри Planer.app (пути и порт подставляет install.sh).
# Если сервер Planer уже работает — просто открывает вкладку, иначе сначала запускает его в фоне.
# Если порт занят другой программой, пробует следующие и запоминает тот, что подошёл.

REPO="__REPO__"
DEFAULT_PORT="__PORT__"
LOG="$HOME/Library/Logs/Planer.log"
STATE="$HOME/Library/Application Support/Planer"
PORT_FILE="$STATE/port"

# У приложений, запущенных из Finder, урезанный PATH и нет локали
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
export LANG="${LANG:-en_US.UTF-8}"
export PYTHONUNBUFFERED=1
export PLANER_WHISPER_MODEL="${PLANER_WHISPER_MODEL:-__MODEL__}"

# Отвечает ли на порту именно Planer (а не другая программа)
is_planer() { curl -fsS -m 2 "http://127.0.0.1:$1/api/health" 2>/dev/null | grep -q '"app":"planer"'; }

fail() {
  local tail_log=""
  [ -f "$LOG" ] && tail_log="$(tail -n 6 "$LOG" | tr '"\\' "'/")"
  osascript -e "display alert \"Planer не запустился\" message \"$1\n\n$tail_log\n\nПолный лог откроется в TextEdit.\" as critical" >/dev/null 2>&1
  [ -f "$LOG" ] && open -e "$LOG"
  exit 1
}

opened() {
  mkdir -p "$STATE" && echo "$1" > "$PORT_FILE"
  open "http://127.0.0.1:$1"
  exit 0
}

SAVED="$(cat "$PORT_FILE" 2>/dev/null)"
[ -n "$SAVED" ] && is_planer "$SAVED" && opened "$SAVED"

[ -x "$REPO/.venv/bin/uvicorn" ] || fail "Не найден $REPO/.venv — переместили папку? Запустите mac/install.sh заново."
cd "$REPO/backend" || fail "Нет папки $REPO/backend"
mkdir -p "$(dirname "$LOG")"
touch "$LOG"

notified=""
for PORT in $SAVED $(seq "$DEFAULT_PORT" $((DEFAULT_PORT + 40))); do
  is_planer "$PORT" && opened "$PORT"

  echo "=== $(date) запуск на порту $PORT" >> "$LOG"
  start_line=$(wc -l < "$LOG")
  nohup "$REPO/.venv/bin/uvicorn" planer.app:app --host 127.0.0.1 --port "$PORT" >> "$LOG" 2>&1 &
  PID=$!

  # Первый запуск на Маке может быть долгим: macOS проверяет новые библиотеки
  for i in $(seq 1 120); do
    is_planer "$PORT" && opened "$PORT"
    if ! kill -0 "$PID" 2>/dev/null; then
      # порт занят другой программой — пробуем следующий
      tail -n +"$((start_line + 1))" "$LOG" | grep -qi "address already in use" && continue 2
      fail "Сервер завершился с ошибкой."
    fi
    if [ "$i" = 6 ] && [ -z "$notified" ]; then
      notified=1
      osascript -e 'display notification "Первый запуск может занять до минуты" with title "Planer запускается…"' >/dev/null 2>&1
    fi
    sleep 0.5
  done
  fail "Сервер не ответил за минуту."
done

fail "Все порты $DEFAULT_PORT–$((DEFAULT_PORT + 40)) заняты."
