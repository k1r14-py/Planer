#!/bin/bash
# Останавливает фоновый сервер Planer, запущенный из Planer.app.
PORT="${PLANER_PORT:-8765}"
if pkill -f "uvicorn planer.app:app --host 127.0.0.1 --port $PORT"; then
  echo "Planer остановлен."
else
  echo "Planer не был запущен."
fi
