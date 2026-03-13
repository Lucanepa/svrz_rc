# Infrastructure Private Secrets Template

This file is a template only. Do not commit real secrets.
Copy to `infrastructure.private.md` and fill values there.

## Backend Runtime Secrets (`~/apps/svrz_rc/.env.local`)

- `POCKETBASE_ADMIN_EMAIL=...`
- `POCKETBASE_ADMIN_PASSWORD=...`
- `ADMIN_SESSION_SECRET=...`
- `VM_USERNAME=...`
- `VM_PASSWORD=...`
- `SMTP_USER=...`
- `SMTP_PASS=...`

## CI Secret Values

- `vite_api_base_url=https://rc-api.volleyball.lucanepa.com`

## Rotation Notes

- Rotate immediately if exposed in logs/chat/screenshots.
- Restart API after env changes: `pm2 restart svrz-api --update-env`.
