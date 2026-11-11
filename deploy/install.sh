#!/usr/bin/env bash
# Installs or updates TillMate on an Ubuntu/Debian server. Run from the repository root:
#   sudo ./deploy/install.sh            (first time it asks nothing: it makes .env with random secrets)
set -euo pipefail
cd "$(dirname "$0")/.."

if ! command -v docker >/dev/null 2>&1; then
  echo "Installing Docker…"
  curl -fsSL https://get.docker.com | sh
fi

if [ ! -f .env ]; then
  IP=$(curl -fsS https://api.ipify.org || hostname -I | awk '{print $1}')
  rnd() { openssl rand -hex 24; }
  cat > .env <<ENV
# Public address. Until you have your own domain this uses sslip.io, which points
# app.<ip>.sslip.io etc. at this server so HTTPS certificates work.
DOMAIN=${DOMAIN:-${IP//./-}.sslip.io}
ACME_EMAIL=${ACME_EMAIL:-admin@example.com}
PG_PASSWORD=$(rnd)
API_DB_PASSWORD=$(rnd)
WORKER_DB_PASSWORD=$(rnd)
JWT_SECRET=$(openssl rand -hex 32)
# Needed for reading supplier invoices: https://console.anthropic.com
ANTHROPIC_API_KEY=
ENV
  chmod 600 .env
  echo "Created .env"
fi

if command -v ufw >/dev/null 2>&1; then ufw allow 22/tcp >/dev/null; ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null; fi

docker compose -f docker-compose.prod.yml up -d --build
set -a; . ./.env; set +a
echo
echo "TillMate is starting. In a minute open:"
echo "  Back office: https://app.$DOMAIN   (sign up your first shop there)"
echo "  Till:        https://till.$DOMAIN"
echo "  API health:  https://api.$DOMAIN/health"
