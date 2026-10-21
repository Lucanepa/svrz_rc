#!/usr/bin/env bash
# Put the newest installed-app release into SVRZ RC's F-Droid repo, by itself.
#
#   deploy/native/sync-fdroid.sh        run by svrz-rc-fdroid-sync.timer every 10 min
#
# A `native-v<version>` tag releases to GitHub (svrz-referee-coaching) and
# nothing more: the F-Droid repo lives on lenovoserver with its key, so 1.3.4
# sat on GitHub while the phones, which update through F-Droid, kept offering
# nothing (Luca, 21.10.2026). This closes that gap from this side — the key never
# leaves the host and GitHub needs no way in.
#
# The newest release is read off github.com's own `releases/latest` redirect and
# the APK's fixed name, never the REST API: unauthenticated, that one is
# rate-limited per IP, and this host shares its IP with everything else on it.
# A release whose APK is not uploaded yet answers 404 and is simply tried again
# on the next run. publish-fdroid.sh does the rest — including refusing an APK
# not signed with the SVRZ RC app key, so a release that is not ours never
# reaches a coach's phone.
set -euo pipefail
umask 022
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
FD=${SVRZ_FDROID_HOME:-$HOME/.config/svrz-rc-fdroid}
RELEASES=https://github.com/Lucanepa/svrz-referee-coaching/releases
APP_ID=app.openvolley.svrzrc
say() { echo "$(date -Is) sync-fdroid: $*"; }

latest=$(curl -fsS --max-time 20 -o /dev/null -w '%{redirect_url}' "$RELEASES/latest") \
  || { say "github.com not reachable"; exit 0; }
tag=${latest##*/tag/}
[[ "$tag" =~ ^native-v([0-9]+)\.([0-9]+)\.([0-9]+)$ ]] || { say "no release tag in '$latest'"; exit 0; }
version="${BASH_REMATCH[1]}.${BASH_REMATCH[2]}.${BASH_REMATCH[3]}"
# Tauri's versionCode for x.y.z, the one publish-fdroid.sh names the file by.
code=$(( BASH_REMATCH[1] * 1000000 + BASH_REMATCH[2] * 1000 + BASH_REMATCH[3] ))
[[ -e "$FD/repo/${APP_ID}_${code}.apk" ]] && exit 0   # already in the repo: the usual case, and silent

work=$(mktemp -d); trap 'rm -rf "$work"' EXIT
apk="$work/SVRZ-RC_${version}_android.apk"
status=$(curl -sSL --max-time 600 -o "$apk" -w '%{http_code}' "$RELEASES/download/$tag/SVRZ-RC_${version}_android.apk") || status=000
if [[ "$status" != 200 ]]; then
  say "$tag: APK not downloadable yet (HTTP $status), next run tries again"
  exit 0
fi
say "$tag: publishing $version ($code) to F-Droid"
"$HERE/publish-fdroid.sh" "$apk"
