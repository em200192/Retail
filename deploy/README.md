# Deploying TillMate

On a fresh Ubuntu 22.04/24.04 server (2 GB RAM or more), from the repository root:

```bash
sudo ./deploy/install.sh
```

Or by hand: `cp .env.example .env`, fill it in, then `docker compose -f docker-compose.prod.yml up -d --build`.

It installs Docker, writes `.env` with random secrets, builds the images and starts:

| Address | What |
|---|---|
| `https://app.<DOMAIN>` | Back office (sign up the first shop here) |
| `https://till.<DOMAIN>` | Till web app (open on the shop's tablet, paste the pairing code) |
| `https://api.<DOMAIN>` | API (`/health`) |

Until you own a domain, `DOMAIN` is `<ip-with-dashes>.sslip.io`, which points at the server so HTTPS
certificates work. To switch to your own domain, add DNS A records for `app`, `till` and `api` pointing
at the server, set `DOMAIN=` in `.env`, and run `install.sh` again (the till pairing codes change).

- Set `ANTHROPIC_API_KEY` in `.env` to read supplier invoices; without it invoices show as not read.
- Data lives in Docker volumes `pgdata` (database) and `files` (invoice uploads). Back them up daily:
  `docker compose -f docker-compose.prod.yml exec db pg_dump -U postgres retail | gzip > backup.sql.gz`
- Update: `git pull && sudo ./deploy/install.sh`.
