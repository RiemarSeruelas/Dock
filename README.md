# DockFlow Delivery Scheduling

DockFlow is a local-network delivery scheduling and receiving system built with React, PostgreSQL, Express, Docker, and nginx. It converts the supplied planner → supplier → driver → security → warehouse process into one role-based application.

## Included workflow

- Planner creates a DPP-backed delivery request (RDS) and sends it to a supplier.
- Supplier confirms the RDS, selects a slot inside the approved arrival shift, enters truck/driver details, and attaches DN/COA documents.
- The system creates a shipment number, booking receipt, QR code, and pallet identity records.
- Driver records trip start and arrival; GPS coordinates are captured when browser permission and a secure context are available.
- Security scans the QR, validates truck/driver/DN data, and directs the truck to a dock or parking.
- Warehouse starts unloading, scans pallet IDs for GR, and completes the delivery when all pallets are received.
- Planner can drag backlogged deliveries to another available time slot.
- Reports show on-time arrival, in-full receiving, unloading duration, delay causes, and supplier performance.
- Admin controls material master data, users/roles, dock count, slot length, and grace period.

## Technology

- React 19 application (Vinext/Next-compatible build)
- Express 5 REST API with JWT role authorization
- PostgreSQL 16 with persistent Docker volume
- nginx reverse proxy
- Persistent local volume for uploaded delivery documents
- Responsive desktop, tablet, and mobile interface with light/dark modes

## Start with Docker

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

## Initial accounts

| Role | Username | Password |
| --- | --- | --- |
| Administrator | `admin` | `admin123` |
| Planner | `planner` | `planner123` |
| Supplier | `supplier` | `supplier123` |
| Truck driver | `driver` | `driver123` |
| Security | `security` | `security123` |
| Warehouse | `warehouse` | `warehouse123` |

Change these seeded passwords before production rollout. The supplier demo account is linked to Pacific Oils Inc.; role authorization is also checked by the API, not only hidden in the interface.

## Arrival shift defaults

| Shift | Allowed start window |
| --- | --- |
| Morning | 06:00–13:59 |
| Afternoon | 14:00–21:59 |
| Night | 22:00–05:59 |

The default slot length is 90 minutes, with three receiving docks and a 30-minute grace period. Admin can adjust these values in the app.

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
- `db/init.sql` — PostgreSQL schema
- `docker-compose.yml` — nginx, web, API, and PostgreSQL services
- `nginx/nginx.conf` — local reverse proxy
- `.env.example` — deployment settings

## Production checklist

- Change database/JWT secrets and seeded account passwords.
- Configure HTTPS if phone camera/GPS capture is required.
- Replace demo master data and create named supplier/user accounts.
- Confirm dock count, shift definitions, slot duration, grace period, and timezone.
- Schedule backups of both Docker volumes.
- Run a UAT cycle with one planner, supplier, driver, security officer, and warehouse receiver.
