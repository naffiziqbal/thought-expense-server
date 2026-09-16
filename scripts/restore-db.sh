#!/usr/bin/env bash
#
# Restore a dump into a scratch database, so you can prove a backup actually
# rebuilds rather than merely being a well-formed archive.
#
#   scripts/restore-db.sh /var/backups/thought-expense/db_2026-09-16_22-09-13.dump
#   scripts/restore-db.sh <dump> <target-db>
#
# Restoring over the live database is the only operation in this pipeline that
# destroys data, so that requires FORCE=1.

set -euo pipefail

PG_CONTAINER="${PG_CONTAINER:-thoughtexpense-postgres}"
PG_USER="${PG_USER:-thoughtexpense}"
PG_DATABASE="${PG_DATABASE:-thoughtexpense}"

dump="${1:-}"
target="${2:-${PG_DATABASE}_restore_test}"

[ -n "$dump" ] || { echo "usage: $0 <dump-file> [target-db]" >&2; exit 64; }
[ -f "$dump" ] || { echo "no such file: $dump" >&2; exit 66; }

if [ "$target" = "$PG_DATABASE" ] && [ "${FORCE:-0}" != "1" ]; then
  echo "Refusing to restore over the live database \"${PG_DATABASE}\"." >&2
  echo "Pass a different target database, or set FORCE=1 if that is really the intent." >&2
  exit 1
fi

run_psql() { docker exec -i "$PG_CONTAINER" psql -q -U "$PG_USER" "$@"; }

echo "recreating ${target}"
run_psql -d postgres -c "DROP DATABASE IF EXISTS \"${target}\";"
run_psql -d postgres -c "CREATE DATABASE \"${target}\";"

echo "restoring $(basename "$dump")"
docker exec -i "$PG_CONTAINER" pg_restore -U "$PG_USER" -d "$target" --no-owner --no-acl < "$dump"

echo
echo "row counts in ${target}:"
run_psql -d "$target" <<'SQL'
SELECT 'User' AS table_name, COUNT(*) AS rows FROM "User"
UNION ALL SELECT 'Expense', COUNT(*) FROM "Expense"
UNION ALL SELECT 'Budget', COUNT(*) FROM "Budget"
UNION ALL SELECT 'Goal', COUNT(*) FROM "Goal";
SQL

# Dumps taken before the migration baseline have no history table, so treat it
# as optional rather than failing the whole check.
echo "migration history:"
run_psql -d "$target" -c 'SELECT migration_name FROM "_prisma_migrations" ORDER BY finished_at;' 2>/dev/null \
  || echo "  (this dump has no _prisma_migrations table)"

echo
echo "Drop it when you are satisfied:"
echo "  docker exec -i ${PG_CONTAINER} psql -U ${PG_USER} -d postgres -c 'DROP DATABASE \"${target}\";'"
