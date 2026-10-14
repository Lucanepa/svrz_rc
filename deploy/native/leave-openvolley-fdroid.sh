#!/usr/bin/env bash
# One time (14.10.2026): take SVRZ RC out of OpenVolley's F-Droid repo
# (https://get.openvolley.app/fdroid/repo), where publish-fdroid.sh put it up to
# 1.3.0, now that it has a repo of its own.
#
#   deploy/native/leave-openvolley-fdroid.sh [--no-sync]
#
# Runs on lenovoserver, in OpenVolley's working copy ~/.config/openvolley-pkgs
# (owned by OpenVolley's publish-pkgs.sh, which takes no lock: do not run the
# two at the same time). Removes this app's APKs, listing and
# icons, rebuilds the index, and syncs fdroid/ to hetzner as publish-fdroid.sh
# used to. Refuses to run before the new repo serves the app, so a coach on
# F-Droid is never left with no repo carrying it. Run it again: it finds
# nothing left and changes nothing.
#
# Coaches who added OpenVolley's repo keep the installed app. F-Droid stops
# offering its updates there; the app's own update check (GitHub release) still
# tells them, and adding the new repo once brings F-Droid updates back: same
# app key, so it updates in place.
set -euo pipefail
umask 022
PKGS=${OV_PKGS_HOME:-$HOME/.config/openvolley-pkgs}
DEST=${OV_PKGS_DEST:-hetzner:/data/openvolley/pkgs/}
NEW_REPO=https://svrz-rc-fdroid.openvolley.app/repo
APP_ID=app.openvolley.svrzrc
FD="$PKGS/fdroid"
PUB="$PKGS/public"
die() { echo "leave-openvolley-fdroid: $*" >&2; exit 1; }

SYNC=1
for a in "$@"; do
  case "$a" in
    --no-sync) SYNC=0 ;;
    *) die "unknown argument $a" ;;
  esac
done
[[ -f "$FD/config.yml" && -f "$FD/keystore.p12" ]] || die "no F-Droid repo in $FD"
for t in fdroid rsync python3 curl; do command -v "$t" >/dev/null || die "$t not found"; done

curl -fsS --max-time 15 "$NEW_REPO/index-v2.json" | python3 -c '
import json, sys
sys.exit(0 if sys.argv[1] in json.load(sys.stdin).get("packages", {}) else 1)
' "$APP_ID" || die "$NEW_REPO does not serve $APP_ID yet: publish it there first (publish-fdroid.sh)"

shopt -s nullglob
# fdroid update names the per-version icons <app id>.<versionCode>.png in
# icons*/ and does not remove them when the APK goes.
gone=( "$FD"/repo/"${APP_ID}"_* "$FD"/archive/"${APP_ID}"_* "$FD"/unsigned/"${APP_ID}"_*
       "$FD"/repo/icons*/"${APP_ID}".*.png "$FD"/archive/icons*/"${APP_ID}".*.png
       "$FD/repo/$APP_ID" "$FD/archive/$APP_ID" "$FD/metadata/$APP_ID" "$FD/metadata/$APP_ID.yml" )
for f in "${gone[@]}"; do
  [[ -e "$f" ]] || continue
  rm -rf -- "$f"
  echo "removed $f"
done

(cd "$FD" && fdroid update -q)
mkdir -p "$PUB/fdroid"
# As OpenVolley's publish-pkgs.sh: status/ is fdroidserver's run log.
rsync -a --delete --delete-excluded --exclude=/status/ "$FD/repo/" "$PUB/fdroid/repo/"

leak=$(find "$PUB" \( -iname '*.p12' -o -iname '*.jks' -o -iname '*.keystore' -o -iname 'config.yml' \
  -o -iname '*passphrase*' -o -iname 'private-keys-v1.d' \) -print)
[[ -z "$leak" ]] || die "refusing to publish, key material in the public tree: $leak"
chmod -R u=rwX,go=rX "$PUB/fdroid"

python3 - "$FD/repo/index-v2.json" "$APP_ID" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
if sys.argv[2] in d["packages"]:
    sys.exit(f"{sys.argv[2]} is still in the index")
for app, p in d["packages"].items():
    for v in p["versions"].values():
        m = v["manifest"]
        print(f"  fdroid  {app} {m['versionName']} ({m['versionCode']})")
PY

if (( SYNC )); then
  # The F-Droid folder only; --delay-updates puts the new index in place last.
  rsync -rlt --delete-after --delay-updates --chmod=D755,F644 "$PUB/fdroid/" "${DEST%/}/fdroid/"
  echo "synced fdroid/ to $DEST"
else
  echo "not synced (--no-sync); tree: $PUB/fdroid"
fi
