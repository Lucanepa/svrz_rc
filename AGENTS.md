# Agent Instructions

## Startup Context

At the start of each session, read `infrastructure.md` before giving infrastructure, deployment, networking, Docker, Cloudflare Tunnel, or PocketBase guidance.

## Maintenance Rule

When infrastructure changes are made, update `infrastructure.md` in the same change.

## The shared VolleyManager account (cross-repo)

There is ONE VolleyManager login and the **wiedisync** project (`~/repos/wiedisync`,
Directus on hetzner) uses the same one. VM keeps the active role per *account*, not
per session, so two jobs overlapping means the loser reads under the winner's role —
which for club-scoped resources is a 200 with the wrong rows, not a 403. Neither
project can lock the other: their `claimVmAccount` and our `withVmLock`
(`server/vmlock.ts`) each guard only their own process, on different hosts.

Before adding, moving or rescheduling anything that talks to VolleyManager:

1. Read the window table in `infrastructure.md` → "The shared VolleyManager account".
2. Check `~/repos/wiedisync/INFRA.md` → the same section, for what runs there now.
3. When you change a window or add a job, update **both** files in the same change.
   A window written down in only one repo is not a window, and the failure it causes
   in the other project is silent.

`kscw-website` deliberately holds no VolleyManager credentials — it only links to
volleyball.ch. Do not give it any.
