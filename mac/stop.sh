#!/bin/bash
# Останавливает фоновый сервер Planer, запущенный из Planer.app (на любом порту).
if pkill -f "uvicorn planer.app:app --host 127.0.0.1"; then
  echo "Planer остановлен."
else
  echo "Planer не был запущен."
fi
