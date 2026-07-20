# Project instructions

Before performing VPS migration, deployment, production configuration, or rollback work, read these files in order:

1. `DEPLOY_VPS.md`
2. `ADMIN.md`
3. `BACKUP.md`

Security requirements:

- Never print, commit, upload, or copy secret values into documentation or chat output.
- Never commit `.env`, SSH private keys, `src/content/posts/*.md`, `server/data/`, `server/backups/`, `server/trash/`, or generated `dist/` files.
- The public framework repository and private article repository are separate repositories.
- Store SSH private keys in the service user's `.ssh` directory. Environment variables contain only their paths.
- Keep the Admin service bound to `127.0.0.1`; expose it only through the HTTPS reverse proxy and Cloudflare Access.
- Before every production change, run the relevant tests and build. Preserve the previous working deployment until verification succeeds.
