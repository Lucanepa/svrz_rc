#!/usr/bin/env bash
# The installed svrz-rc-backup.service still names this file. Since the move to
# Postgres (10.10.2026) the nightly snapshot is backup-db.sh; PocketBase is
# retired (11.10.2026). Once the unit points at backup-db.sh
# (deploy/hetzner/systemd, then `sudo systemctl daemon-reload`), delete this file.
exec "$(dirname "$0")/backup-db.sh" "$@"
