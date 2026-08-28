#!/usr/bin/env bash
#
# A CONSISTENT snapshot of the svrz_rc PocketBase, taken nightly just before the
# host's borg run.
#
# Why this exists even though borg already archives the whole host: borg copies
# `pb_data/data.db` at the filesystem level while PocketBase is running. SQLite
# in WAL mode is mid-transaction at arbitrary moments, so a file-level copy of a
# live database is not a guaranteed-restorable artifact — it is a copy that
# usually works. `pb_data` is the only copy of every feedback, PDF, president's
# note and credential hash in the association, which is not a place for "usually".
#
# PocketBase's own /api/backups endpoint checkpoints the WAL and zips a coherent
# snapshot. That zip is what borg then archives, so the offsite copy contains
# something known-restorable rather than something probably-restorable.
#
# The snapshot is moved OUT of pb_data afterwards. A backup that lives inside the
# directory it is backing up is not a second copy of anything, and it would grow
# the next snapshot with the previous one.
#
# Runs as lucanepa (needs docker group). Scheduled by svrz-rc-backup.timer at
# 02:45, comfortably before borg-backup.timer at ~03:05.

set -euo pipefail

STACK_DIR=/home/lucanepa/svrz_rc/deploy/hetzner
OUT_DIR=/home/lucanepa/svrz_rc/backups
PB_BACKUP_DIR="$STACK_DIR/pb_data/backups"
API_CONTAINER=svrz-rc-svrz-api-1
KEEP=14
# All lowercase, digits and hyphens only: PocketBase validates the backup name
# against that shape and answers 400 "Must be in a valid format" for anything
# else — an ISO stamp's "T" is enough to be refused.
STAMP=$(date +%Y%m%d-%H%M%S)
NAME="svrz-rc-${STAMP}.zip"

log() { printf '%s %s\n' "$(date -Iseconds)" "$*"; }

# Anything that goes wrong has to be LOUD and has to leave a trace a human trips
# over. The borg backup on this host failed two nights running in August 2026 and
# nobody knew, because a failing cron job is indistinguishable from a quiet one.
FAILED_MARKER=/home/lucanepa/BACKUP-FAILED-svrz-rc
fail() {
  log "FAILED: $*"
  { echo "$(date -Iseconds) svrz-rc backup FAILED: $*"; } >> "$FAILED_MARKER"
  exit 1
}

mkdir -p "$OUT_DIR"

log "starting snapshot $NAME"

# --- 1. Ask PocketBase for a coherent snapshot -------------------------------
# Driven from the API container: it already holds the superuser credentials and
# can reach pocketbase:8090 on the internal network, so no secret has to be read
# out onto the host or into this script.
docker exec "$API_CONTAINER" node -e '
(async () => {
  const base = process.env.POCKETBASE_URL;
  const name = process.argv[1];
  const auth = await fetch(base + "/api/collections/_superusers/auth-with-password", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      identity: process.env.POCKETBASE_ADMIN_EMAIL,
      password: process.env.POCKETBASE_ADMIN_PASSWORD,
    }),
  });
  if (!auth.ok) throw new Error("auth " + auth.status);
  const { token } = await auth.json();
  const made = await fetch(base + "/api/backups", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: token },
    body: JSON.stringify({ name }),
  });
  if (!made.ok) throw new Error("backup " + made.status + " " + (await made.text()).slice(0, 300));
})().catch((e) => { console.error(e.message); process.exit(1); });
' "$NAME" || fail "PocketBase refused to make the snapshot"

[ -f "$PB_BACKUP_DIR/$NAME" ] || fail "PocketBase reported success but $NAME is not in $PB_BACKUP_DIR"

# --- 2. Move it off pb_data --------------------------------------------------
mv "$PB_BACKUP_DIR/$NAME" "$OUT_DIR/$NAME"
# PocketBase writes a sidecar of the same name for its own metadata; it is of no
# use once the zip has left, and leaving it accumulates one file per night.
rm -f "$PB_BACKUP_DIR/$NAME.attrs"

# --- 3. Verify it is actually a restorable archive ---------------------------
# Never trust a backup nobody opened. python3 is the one zip reader present on
# this host (no unzip), and it also lets the CONTENT be checked, not just the
# CRCs — an archive that is valid but has no data.db in it is worse than an
# error, because it looks like a backup.
python3 - "$OUT_DIR/$NAME" <<'PY' || fail "the snapshot did not verify"
import sys, zipfile
path = sys.argv[1]
with zipfile.ZipFile(path) as z:
    bad = z.testzip()
    if bad is not None:
        print(f"corrupt member: {bad}")
        sys.exit(1)
    names = z.namelist()
    for required in ("data.db", "auxiliary.db"):
        if not any(n.endswith(required) for n in names):
            print(f"no {required} in the archive")
            sys.exit(1)
    data = next(n for n in names if n.endswith("data.db"))
    size = z.getinfo(data).file_size
    # An empty or absurdly small data.db means PocketBase wrote a snapshot of
    # nothing, which zips and verifies perfectly well.
    if size < 200_000:
        print(f"data.db is only {size} bytes — refusing to call that a backup")
        sys.exit(1)
    print(f"ok: {len(names)} entries, data.db {size} bytes")
PY

log "verified $(du -h "$OUT_DIR/$NAME" | cut -f1) $OUT_DIR/$NAME"

# --- 4. Rotate ---------------------------------------------------------------
# Local copies are the near-term recovery point; borg carries the long tail
# (30 daily / 4 weekly / 6 monthly, offsite). KEEP only has to cover the gap
# between a bad day and somebody noticing.
mapfile -t old < <(ls -1t "$OUT_DIR"/svrz-rc-*.zip 2>/dev/null | tail -n "+$((KEEP + 1))")
for f in "${old[@]:-}"; do
  [ -n "$f" ] || continue
  log "rotating out $(basename "$f")"
  rm -f "$f"
done

# --- 5. Report on the OFFSITE copy too ---------------------------------------
# This script protects against losing the disk only if something else is taking
# the zip away. Borg is that something, and its silence is what hid a two-night
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
