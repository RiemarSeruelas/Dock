# DockFlow Ubuntu PostgreSQL + HTTPS deployment

This release uses PostgreSQL on the DockFlow Ubuntu host as the authoritative store for accounts, suppliers, materials, deliveries, audit history, notifications, imports, settings, and related application data. The SAP `Analysis` tables remain a separate connection and are not changed by this migration.

The application imports `data/trial-data.json` only once when the PostgreSQL application tables are empty. After that first successful import, DockFlow reads and writes PostgreSQL only.

## 1. Back up the current server data

Run these commands from `/opt/DockFlow-POC-Source` before replacing or rebuilding anything:

```bash
mkdir -p backups
cp data/trial-data.json "backups/trial-data-before-postgres-$(date +%Y%m%d-%H%M%S).json"
```

If the Ubuntu PostgreSQL service already contains important databases, also create a server-side backup before continuing.

## 2. Create the dedicated PostgreSQL database

Install PostgreSQL if it is not already installed:

```bash
sudo apt update
sudo apt install -y postgresql postgresql-contrib
sudo systemctl enable --now postgresql
```

Generate and safely retain a strong password:

```bash
openssl rand -base64 36
```

Open PostgreSQL as its administrator:

```bash
sudo -u postgres psql
```

Run the following SQL, replacing `PASTE_A_LONG_RANDOM_PASSWORD` with the generated password. Keep the double quotes around the database and schema names.

```sql
CREATE ROLE dockflow_app WITH LOGIN PASSWORD 'PASTE_A_LONG_RANDOM_PASSWORD';
CREATE DATABASE "Dockflow" OWNER dockflow_app;
\connect "Dockflow"
CREATE SCHEMA IF NOT EXISTS "Dockflow" AUTHORIZATION dockflow_app;
GRANT ALL PRIVILEGES ON DATABASE "Dockflow" TO dockflow_app;
\quit
```

If the role or database already exists, do not recreate or drop it. Instead, confirm ownership and change only the password if needed:

```sql
ALTER ROLE dockflow_app WITH LOGIN PASSWORD 'PASTE_A_LONG_RANDOM_PASSWORD';
ALTER DATABASE "Dockflow" OWNER TO dockflow_app;
```

## 3. Allow password login through the local PostgreSQL socket

Find the active authentication file:

```bash
sudo -u postgres psql -tAc "SHOW hba_file;"
```

Edit that file and add this line before broader `local ... peer` rules:

```text
local   Dockflow   dockflow_app   scram-sha-256
```

Reload PostgreSQL:

```bash
sudo systemctl reload postgresql
sudo -u postgres psql -d "Dockflow" -c 'SELECT current_database(), current_user;'
```

DockFlow mounts `/var/run/postgresql` into the API container, so PostgreSQL port 5432 does not need to be opened in UFW or exposed publicly.

## 4. Configure DockFlow

Keep the server's existing secrets and SAP settings, but make sure `/opt/DockFlow-POC-Source/.env` contains these values:

```env
APP_PORT=5059
APP_ORIGIN=https://dockflow.myvnc.com
CORS_ORIGINS=https://dockflow.myvnc.com
ALLOW_PRIVATE_NETWORK_ORIGINS=false
COOKIE_SECURE=true

APP_STORAGE=postgres
DB_ENABLED=true
DB_HOST=/var/run/postgresql
DB_PORT=5432
DB_NAME=Dockflow
DB_USER=dockflow_app
DB_PASSWORD=PASTE_A_LONG_RANDOM_PASSWORD
DB_SCHEMA=Dockflow
DB_SSL=false
DB_POOL_MAX=10
POSTGRES_IMPORT_FILE=/app/data/trial-data.json

WEB_TRUSTED_PROXY_CIDRS=172.16.0.0/12
```

Do not replace `POSTGRES_HOST`, `POSTGRES_DB`, `POSTGRES_SCHEMA`, or the other `POSTGRES_*` SAP settings with these values. `DB_*` is DockFlow application storage; `POSTGRES_*` remains the SAP worksheet connection.

## 5. Import the JSON data and start DockFlow

The first successful API startup creates the PostgreSQL tables and imports the current `data/trial-data.json`. The import is guarded by a database marker and will not run again on later restarts.

```bash
cd /opt/DockFlow-POC-Source
docker compose config
docker compose up -d --build --force-recreate
docker compose ps
docker compose logs --tail=150 api
```

Verify that PostgreSQL is the primary store and inspect the imported row counts:

```bash
curl -s http://127.0.0.1:5059/api/health
docker compose exec api npm run db:verify
```

The health response must contain `"primaryStorage":"postgres"` and `"connected":true`. Sign in and create one test delivery before archiving the JSON migration file. Once verified, the JSON file is no longer used by the running application.

## 6. Configure Nginx for the domain

First ensure the public DNS `A` record for `dockflow.myvnc.com` points to this Ubuntu server's public IPv4. Remove an `AAAA` record unless the server also has working public IPv6.

Install the included Nginx site:

```bash
sudo cp deployment/nginx/dockflow.conf /etc/nginx/sites-available/dockflow.conf
sudo ln -sfn /etc/nginx/sites-available/dockflow.conf /etc/nginx/sites-enabled/dockflow.conf
sudo nginx -t
sudo systemctl reload nginx
```

DockFlow now binds port 5059 only to `127.0.0.1`; Nginx is the public entry point. The only public web ports needed are 80 and 443:

```bash
sudo ufw allow 'Nginx Full'
sudo ufw status
```

Test HTTP before requesting the certificate:

```bash
curl -I http://dockflow.myvnc.com
```

## 7. Enable HTTPS with Let's Encrypt

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx --redirect -d dockflow.myvnc.com
sudo nginx -t
sudo systemctl reload nginx
sudo certbot renew --dry-run
```

Final checks:

```bash
curl -I https://dockflow.myvnc.com
curl -s https://dockflow.myvnc.com/api/health
```

## 8. PostgreSQL backups

Create a manual backup after the migration:

```bash
mkdir -p backups/postgres
PGPASSWORD='PASTE_A_LONG_RANDOM_PASSWORD' pg_dump -h /var/run/postgresql -U dockflow_app -d "Dockflow" -Fc -f "backups/postgres/dockflow-$(date +%Y%m%d-%H%M%S).dump"
```

Keep at least one copy outside the Ubuntu VM. Do not delete the pre-migration JSON backup until the PostgreSQL backup has also been tested.
