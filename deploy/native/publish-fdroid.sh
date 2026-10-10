#!/usr/bin/env bash
# Publish the installed app's APK into OpenVolley's public F-Droid repo
# (https://get.openvolley.app/fdroid/repo), next to the OpenVolley apps.
#
#   deploy/native/publish-fdroid.sh [--no-sync] FILE.apk
#
# Runs on lenovoserver: the repo's signing key and working copy live there, in
# ~/.config/openvolley-pkgs, which belongs to OpenVolley's publish-pkgs.sh
# (github.com/Lucanepa/openvolley, escoresheet/deploy/). This does that script's
# F-Droid steps for one more app and nothing else. The two do not fight: the
# OpenVolley script only vets the APKs it is handed and keeps every APK already
# in the repo. Its APT half, though, would rename any second package to
# OpenVolley's, which is why the .deb is not published there (the AppImage on
# the GitHub release updates itself instead).
#
# Coaches add the repo once in F-Droid (the QR code / link on
# https://get.openvolley.app) and install "SVRZ Referee Coaching". F-Droid only
# offers an update when versionCode grows: Tauri derives it from package.json's
# version (1.0.0 → 1000000), so every release is a version bump.
set -euo pipefail
umask 022
PKGS=${OV_PKGS_HOME:-$HOME/.config/openvolley-pkgs}
DEST=${OV_PKGS_DEST:-hetzner:/data/openvolley/pkgs/}
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
APP_ID=app.openvolley.svrzrc
# SHA-256 of the app's signing certificate: ~/.tauri/svrz-rc-android.jks,
# alias svrz-rc (infrastructure.md → "Installed app"). Android refuses an
# update signed with another key, so a different one here is a hard stop.
APP_CERT_SHA256=da0ec9546fbff26b64785023c75e0251a268702abd3c830ff0d63ae7dc750cae
FD="$PKGS/fdroid"
PUB="$PKGS/public"
die() { echo "publish-fdroid: $*" >&2; exit 1; }

SYNC=1
APK=''
for a in "$@"; do
  case "$a" in
    --no-sync) SYNC=0 ;;
    -*) die "unknown option $a" ;;
    *) APK=$a ;;
  esac
done
[[ -f "$APK" ]] || die "usage: $0 [--no-sync] FILE.apk"
[[ -f "$FD/config.yml" && -f "$FD/keystore.p12" ]] || die "no F-Droid repo in $FD (restore it from Vaultwarden, see OpenVolley's ANDROID.md)"
for t in fdroid rsync python3; do command -v "$t" >/dev/null || die "$t not found"; done
bt=$(ls -d "${ANDROID_HOME:-$HOME/Android/Sdk}"/build-tools/* 2>/dev/null | sort -V | tail -1)
[[ -x "$bt/apksigner" && -x "$bt/aapt2" ]] || die "no Android build-tools (set ANDROID_HOME)"

certs=$("$bt/apksigner" verify --print-certs "$APK") || die "$APK: not a validly signed APK"
grep -q "SHA-256 digest: $APP_CERT_SHA256" <<<"$certs" || die "$APK: not signed with the SVRZ RC app key"
badging=$("$bt/aapt2" dump badging "$APK" | sed -n '/^package:/p')
app_id=$(sed -E "s/^package: name='([^']+)'.*/\1/" <<<"$badging")
code=$(sed -E "s/.*versionCode='([0-9]+)'.*/\1/" <<<"$badging")
[[ "$app_id" == "$APP_ID" ]] || die "$APK: package $app_id, expected $APP_ID"
target="$FD/repo/${APP_ID}_${code}.apk"
if [[ -e "$target" ]] && ! cmp -s "$APK" "$target"; then
  die "$target exists with different content; raise the version instead"
fi
install -m 644 "$APK" "$target"
echo "added $target"

# The listing: name, summary, description, icon (kept in this repo).
install -d "$FD/metadata/$APP_ID/en-US"
install -m 644 "$HERE/fdroid/$APP_ID.yml" "$FD/metadata/$APP_ID.yml"
install -m 644 "$HERE/fdroid/$APP_ID/en-US/icon.png" "$FD/metadata/$APP_ID/en-US/icon.png"

(cd "$FD" && fdroid update -q)
mkdir -p "$PUB/fdroid"
# status/ is fdroidserver's run log (host OS, tool paths); clients never read it.
rsync -a --delete --delete-excluded --exclude=/status/ "$FD/repo/" "$PUB/fdroid/repo/"

leak=$(find "$PUB" \( -iname '*.p12' -o -iname '*.jks' -o -iname '*.keystore' -o -iname 'config.yml' \
  -o -iname '*passphrase*' -o -iname 'private-keys-v1.d' \) -print)
[[ -z "$leak" ]] || die "refusing to publish, key material in the public tree: $leak"
chmod -R u=rwX,go=rX "$PUB/fdroid"

python3 - "$FD/repo/index-v2.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
for app, p in d["packages"].items():
    for v in p["versions"].values():
        m = v["manifest"]
        print(f"  fdroid  {app} {m['versionName']} ({m['versionCode']})")
PY

if (( SYNC )); then
  # The F-Droid folder only: the rest of the public tree is OpenVolley's to
  # sync. --delay-updates puts the new index in place last, so a client never
  # sees an index that points at an APK not uploaded yet.
  rsync -rlt --delete-after --delay-updates --chmod=D755,F644 "$PUB/fdroid/" "${DEST%/}/fdroid/"
  echo "synced fdroid/ to $DEST"
else
  echo "not synced (--no-sync); tree: $PUB/fdroid"
fi
