#!/bin/bash
# Ship the API (server/ + the src/lib files it imports) to the live stack on lenovoserver.
#
#   scripts/deploy-api.sh            # from lenovoserver itself, or from anywhere `ssh lenovoserver` works
#
# The host tree (/home/lucanepa/svrz_rc) is a FILE COPY, not a git checkout: never `git pull` there.
# Copy first, then build — a rebuild on stale files succeeds loudly and ships nothing.
# Deploy the API BEFORE pushing a main that depends on it (push main = Pages deploy).
# A new PocketBase collection goes in before this runs: see infrastructure.md ("schema before code").
set -euo pipefail

HOST=${DEPLOY_HOST:-lenovoserver}
DEST=/home/lucanepa/svrz_rc
COMPOSE="docker compose -p svrz-rc -f $DEST/deploy/hetzner/docker-compose.yml"   # -p svrz-rc is NOT optional

cd "$(git rev-parse --show-toplevel)"
if [ -n "$(git status --porcelain)" ]; then
  echo "Working tree not clean — commit first (the deploy ships HEAD)." >&2; exit 1
fi

if [ "$(hostname)" = "$HOST" ]; then run() { bash -c "$1"; }; target="$DEST/"
else run() { ssh "$HOST" "$1"; }; target="$HOST:$DEST/"; fi

export_dir=$(mktemp -d); trap 'rm -rf "$export_dir"' EXIT
git archive HEAD | tar -x -C "$export_dir"

# No --delete: the host keeps secret backups (svrz-api.env.bak-*) and snapshots that exist nowhere else.
rsync -a \
  --exclude pb_data/ --exclude logs/ --exclude 'svrz-api.env*' --exclude '.env*' \
  --exclude .git/ --exclude node_modules/ --exclude dist/ --exclude .claude/ \
  "$export_dir/" "$target"

echo "Copied $(git rev-parse --short HEAD). Rebuilding svrz-api…"
# A "container name … already in use" conflict at the end is a leftover of Docker's rename and harmless:
# check `docker ps -a --filter name=svrz-rc` before touching anything.
run "$COMPOSE up -d --build svrz-api" || true
run "docker ps -a --filter name=svrz-rc --format '{{.Names}}  {{.Status}}'"

for i in $(seq 1 20); do
  if run "curl -fsS 127.0.0.1:8787/api/health" >/dev/null 2>&1; then break; fi; sleep 3
done
run "curl -fsS 127.0.0.1:8787/api/health" && echo
curl -fsS -o /dev/null -w "public svrz-rc-api.openvolley.app: %{http_code}\n" https://svrz-rc-api.openvolley.app/api/health
curl -fsS -o /dev/null -w "public rc-api.lucanepa.com:        %{http_code}\n" https://rc-api.lucanepa.com/api/health
