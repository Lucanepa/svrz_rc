#!/usr/bin/env bash
# Publish the installed app's APK into SVRZ RC's own F-Droid repo,
# https://svrz-rc-fdroid.openvolley.app/repo. Since 14.10.2026 it is apart from
# OpenVolley's repo (get.openvolley.app), so coaches who add it see this app and
# nothing of the scoresheet; leave-openvolley-fdroid.sh took it out of there.
#
#   deploy/native/publish-fdroid.sh --init     once: create the repo and its key
#   deploy/native/publish-fdroid.sh FILE.apk   add a release
#
# Runs on lenovoserver, which also serves the repo: the svrz-fdroid container
# (deploy/hetzner/docker-compose.yml) serves $PUBLIC read-only through the
# cloudflared-lenovo tunnel. Nothing is synced to another host. The repo key
# ($FD/keystore.p12 + config.yml) never leaves $FD; back it up in Vaultwarden,
# "SVRZ RC F-Droid repo key". Losing it means every coach re-adds the repo
# under a new fingerprint (the app itself keeps updating: its key is another one).
#
# F-Droid only offers an update when versionCode grows: Tauri derives it from
# package.json's version (1.0.0 → 1000000), so every release is a version bump.
set -euo pipefail
umask 022
FD=${SVRZ_FDROID_HOME:-$HOME/.config/svrz-rc-fdroid}
# The live stack moved to ~/stacks/svrz_rc on 15.10.2026; ~/svrz_rc is gone.
PUBLIC=${SVRZ_FDROID_PUBLIC:-$HOME/stacks/svrz_rc/deploy/hetzner/fdroid-public}
REPO_URL=https://svrz-rc-fdroid.openvolley.app/repo
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
APP_ID=app.openvolley.svrzrc
# SHA-256 of the app's signing certificate: ~/.tauri/svrz-rc-android.jks,
# alias svrz-rc (infrastructure.md → "Installed app"). Android refuses an
# update signed with another key, so a different one here is a hard stop.
APP_CERT_SHA256=da0ec9546fbff26b64785023c75e0251a268702abd3c830ff0d63ae7dc750cae
REPO_ICON=svrz-rc-repo.png
die() { echo "publish-fdroid: $*" >&2; exit 1; }

INIT=0
APK=''
for a in "$@"; do
  case "$a" in
    --init) INIT=1 ;;
    -*) die "unknown option $a" ;;
    *) APK=$a ;;
  esac
done
for t in fdroid rsync python3 keytool curl; do command -v "$t" >/dev/null || die "$t not found"; done
SDK=${ANDROID_HOME:-$HOME/Android/Sdk}
bt=$(ls -d "$SDK"/build-tools/* 2>/dev/null | sort -V | tail -1)
[[ -x "$bt/apksigner" && -x "$bt/aapt2" ]] || die "no Android build-tools (set ANDROID_HOME)"

fingerprint() {
  keytool -printcert -jarfile "$FD/repo/index-v1.jar" | sed -n 's/^[[:space:]]*SHA256: //p' | tr -d ':' | head -1
}

if (( INIT )); then
  [[ -z "$APK" ]] || die "--init takes no APK; publish one afterwards"
  [[ ! -e "$FD/config.yml" ]] || die "$FD/config.yml exists: the repo is already set up"
  install -d -m 700 "$FD"
  # fdroid init makes keystore.p12 and writes its passwords into config.yml.
  (cd "$FD" && fdroid init -q --android-home "$SDK" --repo-keyalias svrz-rc-fdroid)
  cat >>"$FD/config.yml" <<EOF
repo_url: $REPO_URL
repo_name: SVRZ Referee Coaching
repo_description: >-
  The app of the referee coaches of Swiss Volley Region Zürich (SVRZ).
  Source: https://github.com/Lucanepa/svrz_rc
repo_icon: $REPO_ICON
EOF
  chmod 600 "$FD/config.yml" "$FD/keystore.p12"
  install -d -m 755 "$PUBLIC"
  echo "created the repo in $FD"
  echo "back up $FD/config.yml and $FD/keystore.p12 in Vaultwarden (\"SVRZ RC F-Droid repo key\"),"
  echo "then publish an APK: $0 FILE.apk"
  exit 0
fi

[[ -f "$APK" ]] || die "usage: $0 --init | $0 FILE.apk"
[[ -f "$FD/config.yml" && -f "$FD/keystore.p12" ]] || die "no F-Droid repo in $FD (run $0 --init once, or restore it from Vaultwarden)"
[[ -d "$PUBLIC" ]] || die "$PUBLIC missing (the svrz-fdroid container serves it)"

certs=$("$bt/apksigner" verify --print-certs "$APK") || die "$APK: not a validly signed APK"
grep -q "SHA-256 digest: $APP_CERT_SHA256" <<<"$certs" || die "$APK: not signed with the SVRZ RC app key"
badging=$("$bt/aapt2" dump badging "$APK" | sed -n '/^package:/p')
app_id=$(sed -E "s/^package: name='([^']+)'.*/\1/" <<<"$badging")
code=$(sed -E "s/.*versionCode='([0-9]+)'.*/\1/" <<<"$badging")
[[ "$app_id" == "$APP_ID" ]] || die "$APK: package $app_id, expected $APP_ID"
install -d "$FD/repo"
target="$FD/repo/${APP_ID}_${code}.apk"
if [[ -e "$target" ]] && ! cmp -s "$APK" "$target"; then
  die "$target exists with different content; raise the version instead"
fi
install -m 644 "$APK" "$target"
echo "added $target"

# The listing (name, summary, description, icon) and the repo's own icon, kept
# in this repo.
icon="$HERE/fdroid/$APP_ID/en-US/icon.png"
install -d "$FD/metadata/$APP_ID/en-US"
install -m 644 "$HERE/fdroid/$APP_ID.yml" "$FD/metadata/$APP_ID.yml"
install -m 644 "$icon" "$FD/metadata/$APP_ID/en-US/icon.png"
install -m 644 "$icon" "$FD/$REPO_ICON"

(cd "$FD" && fdroid update -q)

leak=$(find "$FD/repo" \( -iname '*.p12' -o -iname '*.jks' -o -iname '*.keystore' -o -iname 'config.yml' \
  -o -iname '*passphrase*' \) -print)
[[ -z "$leak" ]] || die "refusing to publish, key material in the repo tree: $leak"
# status/ is fdroidserver's run log (host OS, tool paths); clients never read it.
# --delay-updates puts the new index in place last, so a client never sees an
# index that points at an APK not copied yet.
rsync -rlt --delete-after --delay-updates --exclude=/status/ --chmod=D755,F644 "$FD/repo/" "$PUBLIC/repo/"

python3 - "$FD/repo/index-v2.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
for app, p in d["packages"].items():
    for v in p["versions"].values():
        m = v["manifest"]
        print(f"  fdroid  {app} {m['versionName']} ({m['versionCode']})")
PY
echo "published to $PUBLIC/repo"
echo "add in F-Droid: $REPO_URL?fingerprint=$(fingerprint)"

# Served yet? Only a warning: the first publish comes before the tunnel hostname.
if served=$(curl -fsS --max-time 15 "$REPO_URL/index-v2.json" 2>/dev/null); then
  grep -q "${APP_ID}_${code}.apk" <<<"$served" && echo "live at $REPO_URL" \
    || echo "warning: $REPO_URL does not list ${APP_ID}_${code}.apk yet (Cloudflare cache, 60 s)" >&2
else
  echo "warning: $REPO_URL not reachable (svrz-fdroid up? tunnel hostname set?)" >&2
fi
