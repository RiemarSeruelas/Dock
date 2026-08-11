# DockFlow Delivery Scheduling

DockFlow is a local-network delivery scheduling and receiving system built with React, PostgreSQL, Express, Docker, and nginx. It converts the supplied planner → supplier → driver → security → warehouse process into one role-based application.

## Included workflow

- Planner creates a DPP-backed delivery request (RDS) and sends it to a supplier.
- Supplier confirms the RDS, selects an exact delivery date/time, enters truck/driver details, and attaches DN/COA documents. End time is optional.
- Planner/Admin can upload an `.xlsx` or `.xlsm` delivery workbook. DockFlow detects RM/PM schedule sheets, uses PO Validation as a reference, previews every row, skips cancellations/received/invalid rows, and only de-duplicates an exact previously imported business row.
- The system creates a shipment number, booking receipt, QR code, and pallet identity records.
- Driver records trip start and arrival; GPS coordinates are captured when browser permission and a secure context are available.
- Security scans the QR, validates truck/driver/DN data, and directs the truck to a dock or parking.
- Warehouse starts unloading, scans pallet IDs for GR, and completes the delivery when all pallets are received.
- Planner can reschedule backlogged deliveries to any exact date/time without a fixed slot length.
- Monitoring shows every upcoming delivery as a compact color-coded card with its schedule, truck, driver, dock, load, material, and journey progress. Selecting a card opens the full delivery, PO, material, source-row, remarks, and PO-balance record.
- Reports show on-time arrival, in-full receiving, unloading duration, delay causes, and supplier performance.
- Admin controls material master data, users/roles, dock count, and grace period.

## Technology

- React 19 application using Next.js
- Express 5 REST API with JWT role authorization
- PostgreSQL 16 with persistent Docker volume
- nginx reverse proxy
- Persistent local volume for uploaded delivery documents
- Responsive desktop, tablet, and mobile interface with light/dark modes

## Start with Docker

### Replacing an older DockFlow package

Extract each replacement ZIP into a new, empty project directory. Do not extract it over an older DockFlow folder: ZIP extraction replaces matching files but does not remove obsolete folders from earlier versions. Old scaffolding such as `build`, `.vinext`, `.openai`, `examples`, or `worker` can otherwise remain on disk.

This release also excludes those obsolete directories from Docker, TypeScript, ESLint, and Git as a defensive safeguard.

1. Copy the environment template:

   Windows PowerShell:

   ```powershell
   Copy-Item .env.example .env
   ```

   Linux/macOS:

   ```bash
   cp .env.example .env
   ```

2. Change `POSTGRES_PASSWORD` and `JWT_SECRET` in `.env` before production use.

3. Build and start:

   ```bash
   docker compose up -d --build
   ```

4. Open `http://localhost:5059` (or the port configured as `APP_PORT`).

   For access from other devices, set `APP_ORIGIN` in `.env` to the real server URL (for example, `http://10.0.0.20:5059`). This value is embedded in shipment QR codes.

5. Stop without deleting data:

   ```bash
   docker compose down
   ```

Do not add `-v` to `docker compose down` unless you intend to delete the PostgreSQL and upload volumes.

### Start with a completely empty operational database

The application no longer creates sample suppliers, materials, delivery requests, shipments, or activity. It keeps only the six initial role accounts so you can sign in.

If you previously ran an older DockFlow package, Docker will keep its existing database volume—including the old sample records. To intentionally erase that old database and start clean, run this once before starting the updated package:

```bash
docker compose down -v
docker compose up -d --build
```

This deletes the existing DockFlow PostgreSQL and upload volumes. Do not run it after entering real data unless you have a backup.

## Initial accounts

| Role | Username | Password |
| --- | --- | --- |
| Administrator | `admin` | `admin123` |
| Planner | `planner` | `planner123` |
| Supplier | `supplier` | `supplier123` |
| Truck driver | `driver` | `driver123` |
| Security | `security` | `security123` |
| Warehouse | `warehouse` | `warehouse123` |

Change these seeded passwords before production rollout. The initial supplier account is intentionally unassigned; link real supplier accounts after supplier master data has been created by import or administration. Role authorization is checked by the API, not only hidden in the interface.

## Flexible delivery times

| Shift label | Time range |
| --- | --- |
| Morning | 06:00–13:59 |
| Afternoon | 14:00–21:59 |
| Night | 22:00–05:59 |

Shift labels are informational and assigned automatically from the exact arrival time. They do not restrict booking. A delivery may start at any minute of the day, and an optional end time can cross midnight. The default setup has three receiving docks and a 30-minute late grace period.

## Excel import rules

Required schedule columns (aliases are accepted): Supplier, Material Code/Item Code, Description, Quantity, UOM, Date, and Time.

Useful optional columns: Week, Site, PO reference, PO balance, Still to be delivered, Remarks, and End Time. `PO Validation` is used to enrich matching schedule rows. `PO download` is treated as reference data; pricing, purchasing organization, document date, price unit, deletion indicators, and other SAP export metadata are not imported into delivery records.

Rows marked cancelled or already received, dates such as `c/o ...`, invalid/blank times, and incomplete required fields are shown as skipped in the preview. No database changes occur until the user confirms the preview.

A duplicate must match the same site, supplier, delivery date, exact time, optional end time, week, PO, material code/name/type, quantity, and UOM. The same PO or material scheduled on a different date or time is imported as a new delivery row. Older import keys are also checked so re-importing a workbook created by a previous DockFlow version does not create a second copy.

## Camera and GPS on phones

Manual shipment/pallet entry always works. Browser camera and precise GPS normally require HTTPS when the app is accessed from another device using a LAN IP address. For mobile production use, terminate HTTPS in nginx using your plant’s trusted certificate and update `APP_ORIGIN` to the HTTPS address. `localhost` is treated as secure by modern browsers during testing.

## Persistent data and backup

Docker volumes:

- `dockflow_postgres`: users, bookings, materials, status history, and pallet scans
- `dockflow_uploads`: DN/COA files

Example PostgreSQL backup:

```bash
docker compose exec -T db pg_dump -U dockflow dockflow > dockflow-backup.sql
```

Example restore into an empty database:

```bash
docker compose exec -T db psql -U dockflow dockflow < dockflow-backup.sql
```

## Important files

- `app/dockflow-app.tsx` — React role workspaces and UI interactions
- `app/globals.css` — responsive design system
- `server/index.js` — authenticated API and workflow rules
- `server/excel-import.js` — workbook detection, mapping, validation, and normalization
- `db/init.sql` — PostgreSQL schema
- `docker-compose.yml` — nginx, web, API, and PostgreSQL services
- `nginx/nginx.conf` — local reverse proxy
- `.env.example` — deployment settings

## Production checklist

- Change database/JWT secrets and seeded account passwords.
- Configure HTTPS if phone camera/GPS capture is required.
- Import real delivery/master data and create named supplier/user accounts.
- Confirm dock count, grace period, exact-time behavior, Excel column aliases, and timezone.
- Schedule backups of both Docker volumes.
- Run a UAT cycle with one planner, supplier, driver, security officer, and warehouse receiver.
