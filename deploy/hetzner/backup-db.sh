#!/usr/bin/env bash
#
# A CONSISTENT snapshot of the svrz_rc data, taken nightly just before the
# host's borg run. Since 10.10.2026 that is PostgreSQL plus the filed form PDFs
# (docs/postgres-prisma-plan.md); before, it was PocketBase (backup-pb.sh).
#
# Why this exists even though borg archives the whole host: borg copies the
# cluster's files while Postgres is writing them, which is a copy that usually
# restores. pg_dump is a transaction-consistent export that always does. The
# database is the only copy of every feedback, president's note and credential
# hash in the association, which is not a place for "usually".
#
#   svrz-rc-db-<stamp>.dump      pg_dump -Fc (restore: pg_restore --clean -d svrz)
#   svrz-rc-files-<stamp>.tar.gz the files volume (the filed PDFs)
#
# Both are verified by reading them back, then rotated; borg carries them
# offsite. Runs as lucanepa (docker group). Scheduled by svrz-rc-backup.timer at
# 02:45, comfortably before borg-backup.timer at ~03:05.

set -euo pipefail

# Overridable only so the script can be rehearsed against a throwaway cluster.
STACK_DIR=${STACK_DIR:-/home/lucanepa/svrz_rc/deploy/hetzner}
OUT_DIR=${OUT_DIR:-/home/lucanepa/svrz_rc/backups}
PG_CONTAINER=${PG_CONTAINER:-svrz-rc-postgres-1}
KEEP=14
STAMP=$(date +%Y%m%d-%H%M%S)
DUMP="svrz-rc-db-${STAMP}.dump"
FILES="svrz-rc-files-${STAMP}.tar.gz"

log() { printf '%s %s\n' "$(date -Iseconds)" "$*"; }

# Anything that goes wrong has to be LOUD and has to leave a trace a human trips
# over. The borg backup on this host failed two nights running in August 2026 and
# nobody knew, because a failing cron job is indistinguishable from a quiet one.
FAILED_MARKER=${FAILED_MARKER:-/home/lucanepa/BACKUP-FAILED-svrz-rc}
fail() {
  log "FAILED: $*"
  { echo "$(date -Iseconds) svrz-rc backup FAILED: $*"; } >> "$FAILED_MARKER"
  rm -f "$OUT_DIR/$DUMP.part" "$OUT_DIR/$FILES.part"
  exit 1
}

mkdir -p "$OUT_DIR"
log "starting snapshot $STAMP"

# --- 1. The database --------------------------------------------------------
# Inside the container: no password leaves it, no client needed on the host.
docker exec "$PG_CONTAINER" pg_dump -U svrz -d svrz -Fc > "$OUT_DIR/$DUMP.part" \
  || fail "pg_dump failed"
# Never trust a backup nobody opened: list it, and count the tables with data.
tables=$(docker exec -i "$PG_CONTAINER" pg_restore --list < "$OUT_DIR/$DUMP.part" | grep -c 'TABLE DATA' || true)
[ "${tables:-0}" -ge 15 ] || fail "the dump lists only ${tables:-0} tables with data (expected 15+)"
# An empty database dumps and lists perfectly well. The games table alone is
# thousands of rows; a near-empty dump is a wrong database, not a quiet night.
games=$(docker exec "$PG_CONTAINER" psql -U svrz -d svrz -Atc 'SELECT count(*) FROM games' || echo 0)
[ "${games:-0}" -ge 100 ] || fail "games has only ${games:-0} rows — refusing to call that a backup"
mv "$OUT_DIR/$DUMP.part" "$OUT_DIR/$DUMP"
log "verified $(du -h "$OUT_DIR/$DUMP" | cut -f1) $DUMP ($tables tables, $games games)"

# --- 2. The files -----------------------------------------------------------
tar -czf "$OUT_DIR/$FILES.part" -C "$STACK_DIR" files || fail "could not archive the files"
tar -tzf "$OUT_DIR/$FILES.part" > /dev/null || fail "the files archive does not read back"
mv "$OUT_DIR/$FILES.part" "$OUT_DIR/$FILES"
log "verified $(du -h "$OUT_DIR/$FILES" | cut -f1) $FILES ($(tar -tzf "$OUT_DIR/$FILES" | grep -vc '/$') files)"

# --- 3. Rotate --------------------------------------------------------------
# Local copies are the near-term recovery point; borg carries the long tail
# (30 daily / 4 weekly / 6 monthly, offsite). The PocketBase-era zips are left
# alone: the last of them is the rollback point of the move.
for pattern in 'svrz-rc-db-*.dump' 'svrz-rc-files-*.tar.gz'; do
  mapfile -t old < <(ls -1t "$OUT_DIR"/$pattern 2>/dev/null | tail -n "+$((KEEP + 1))")
  for f in "${old[@]:-}"; do
    [ -n "$f" ] || continue
    log "rotating out $(basename "$f")"
    rm -f "$f"
  done
done

# --- 4. Report on the OFFSITE copy too --------------------------------------
# This script protects against losing the disk only if something else is taking
# the dump away. Borg is that something, and its silence is what hid a two-night
# outage, so say plainly when it last succeeded.
if [ -r /var/log/borg-backup.log ]; then
  last_ok=$(grep -F "backup done" /var/log/borg-backup.log | tail -1 | grep -oE '^=== [^ ]+' | cut -d' ' -f2 || true)
  if [ -n "${last_ok:-}" ]; then
    age_h=$(( ( $(date +%s) - $(date -d "$last_ok" +%s) ) / 3600 ))
    log "last successful offsite (borg) run: $last_ok (${age_h}h ago)"
    [ "$age_h" -gt 48 ] && log "WARNING: the offsite copy is more than 48h old"
  else
    log "WARNING: no successful borg run found in its log"
  fi
fi

log "done"
