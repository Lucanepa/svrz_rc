# Automatic deploy to Codeberg Pages

This repository includes a Woodpecker CI pipeline in `.woodpecker.yml` that:

1. installs dependencies with `npm ci`
2. builds the app with `npm run build`
3. deploys `dist/` to the `pages` branch on each push to `main`

## One-time setup on Codeberg

1. Generate a dedicated SSH key pair for CI:
   - `ssh-keygen -t ed25519 -f codeberg-pages-key -N ""`
2. In your Codeberg repo settings, add `codeberg-pages-key.pub` as a **Deploy Key** with **Write access**.
3. In Woodpecker/CI secrets, add a secret named `codeberg_pages_ssh_key` containing the private key (`codeberg-pages-key` file content).
4. Ensure your repository (or pages target repository) is public so Pages can serve it.

## Notes

- By default, deployment targets the current repo and `pages` branch.
- If you want to deploy to another repo (for example `username/username.codeberg.page`), set `repository_name` in `.woodpecker.yml`.
