# DockFlow Delivery Scheduling

DockFlow coordinates SDS delivery schedules, supplier truck loading, approvals, QR scanning, monitoring, history, and reports in Manila time (GMT+8).

## Trial accounts

| Account | Username | Password | Main use |
|---|---|---|---|
| Administrator | `admin` | `admin123` | Accounts, supplier catalogs, ETA, and all company views |
| Planner | `planner` | `planner123` | Import SDS schedules and make final decisions |
| Production | `production` | `production123` | Review supplier responses and make final decisions |
| Supplier | `supplier` | `supplier123` | Respond to assigned SDS proposals, confirm trucks, view entries, and scan Trip |
| Security | `security` | `security123` | Scan Gate in and Gate out |
| Warehouse | `warehouse` | `warehouse123` | Scan Unloading and Received |

Change every trial password before using the system outside a controlled demo.

## Delivery workflow

1. Planner, Production, or Administrator opens **Schedule** and selects **Import SDS**.
2. DockFlow accepts every nonblank material row from Excel, OpenDocument, CSV, or TSV files. Missing cells receive trial placeholders instead of being skipped.
3. The assigned supplier sees the proposal in **Schedule**. Only material codes, quantities, and units are shown to the supplier.
4. The supplier either accepts the proposed date and time or provides one rejection reason and one alternative date and time.
5. The supplier decides whether one or several trucks are needed, enters one plate per truck, assigns every material code to exactly one truck, and confirms the load.
6. DockFlow creates one delivery code per truck.
7. Planner or Production makes the final approve/reject decision. There is no repeated negotiation loop.
8. QR, PDF, monitoring, and report access become available only after final approval.

Overlapping approved deliveries appear beside one another on the calendar. Schedule blocks can be dragged by Planner, Production, or Administrator while the delivery has not started.

## Scan flow

The approved delivery follows this order:

`Booking → Trip → Gate in → Unloading → Received → Gate out`

- Supplier scans **Trip** before leaving.
- Security scans the same QR for **Gate in**, then again for **Gate out** after receipt.
- Warehouse scans **Unloading** and **Received**.
- DockFlow records every timestamp in Manila time and calculates the time between stages.

## Supplier accounts and notifications

Create supplier logins under **Administration → Accounts**. Each account needs an email and must be linked to its supplier company. Configure the material codes it may use under **Supplier catalogs**.

When Gmail notifications are enabled, an assigned supplier receives an email after a new SDS is committed. The Gmail app password belongs only in the server `.env` file. It is never stored in the JSON trial data or sent to the browser.

## Trial storage

This version intentionally runs without PostgreSQL. Business data is stored in:

`data/trial-data.json`

Stop the API or Docker containers before editing the file. Dates use `YYYY-MM-DD` and times use 24-hour `HH:MM`. The `_howToEdit` section at the top of the JSON file lists the safe editing rules.

Refresh sessions are kept in memory, so users sign in again after the API restarts. Back up `data/trial-data.json` before replacing the project or clearing Docker data.

## Run with Docker

From the project folder:

```powershell
Copy-Item .env.example .env
docker compose up --build -d
docker compose ps
```

Open `http://localhost:5059`.

To stop the app:

```powershell
docker compose down
```

Do not add `-v` unless you intentionally want to remove Docker-managed upload data.

## Run with npm

```powershell
Copy-Item .env.example .env
npm.cmd install
npm.cmd run dev
```

Open `http://127.0.0.1:3000`. Both the website and local API start from the same command.

## Optional Gmail setup

For an offline trial, leave this disabled:

```env
EMAIL_NOTIFICATIONS_ENABLED=false
```

When internet access and a dedicated Gmail account are available, set the SMTP values in `.env`, use a Google App Password rather than the normal Gmail password, then change the setting to `true`. If email sending fails, the SDS import is still saved and the import history shows the notification result.
