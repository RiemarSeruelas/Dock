# DockFlow update — September 18, 2026

## Included fixes

- Moved **Updated SDS** and **Import SDS** to the Schedule header beside **Request**.
- Rebuilt the phone layout with compact headers, readable KPI cards, condensed filters, card-based history/report rows, and controls that no longer overflow the screen.
- Changed **Scan** on phones into a near-fullscreen sheet over a dark, blurred view of the current page. The sheet keeps station selection, photo scanning, camera scanning, manual entry, and result verification together.
- Made Schedule open in **Day** view on phones and fit the single-day timeline to the available width.
- Restored the visual road lanes in fullscreen Delivery Monitoring. Open docks show an empty road; occupied docks show the truck image and live delivery details.
- Changed the API health check from `localhost` to `127.0.0.1` so the container reports healthy when Node listens on IPv4.
- Updated the public domain defaults and Nginx template to `dockflow.myvnc.com`.
- Prepared Microsoft 365 SMTP defaults for `cavitefoods.dockflow@unilever.com` using port 587 and STARTTLS.

## Deploy the update

Keep the server's existing private `.env`; do not replace it with `.env.example`. Update these values in the private `.env`:

```env
APP_ORIGIN=https://dockflow.myvnc.com
CORS_ORIGINS=https://dockflow.myvnc.com

EMAIL_NOTIFICATIONS_ENABLED=false
SMTP_HOST=smtp.office365.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=cavitefoods.dockflow@unilever.com
SMTP_APP_PASSWORD=replace_with_the_secret_issued_by_your_microsoft_365_admin
MAIL_FROM=DockFlow <cavitefoods.dockflow@unilever.com>
```

Leave `EMAIL_NOTIFICATIONS_ENABLED=false` until the Microsoft 365 administrator confirms the mailbox and authentication method. Then change it to `true` and recreate the API container.

Build and deploy without removing the existing PostgreSQL orphan container:

```bash
cd /opt/DockFlow-POC-Source
docker compose config >/dev/null
docker compose build
docker compose up -d --no-deps --force-recreate --wait --wait-timeout 180 api web
```

Do not add `--remove-orphans`; the existing PostgreSQL container is intentionally outside the current Compose service list.

## Verify

```bash
docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
docker inspect -f '{{json .Config.Healthcheck.Test}}' dockflow-poc-server-api-1
curl -fsS http://127.0.0.1:5059/api/health
curl -I https://dockflow.myvnc.com
```

The health response should report `"primaryStorage":"postgres"` and `"connected":true`.

## Microsoft 365 administrator requirement

The sender name alone is not a usable credential. The organization must create or license the mailbox and approve one of its permitted sending methods. This release supports authenticated SMTP over STARTTLS. If the tenant blocks password-based SMTP authentication, use an organization-approved SMTP relay or extend DockFlow with Microsoft OAuth before enabling email notifications.
