#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"
if [ ! -d .venv ]; then
  echo "Первый запуск: создаю окружение и ставлю зависимости..."
  python3 -m venv .venv
  .venv/bin/pip install -q --upgrade pip
  .venv/bin/pip install -q -r requirements.txt
fi
if [ ! -f .env ]; then
  cp .env.example .env
  echo "Создан файл .env — вставьте в него строку подключения Supabase (DATABASE_URL) и запустите снова."
  exit 0
fi
if [ ! -f .venv/.deps-v2 ]; then .venv/bin/pip install -q -r requirements.txt && touch .venv/.deps-v2; fi
exec .venv/bin/python run.py "$@"
