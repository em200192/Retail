#!/usr/bin/env bash
# Creates a local database plus the two login roles the app uses:
#   retail_api    -> member of app_runtime (RLS enforced)   used by the API
#   retail_worker -> member of app_worker  (bypasses RLS)   used by jobs/auth
# Usage: ADMIN_URL=postgres://postgres@localhost/postgres DB_NAME=retail ./db/setup-dev.sh
set -euo pipefail
ADMIN_URL="${ADMIN_URL:-postgres://postgres@localhost/postgres}"
DB_NAME="${DB_NAME:-retail}"
API_PASSWORD="${API_PASSWORD:-retail_api}"
WORKER_PASSWORD="${WORKER_PASSWORD:-retail_worker}"

psql "$ADMIN_URL" -X -q -v ON_ERROR_STOP=1 -c "CREATE DATABASE \"$DB_NAME\"" </dev/null 2>/dev/null \
  || echo "(database $DB_NAME already exists)"

DB_URL="${ADMIN_URL%/*}/$DB_NAME"
DATABASE_URL="$DB_URL" "$(dirname "$0")/migrate.sh"

psql "$DB_URL" -X -q -v ON_ERROR_STOP=1 </dev/null <<SQL
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'retail_api') THEN
    CREATE ROLE retail_api LOGIN PASSWORD '$API_PASSWORD' IN ROLE app_runtime;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'retail_worker') THEN
    CREATE ROLE retail_worker LOGIN PASSWORD '$WORKER_PASSWORD' IN ROLE app_worker;
  END IF;
END \$\$;
SQL
echo "✓ dev database ready"
echo "  DATABASE_URL=${DB_URL/\/\/*@/\/\/retail_api:$API_PASSWORD@}"
echo "  WORKER_DATABASE_URL=${DB_URL/\/\/*@/\/\/retail_worker:$WORKER_PASSWORD@}"
