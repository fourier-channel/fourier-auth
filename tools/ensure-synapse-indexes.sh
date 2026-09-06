#!/bin/sh
# Apply db/synapse-indexes.sql to the live Synapse database and PROVE the
# result. Run on the box at deploy, after `git pull` and before trusting media.
#
#   tools/ensure-synapse-indexes.sh          apply, then verify
#   tools/ensure-synapse-indexes.sh --check  verify only (read-only)
#
# Exit 0 only when every declared index exists and is valid. Anything else is
# exit 2 with the missing/invalid names printed: a check that cannot establish
# the truth must not report green (VERIFICATION-DOCTRINE).
#
# The Synapse DB owner applies it, not fourier-auth's read-only role -- which is
# the whole reason this is a deploy step rather than something the service does
# for itself at startup.
set -eu
PG_CONTAINER="${PG_CONTAINER:-synapse-postgres-1}"
PG_USER="${PG_USER:-synapse}"
PG_DB="${PG_DB:-synapse}"
HERE=$(cd "$(dirname "$0")/.." && pwd)
SQL="$HERE/db/synapse-indexes.sql"

names=$(grep -oE 'IF NOT EXISTS [a-z_]+' "$SQL" | awk '{print $4}')

if [ "${1:-}" != "--check" ]; then
  # Autocommit, one statement at a time: CONCURRENTLY refuses a transaction.
  docker exec -i "$PG_CONTAINER" psql -U "$PG_USER" -d "$PG_DB" -v ON_ERROR_STOP=1 -q < "$SQL"
fi

bad=0
for n in $names; do
  valid=$(docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d "$PG_DB" -tAc \
    "SELECT i.indisvalid FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid WHERE c.relname='$n';")
  case "$valid" in
    t) echo "ok      $n" ;;
    f) echo "INVALID $n  (build failed; DROP INDEX and re-run)"; bad=1 ;;
    *) echo "MISSING $n"; bad=1 ;;
  esac
done
[ "$bad" -eq 0 ] || { echo "synapse indexes: NOT OK"; exit 2; }
echo "synapse indexes: all present and valid"
