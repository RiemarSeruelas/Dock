# DockFlow Delivery Scheduling — JSON Trial

This temporary build is for workflow testing while the final delivery rules are being agreed. It uses a Next.js interface, an Express API, and the editable `data/trial-data.json` file.

PostgreSQL, nginx, and all database containers are intentionally disconnected.

## Start

Stop the older stack first if it is still running:

```powershell
docker compose down --remove-orphans
```

Extract this ZIP into a new empty folder, then run:

```powershell
Copy-Item .env.example .env
docker compose up -d --build
```

Open `http://localhost:5059`.

The stack contains only:

- `web` — Next.js interface on port 5059
- `api` — Express API with JSON persistence

## Initial credentials

| Role | Username | Password |
| --- | --- | --- |
| Administrator | `admin` | `admin123` |
| Planner | `planner` | `planner123` |
| Supplier | `supplier` | `supplier123` |
| Truck driver | `driver` | `driver123` |
| Security | `security` | `security123` |
| Warehouse | `warehouse` | `warehouse123` |

Change these before any non-trial use.

## Current workspaces

- **Overview** — live summary and two-lane Dock Control with vehicle state.
- **Monitoring** — all upcoming entries. The icon-only fullscreen control hides filters and navigation for a TV display.
- **Schedule** — the single scheduling calendar and the arrivals for its selected date. Administrators and planners can drag an empty area to draft a window, drag a saved block to move it, edit exact fields, and then manually save.
- **Management** — Excel import, RDS workflow, and confirm/deny controls for requested booking times.
- **Gate & dock** — arrival, verification, dock assignment, unloading, and receiving actions.
- **History** — received, rejected, completed, and previous-date delivery records.
- **Reports** and **Administration** — trial reporting, master data, accounts, and site settings.

There is no separate Available Time page. Schedule owns availability.

## Booking-time flow

1. An administrator or planner creates or moves an open window in **Schedule** and presses **Save**.
2. Creating a delivery request displays that same calendar under **Booking time**. The requester chooses a green window and an exact 15-minute timestamp.
3. The RDS request is confirmed and booked from **Management**.
4. The booking stays pending until an administrator or planner confirms or denies it in **Management**.

Each exact timestamp has capacity for two active bookings because the trial has two docks. There are no Morning/Afternoon/Night rules.

## Edit the JSON directly

The project file is bind-mounted into the API container:

```text
data/trial-data.json
```

To edit it safely:

```powershell
docker compose stop api
# edit data\trial-data.json
docker compose start api
```

The file includes examples and a `_howToEdit` field. Useful rules:

- Dates use `YYYY-MM-DD`; times use 24-hour `HH:MM`.
- You may omit IDs on new records. DockFlow assigns them when the API starts.
- Missing delivery/material values receive trial placeholders.
- For a manually added user, provide a one-time plain `password`; startup replaces it with `passwordHash`.
- Keep the JSON syntactically valid. A missing comma or quote prevents the API from starting.

Normal `docker compose down` and `up` keep the file because it lives in the project folder. To restore the supplied trial examples, replace `data/trial-data.json` with the original copy from this ZIP.

Uploaded DN/COA files still use the `dockflow_uploads` Docker volume.

## Excel import

Excel import is in **Management**. Every nonblank row from a recognized schedule sheet is accepted:

- no duplicate blocking;
- different dates and materials are accepted;
- repeated-looking rows are accepted;
- cancelled or received rows are kept for trial review;
- missing values do not skip a row.

Temporary placeholders are used for missing cells:

| Missing value | Placeholder |
| --- | --- |
| Supplier | `Supplier to assign` |
| Material code | Generated `UNSPECIFIED-...` code |
| Description | `Material to review` |
| Quantity | `0` |
| UOM | `N/A` |
| Date | First available date |
| Time | `12:00` |

Completely blank rows are ignored. The workbook needs a schedule sheet with at least two recognizable headers such as Supplier, Material, Quantity, Date, or Time. PO Validation data is optional.

## Important files

- `data/trial-data.json` — directly editable trial data
- `app/availability-calendar.tsx` — weekly drag-and-save calendar
- `app/dockflow-features.tsx` — Schedule, Management, Monitoring, and History
- `app/dockflow-app.tsx` — navigation, operations, forms, and API actions
- `server/index.js` — JSON-backed trial API
- `server/json-store.js` — atomic JSON persistence
- `server/excel-import.js` — permissive Excel mapping
- `docker-compose.yml` — two-service trial stack

## Before production

This JSON build is for UAT only. Reconnect PostgreSQL and the production reverse proxy after the booking fields, approvals, Excel structure, and monitoring design are finalized.
