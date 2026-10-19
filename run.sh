#!/usr/bin/env bash
# Сборка фронтенда и запуск сервера: http://localhost:8000
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -d .venv ]; then
  python3 -m venv .venv
  .venv/bin/pip install -r backend/requirements.txt
  if [ "${PLANER_VOICE:-1}" = "1" ]; then
    .venv/bin/pip install -r backend/requirements-voice.txt || echo "⚠ faster-whisper не установился — голосовой ввод будет выключен"
  fi
fi

if [ ! -d frontend/node_modules ]; then
  (cd frontend && npm install)
fi
(cd frontend && npm run build)

cd backend
exec ../.venv/bin/uvicorn planer.app:app --host 127.0.0.1 --port "${PORT:-8000}"
