#!/usr/bin/env bash
#
# Nightly Postgres backup: dump, verify, upload to Spaces, prune local copies.
#
# Exits non-zero on any failure and pings "$BACKUP_HEALTHCHECK_URL/fail" so a
# backup that silently stops working gets noticed.
#
#   scripts/backup-db.sh
#
# Cron (3am daily):
#   0 3 * * * /var/www/.../thought-expense-server/scripts/backup-db.sh >> /var/log/thoughtexpense-backup.log 2>&1

set -euo pipefail

SERVER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-${SERVER_DIR}/.env}"

# Read a setting from the shell environment, then .env, then a default. .env is
# parsed rather than sourced so a stray quote or backtick in a secret cannot
# execute anything.
cfg() {
  local name="$1" default="${2-}" value
  value="$(printenv "$name" 2>/dev/null || true)"

  if [ -z "$value" ] && [ -f "$ENV_FILE" ]; then
    value="$(sed -n "s/^[[:space:]]*${name}=//p" "$ENV_FILE" | tail -1 | tr -d '\r')"
    value="${value%\"}"; value="${value#\"}"
    value="${value%\'}"; value="${value#\'}"
  fi

  printf '%s' "${value:-$default}"
}

PG_CONTAINER="$(cfg PG_CONTAINER thoughtexpense-postgres)"
PG_USER="$(cfg PG_USER thoughtexpense)"
PG_DATABASE="$(cfg PG_DATABASE thoughtexpense)"
BACKUP_DIR="$(cfg BACKUP_DIR /var/backups/thought-expense)"
LOCAL_RETENTION_DAYS="$(cfg LOCAL_RETENTION_DAYS 7)"
MIN_DUMP_BYTES="$(cfg MIN_DUMP_BYTES 10000)"
SPACES_BUCKET="$(cfg BACKUP_SPACES_BUCKET)"
HEALTHCHECK_URL="$(cfg BACKUP_HEALTHCHECK_URL)"
LOCAL_ONLY="$(cfg BACKUP_LOCAL_ONLY)"

timestamp="$(date -u +%F_%H-%M-%S)"
target="${BACKUP_DIR}/db_${timestamp}.dump"
partial="${target}.partial"

log() { printf '%s  %s\n' "$(date -u +'%F %T UTC')" "$*"; }

fail() {
  log "FAILED: $*"
  rm -f "$partial"
  if [ -n "$HEALTHCHECK_URL" ]; then
    curl -fsS -m 10 "${HEALTHCHECK_URL}/fail" >/dev/null 2>&1 || true
  fi
  exit 1
}

trap 'fail "unexpected error near line $LINENO"' ERR

mkdir -p "$BACKUP_DIR"

log "dumping ${PG_DATABASE} from ${PG_CONTAINER}"
docker exec -i "$PG_CONTAINER" pg_dump -U "$PG_USER" -Fc "$PG_DATABASE" > "$partial"

size="$(wc -c < "$partial" | tr -d '[:space:]')"
[ "$size" -ge "$MIN_DUMP_BYTES" ] || fail "dump is ${size} bytes, below the ${MIN_DUMP_BYTES} minimum"

# A dump can be well-formed yet empty, so confirm the archive is readable and
# that it carries data for User — the one table that is never legitimately empty.
toc="$(docker exec -i "$PG_CONTAINER" pg_restore --list < "$partial")" || fail "archive is unreadable"
grep -qE 'TABLE DATA public "?User"?' <<<"$toc" || fail "archive contains no User table data"

mv "$partial" "$target"
log "wrote ${target} (${size} bytes)"

# Never skip the off-box copy silently: a missing bucket is a failure unless
# local-only was asked for explicitly.
if [ -n "$LOCAL_ONLY" ]; then
  log "BACKUP_LOCAL_ONLY is set — keeping a local copy only"
elif [ -z "$SPACES_BUCKET" ]; then
  fail "BACKUP_SPACES_BUCKET is not set; configure it, or set BACKUP_LOCAL_ONLY=1 to accept a local-only copy"
else
  node "${SERVER_DIR}/scripts/spaces-backup.js" upload "$target" || fail "upload to Spaces failed"
fi

pruned="$(find "$BACKUP_DIR" -maxdepth 1 -type f -name 'db_*.dump' -mtime "+${LOCAL_RETENTION_DAYS}" -print -delete | wc -l | tr -d '[:space:]')"
log "pruned ${pruned} local dump(s) older than ${LOCAL_RETENTION_DAYS} day(s)"

if [ -n "$HEALTHCHECK_URL" ]; then
  curl -fsS -m 10 "$HEALTHCHECK_URL" >/dev/null 2>&1 || log "warning: healthcheck ping failed"
fi

log "done"
