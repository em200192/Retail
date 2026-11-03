#!/usr/bin/env bash
# Usage: DATABASE_URL=postgres://... ./migrate.sh
# Applies pending migrations in filename order, recording each one in
# meta.schema_migrations so the script is safe to re-run on an existing DB.
# 099_security.sql is idempotent and is re-applied on EVERY run so that new
# tables automatically get RLS, grants and updated_at triggers.
# Stops at the first error.
set -euo pipefail
: "${DATABASE_URL:?DATABASE_URL must be set}"
cd "$(dirname "$0")/migrations"

PSQL=(psql "$DATABASE_URL" -q -v ON_ERROR_STOP=1 -X)

"${PSQL[@]}" -c "SET client_min_messages = warning" -c "
  CREATE SCHEMA IF NOT EXISTS meta;
  CREATE TABLE IF NOT EXISTS meta.schema_migrations (
    filename   text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  );" </dev/null

applied_any=0
for f in *.sql; do
  done_already=$("${PSQL[@]}" -At -c "SELECT 1 FROM meta.schema_migrations WHERE filename = '$f'" </dev/null)
  if [[ "$done_already" == "1" ]]; then
    continue
  fi
  echo "→ $f"
  # Apply the file and record it in one transaction.
  "${PSQL[@]}" -1 -c "SET client_min_messages = warning" -f "$f" \
    -c "INSERT INTO meta.schema_migrations (filename) VALUES ('$f')" </dev/null
  applied_any=1
done

if [[ $applied_any == 1 ]]; then
  echo "→ re-applying 099_security.sql (RLS + grants for any new tables)"
fi
"${PSQL[@]}" -1 -c "SET client_min_messages = warning" -f 099_security.sql </dev/null
echo "✓ all migrations applied"
