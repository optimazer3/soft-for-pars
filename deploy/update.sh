#!/usr/bin/env bash
# Обновление до последней версии:  sudo bash deploy/update.sh
set -euo pipefail
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$APP_DIR"
echo "==> Скачиваю обновления"
git pull --ff-only
chown -R svodka:svodka "$APP_DIR"
echo "==> Обновляю зависимости"
sudo -u svodka .venv/bin/pip install -q -r requirements.txt
echo "==> Перезапускаю"
systemctl restart svodka
sleep 3
systemctl is-active --quiet svodka && echo "Готово: $(git log --oneline -1)" || { echo "Ошибка запуска: journalctl -u svodka -n 50"; exit 1; }
