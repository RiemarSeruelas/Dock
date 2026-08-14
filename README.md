# DockFlow Delivery Scheduling — Supplier Account Trial

This UAT build uses a Next.js interface, an Express API, and the editable `data/trial-data.json` file. PostgreSQL and nginx remain disconnected while the workflow is being finalized.

All dates and process timestamps are displayed in **Asia/Manila (GMT+8)**.

## Fast local start

Requires Node.js 22 or newer. In PowerShell:

```powershell
Copy-Item .env.example .env
npm.cmd install
npm.cmd run dev
```

Open `http://localhost:3000`. The `dev` command starts both services:

- Next.js web interface on port `3000`
- JSON API on port `3001`

`API_INTERNAL_URL=http://localhost:3001` is the local proxy target. `APP_ORIGIN` is the browser origin accepted by the API; changing only `APP_ORIGIN` does not change the proxy destination.

## Docker start

```powershell
docker compose down --remove-orphans
Copy-Item .env.example .env
docker compose up -d --build
```

Open `http://localhost:5059`. Docker overrides the proxy target with `http://api:3001`; `api` is a Docker service name and is not resolvable by a standalone Windows Next.js process.

## Initial accounts

| Role | Username | Password |
| --- | --- | --- |
| Administrator | `admin` | `admin123` |
| Planner | `planner` | `planner123` |
| Supplier | `supplier` | `supplier123` |
| Driver | `driver` | `driver123` |
| Security | `security` | `security123` |
| Warehouse | `warehouse` | `warehouse123` |

Change these before using the build outside UAT.

## Supplier accounts and product presets

Administration now contains **Accounts** and **Supplier catalogs**.

- Create an account with the Supplier role and enter its supplier company.
- DockFlow creates or links the supplier record automatically.
- Add products such as Eggs or Mayonnaise to that supplier’s catalog, including a default amount and unit.
- A supplier session receives only that supplier’s catalog, schedules, history, reports, and requests.
- The supplier selects one or more preset products and enters the amount or weight for each delivery.

## Booking request and approval

A supplier request contains:

- DPP number;
- booking date, start time, and end time;
- truck plate;
- driver name and phone number;
- checked preset products with amount or weight.

The supplier name comes from the signed-in account. There is no supplier field, dock selector, load field, dock-capacity counter, or two-step booking action.

Bookings may overlap and there is no fixed booking limit. Schedule keeps two clearly separated workspaces that share the same date and day/week controls: **Booking setup** contains availability only, while **Booked deliveries** contains actual trucks only. Both use the full 00:00–24:00 timeline. Bookings whose time ranges overlap are automatically narrowed into separate colored side-by-side lanes instead of being drawn on top of each other. Administrators and planners can drag unstarted bookings or availability windows to any 15-minute position. Excel imports appear automatically under Booked deliveries.

Every request enters Management as **Pending confirmation**. Management reviews it once and either confirms it or denies it with a required rejection reason.

The submit button locks while a request is being sent. The API also rejects an exact repeated request, so rapid clicks cannot create duplicate bookings.

## QR process

The required process is:

1. **Booking** — Management confirms the request.
2. **Trip** — the supplier scans its delivery before departure.
3. **Gate in** — Security scans at the shared Gate station.
4. **Unload** — Warehouse scans at the Unloading station.
5. **Received** — Warehouse scans at the Received station.
6. **Gate out** — Security scans the same QR at the same Gate station again.

The Gate station automatically chooses Gate in or Gate out from the truck’s current stage. Stages cannot be skipped. Each scan stores an ISO timestamp; the interface shows Manila time and live durations for Trip → Gate in, Gate in → Unloading, Unloading → Received, Received → Gate out, and total Gate in → Gate out.

Use a USB QR scanner by focusing the shipment-number field and scanning. The camera scanner uses browser QR support when available. Manual entry remains available for UAT.

## Main workspaces

- **Overview** — operational summary and the existing two-dock visual control.
- **Monitoring** — truck-first cards with multiple products, important delivery details only, today-priority sorting, one horizontal See all/Specific date filter with a themed in-app calendar, and logo-only fullscreen mode.
- **Schedule** — separate Booking setup and Booked deliveries views on a shared 24-hour day/week calendar, with drag-and-drop scheduling and side-by-side overlapping bookings.
- **Management** — Excel import plus one-step confirmation or reasoned denial.
- **Scan** — role-aware Trip, Gate, Unloading, and Received scanning.
- **History** — separate Received and Rejected views.
- **Reports** — supplier self-performance for supplier accounts and per-supplier company performance for internal accounts.
- **Administration** — materials, accounts, supplier catalogs, and scheduling settings.

Supplier accounts only receive **Schedule** and **Scan** in their sidebar. Their profile indicator is display-only; sign-out remains the explicit button at the bottom of the sidebar.

## Booking PDF

Open a delivery and select **Download booking PDF**. The authenticated API creates the PDF directly as a single-page document with booking details, products, and the shipment QR code. This avoids the browser print layout that previously produced an empty first page.

## Edit the JSON directly

The editable file is:

```text
data/trial-data.json
```

Stop the API before editing so a running write does not replace your changes. For Docker:

```powershell
docker compose stop api
# edit data\trial-data.json
docker compose start api
```

For local development, stop `npm.cmd run dev`, edit the file, and start it again.

Supplier catalog example:

```json
{
  "id": 1,
  "vendorCode": "SUP-001",
  "name": "Example Foods",
  "productPresets": [
    { "id": 1, "name": "Eggs", "uom": "KG", "defaultAmount": 300 },
    { "id": 2, "name": "Mayonnaise", "uom": "KG", "defaultAmount": 500 }
  ]
}
```

Supplier user example:

```json
{
  "name": "Example Foods User",
  "username": "examplefoods",
  "password": "change-me-123",
  "role": "supplier",
  "supplierId": 1
}
```

Useful rules:

- Dates use `YYYY-MM-DD`; times use 24-hour `HH:MM`.
- IDs may be omitted on new records; DockFlow assigns them at startup.
- A plain `password` is accepted once and replaced with `passwordHash` at startup.
- Keep the JSON syntactically valid.
- Existing legacy status names are migrated automatically on startup.

## Excel import

Excel import remains in Management and is intentionally permissive for UAT. Every nonblank recognized schedule row is accepted, including rows with missing optional values, repeated-looking rows, different dates, and different products. Missing fields receive visible placeholders for later review.

Completely blank rows are ignored. A schedule sheet needs at least two recognizable headers such as Supplier, Material, Quantity, Date, or Time.

## Important files

- `data/trial-data.json` — editable UAT data
- `app/dockflow-app.tsx` — accounts, requests, QR operations, details, and reports
- `app/dockflow-features.tsx` — Schedule, Management, Monitoring, and History
- `server/index.js` — JSON API, access scoping, approvals, scans, and PDF generation
- `server/excel-import.js` — permissive Excel mapping
- `docker-compose.yml` — two-service trial stack

## Before production

This JSON build is for UAT only. Reconnect PostgreSQL, nginx, production credential policies, backups, and HTTPS after the business workflow is approved.
