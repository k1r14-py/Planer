#!/bin/bash
# Устанавливает Planer на macOS: зависимости, сборка интерфейса и приложение
# ~/Applications/Planer.app — по клику поднимает сервер и открывает вкладку в браузере.
# Повторный запуск = обновление (например, после git pull).
#
#   ./mac/install.sh
#   PLANER_SKIP_MODEL=1 ./mac/install.sh      # не скачивать модель Whisper заранее
#   PLANER_WHISPER_MODEL=turbo ./mac/install.sh
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
APP_DIR="${PLANER_APP_DIR:-$HOME/Applications}"
APP="$APP_DIR/Planer.app"
PORT="${PLANER_PORT:-8765}"
MODEL="${PLANER_WHISPER_MODEL:-small}"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

say() { printf '\n\033[1;35m▸ %s\033[0m\n' "$1"; }
die() { printf '\n\033[1;31m✗ %s\033[0m\n' "$1" >&2; exit 1; }

if [ "$(uname)" != "Darwin" ] && [ -z "${PLANER_FORCE:-}" ]; then
  die "Этот установщик для macOS. На других системах используйте ./run.sh"
fi

# ---------- Python 3.10+ и Node ----------
PY=""
for c in python3.13 python3.12 python3.11 python3.10 python3; do
  if command -v "$c" >/dev/null 2>&1 &&
     "$c" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)' 2>/dev/null; then
    PY="$(command -v "$c")"
    break
  fi
done
[ -n "$PY" ] || die "Нужен Python 3.10+. Установите: brew install python@3.12   (Homebrew: https://brew.sh)"
command -v npm >/dev/null 2>&1 || die "Нужен Node.js. Установите: brew install node"
say "Python: $PY ($("$PY" --version 2>&1)), Node: $(node --version)"

# ---------- бэкенд ----------
cd "$REPO"
if [ -x .venv/bin/python ] &&
   ! .venv/bin/python -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)' 2>/dev/null; then
  rm -rf .venv
fi
if [ ! -x .venv/bin/python ]; then
  say "Создаю виртуальное окружение"
  "$PY" -m venv .venv
fi
say "Ставлю зависимости сервера"
.venv/bin/pip install -q --upgrade pip
.venv/bin/pip install -q -r backend/requirements.txt

VOICE=1
say "Ставлю faster-whisper (голосовой ввод)"
if ! .venv/bin/pip install -q -r backend/requirements-voice.txt; then
  VOICE=0
  echo "  ⚠ не получилось — всё работает, кроме голоса"
fi

if [ "$VOICE" = 1 ] && [ -z "${PLANER_SKIP_MODEL:-}" ]; then
  say "Скачиваю модель Whisper «${MODEL}» (один раз, дальше работает офлайн)"
  .venv/bin/python -c "from faster_whisper import WhisperModel; WhisperModel('$MODEL', device='cpu', compute_type='int8')" ||
    echo "  ⚠ модель не скачалась — она подтянется при первой записи"
fi

# ---------- фронтенд ----------
say "Собираю интерфейс"
(cd frontend && npm install --no-audit --no-fund --loglevel=error && npm run build >/dev/null)

# ---------- останавливаем старый сервер, чтобы подхватился новый код ----------
pkill -f "uvicorn planer.app:app --host 127.0.0.1 --port $PORT" 2>/dev/null || true

# ---------- Planer.app ----------
say "Создаю $APP"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Planer</string>
  <key>CFBundleDisplayName</key><string>Planer</string>
  <key>CFBundleIdentifier</key><string>local.planer.launcher</string>
  <key>CFBundleVersion</key><string>1.0</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>Planer</string>
  <key>CFBundleIconFile</key><string>Planer</string>
  <key>LSUIElement</key><true/>
</dict>
</plist>
PLIST

# Путь к репозиторию и порт «зашиваются» в лаунчер
sed -e "s|__REPO__|$REPO|g" -e "s|__PORT__|$PORT|g" -e "s|__MODEL__|$MODEL|g" \
  "$REPO/mac/launcher.sh" > "$APP/Contents/MacOS/Planer"
chmod +x "$APP/Contents/MacOS/Planer"

if command -v sips >/dev/null 2>&1 && command -v iconutil >/dev/null 2>&1; then
  ICONSET="$(mktemp -d)/Planer.iconset"
  mkdir -p "$ICONSET"
  for s in 16 32 128 256 512; do
    sips -z $s $s "$REPO/mac/icon.png" --out "$ICONSET/icon_${s}x${s}.png" >/dev/null
    sips -z $((s * 2)) $((s * 2)) "$REPO/mac/icon.png" --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null
  done
  iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/Planer.icns"
  rm -rf "$(dirname "$ICONSET")"
  touch "$APP"  # чтобы Finder обновил иконку
fi

say "Готово!"
cat <<EOF

  Приложение: $APP
  • Запуск — двойной клик (или Spotlight: ⌘Пробел → «Planer»).
  • Чтобы держать в Dock — перетащите Planer.app из открывшегося окна Finder в Dock.
  • Адрес: http://127.0.0.1:$PORT   · Логи: ~/Library/Logs/Planer.log
  • Остановить сервер: $REPO/mac/stop.sh
  • Обновить после git pull: снова ./mac/install.sh

EOF

if command -v open >/dev/null 2>&1; then
  open -R "$APP"
fi
