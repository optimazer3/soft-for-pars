#!/usr/bin/env bash
# Установка «Optimizer Сводка» на чистый сервер Ubuntu 22.04 / 24.04.
#   sudo bash deploy/install.sh ваш-домен.ru
# Повторный запуск безопасен: обновляет настройки, данные не трогает.
set -euo pipefail

DOMAIN="${1:-}"
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP_USER="svodka"
PORT=8000

if [[ $EUID -ne 0 ]]; then echo "Запустите через sudo"; exit 1; fi
if [[ -z "$DOMAIN" ]]; then echo "Укажите домен: sudo bash deploy/install.sh ваш-домен.ru"; exit 1; fi
if [[ ! -f "$APP_DIR/.env" ]]; then
  echo "Нет файла $APP_DIR/.env — сначала создайте его со строкой DATABASE_URL (см. инструкцию)."; exit 1
fi

echo "==> Часовой пояс сервера: Москва (по нему работает расписание)"
timedatectl set-timezone Europe/Moscow || true

echo "==> Системные пакеты"
apt-get update -qq
apt-get install -y -qq python3 python3-venv python3-pip git curl ufw debian-keyring debian-archive-keyring apt-transport-https gnupg >/dev/null

echo "==> Caddy (веб-сервер с автоматическим HTTPS)"
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq && apt-get install -y -qq caddy >/dev/null
fi

echo "==> Пользователь $APP_USER и права на папку"
id "$APP_USER" >/dev/null 2>&1 || useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin "$APP_USER"
mkdir -p "$APP_DIR/data"
chown -R "$APP_USER:$APP_USER" "$APP_DIR"
chmod 600 "$APP_DIR/.env"
git config --system --add safe.directory "$APP_DIR" 2>/dev/null || true

echo "==> Python-окружение и зависимости"
sudo -u "$APP_USER" python3 -m venv "$APP_DIR/.venv"
sudo -u "$APP_USER" "$APP_DIR/.venv/bin/pip" install -q --upgrade pip
sudo -u "$APP_USER" "$APP_DIR/.venv/bin/pip" install -q -r "$APP_DIR/requirements.txt"

echo "==> Автозапуск программы (systemd)"
cat > /etc/systemd/system/svodka.service <<UNIT
[Unit]
Description=Optimizer Svodka
After=network-online.target
Wants=network-online.target

[Service]
User=$APP_USER
WorkingDirectory=$APP_DIR
ExecStart=$APP_DIR/.venv/bin/python run.py --no-browser --host 127.0.0.1 --port $PORT --behind-proxy
Restart=always
RestartSec=5
Environment=PYTHONUNBUFFERED=1

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable svodka >/dev/null
systemctl restart svodka

echo "==> HTTPS для $DOMAIN"
cat > /etc/caddy/Caddyfile <<CADDY
$DOMAIN {
	encode gzip
	reverse_proxy 127.0.0.1:$PORT
}
CADDY
systemctl enable caddy >/dev/null
systemctl reload caddy 2>/dev/null || systemctl restart caddy

echo "==> Брандмауэр: открыты только SSH, HTTP и HTTPS"
ufw allow OpenSSH >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw --force enable >/dev/null

sleep 3
if systemctl is-active --quiet svodka; then
  echo
  echo "Готово! Откройте https://$DOMAIN (сертификат HTTPS выпускается в первые 1–2 минуты)."
else
  echo
  echo "Программа не запустилась. Посмотрите причину: journalctl -u svodka -n 50"
  exit 1
fi
