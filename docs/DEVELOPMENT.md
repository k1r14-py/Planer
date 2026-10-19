# Разработка

## Устройство

```
backend/         Python 3.10+, FastAPI + SQLite
  planer/app.py        HTTP API: дни, задачи, план/факт, перенос, таймеры, поиск, дашборд, ИИ, обновления
  planer/db.py         схема и миграции (PRAGMA user_version)
  planer/dictation.py  разбор надиктованного текста по правилам (задачи, подзадачи, оценки, проекты, теги)
  planer/dates.py      разбор сроков: «до пятницы», «к 25 октября», «до конца месяца»…
  planer/speech.py     локальное распознавание речи (faster-whisper)
  planer/stats.py      статистика для дашборда
  planer/ai/           ИИ-помощник: OpenAI-совместимый клиент, вход по подписке ChatGPT, функции, автоустановка Ollama
  planer/updater.py    обновление из GitHub Releases, planer/restarter.py — перезапуск с откатом
frontend/        React + TypeScript + Vite, без UI-библиотек; стиль — CSS-переменные в src/styles.css
desktop/         Electron-оболочка (окно, трей, горячая клавиша) + встроенная среда runtime/
mac/             старый способ запуска на Маке через Терминал (install.sh) — для разработки
.github/workflows/release.yml   релизы
```

## Запуск из исходников

Нужны Python 3.10+ и Node.js 18+.

```bash
python3 -m venv .venv && .venv/bin/pip install -r backend/requirements-dev.txt -r backend/requirements-voice.txt
cd backend && ../.venv/bin/uvicorn planer.app:app --reload     # API на :8000
cd frontend && npm install && npm run dev                      # интерфейс на :5173 (проксирует /api)
cd backend && ../.venv/bin/python -m pytest                    # тесты
```

Или одной командой: `./run.sh` — соберёт интерфейс и поднимет http://localhost:8000.

На Маке есть `mac/install.sh`: ставит всё в `.venv`, собирает интерфейс и создаёт лаунчер
`~/Applications/Planer.app`, который открывает Planer во вкладке браузера. Обычным пользователям
нужно приложение из релиза, а не это.

### Переменные окружения

| Переменная | По умолчанию | Что это |
|---|---|---|
| `PLANER_DB` | `data/planer.db` | путь к базе SQLite |
| `PLANER_WHISPER_MODEL` | `small` | `tiny` / `base` / `small` / `medium` / `large-v3` / `turbo` |
| `PLANER_WHISPER_LANG` | `ru` | язык распознавания (пусто — автоопределение) |
| `PLANER_WHISPER_DEVICE` | `auto` | `cpu` / `cuda` |
| `PLANER_WHISPER_COMPUTE` | `int8` | `int8`, `float16` (GPU) … |
| `PLANER_PRELOAD_WHISPER` | — | `1` — загрузить модель распознавания в фоне при старте |
| `PLANER_UPDATE_REPO` | `k1r14-py/Planer` | репозиторий, из которого берутся обновления |

## Приложение (desktop/)

Electron-оболочка: окно, иконка в строке меню / трее, глобальная горячая клавиша диктовки, автозапуск.
Внутри — `runtime/`: автономный Python 3.12 (python-build-standalone через `uv`) с зависимостями и код
Planer. При первом запуске среда копируется в папку пользователя (`~/Library/Application Support/Planer`,
`%APPDATA%\Planer`), оттуда её обновляет кнопка «Обновить»; данные — в `data/` рядом.

```bash
cd frontend && npm ci && npm run build
cd ../desktop && npm ci
node scripts/prepare-runtime.mjs     # собрать runtime/ (нужен uv)
npm start                            # запустить оболочку
npx electron-builder --mac dmg       # или --win nsis, --linux dir
```

Приложение не подписано сертификатами Apple / Microsoft (на macOS — ad-hoc-подпись в
`scripts/after-pack.cjs`), поэтому при первом запуске система просит подтверждение.

## Релизы и обновления

Релиз собирает GitHub Actions, когда меняется файл `VERSION`:

1. тесты и архив кода `planer-vX.Y.Z.zip` (+ `.sha256`) — его скачивает кнопка «Обновить»;
2. параллельно — приложения: `.dmg` (macOS arm64 и x64) и `.exe` (Windows x64);
3. релиз с описанием из раздела `## X.Y.Z` в `CHANGELOG.md` и инструкцией из `docs/INSTALL.md`.

Кнопка «Обновить» внутри Planer: скачивает архив и сверяет контрольную сумму, сохраняет копию базы в
`data/backups/` (последние 5), заменяет код (данные и окружение не трогает), доустанавливает
зависимости, если они изменились, и перезапускается. Если новая версия не поднялась — возвращает
прежнюю. Установки через `git clone` кнопкой не обновляются — для них `git pull`.

## Скриншоты

Скриншоты для README лежат в `docs/screenshots/` и снимаются Playwright-ом на демо-данных
(2× разрешение, окно 1200×820).
