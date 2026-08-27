# DockFlow User Guide

DockFlow manages SDS delivery schedules, supplier truck confirmations, QR scanning, monitoring, history, and reports in Manila time (GMT+8).

## Trial accounts

| Account | Username | Password | Main use |
|---|---|---|---|
| Administrator | `admin` | `admin123` | Accounts, supplier catalogs, ETA routes, and company views |
| Planner | `planner` | `planner123` | Import and compare SDS schedules |
| Production | `production` | `production123` | Import and compare SDS schedules |
| Supplier | `supplier` | `supplier123` | Confirm truck loads, view entries, and scan Trip |
| Security | `security` | `security123` | Scan Gate in and Gate out |
| Warehouse | `warehouse` | `warehouse123` | Scan Unloading and Received |

Change every trial password before using the system outside a controlled demo.

## Before importing an SDS

Each supplier in the spreadsheet must have a directly linked supplier account.

1. Open **Administration → Accounts**.
2. Select **Add account**.
3. Choose **Supplier account** as the role.
4. Enter the supplier company exactly as it appears in the spreadsheet.
5. Add the supplier email, username, and initial password.

One supplier company can have one active supplier account. Deleting its account keeps its delivery records, but new spreadsheet deliveries for that supplier are blocked until an account is linked again.

## Importing an SDS

Open **Schedule → Import SDS** and choose an Excel, OpenDocument, CSV, or TSV file.

The main spreadsheet details are:

- Week
- Site, such as Dressings or Savory
- Supplier
- Material code
- UOM
- Quantity for delivery
- Date
- Time

The preview shows whether every supplier account is linked. A missing account is displayed in red and prevents the import.

DockFlow compares each import with existing records:

- An identical proposal remains unchanged.
- A changed proposal that is still waiting for the supplier is shown as a conflict. Choose **Keep existing** or **Update from upload** before importing.
- A confirmed or completed delivery is preserved as a record.
- A genuinely new proposal is created.

## Supplier truck confirmation

The supplier opens **Schedule** and selects a proposal.

1. Accept the proposed time, or reject it with a reason and one alternative date and time.
2. Enter one truck plate and driver name, choose the phone country code, then enter the numeric local phone number.
3. Select all material codes carried by that truck.
4. Select **Confirm Delivery**.
5. If material codes remain, open the proposal again and confirm the next truck.

A delivery code is reserved for every truck. As soon as every material code has been assigned and the supplier confirms the final truck, the booking is complete and its QR code and report entry become available.

## Monitoring and history

**Monitoring** displays active trucks in process order. Select **See all** for every active delivery, or open the calendar and select a start date followed by an end date to filter a range. ETA appears after the supplier records the Trip scan and uses the saved supplier route.

**History** is one total-record view for previous deliveries and rejected proposals. Filter it by supplier, material, driver, outcome, date range, or time range. The Outcome column still shows what happened to every record.

## Scan flow

The confirmed delivery follows this order:

`Booking → Trip → Gate in → Unloading → Received → Gate out`

- Supplier scans **Trip**.
- Security scans **Gate in**, then **Gate out**.
- Warehouse scans **Unloading** and **Received**.
- Roles without a scan station do not see the Scan page.

## Trial storage

This trial runs without PostgreSQL. Business data is stored in `data/trial-data.json`. Stop the API or Docker containers before manually editing the file, and back it up before replacing the project.

## Run with Docker

From the project folder:

```powershell
Copy-Item .env.example .env
docker compose up --build -d
docker compose ps
```

Open `http://localhost:5059`.

To stop DockFlow:

```powershell
docker compose down
```

## Run with npm

```powershell
Copy-Item .env.example .env
npm.cmd install
npm.cmd run dev
```

Open `http://127.0.0.1:3000`.

## Optional Gmail notices

For an offline trial, keep this in `.env`:

```env
EMAIL_NOTIFICATIONS_ENABLED=false
```

When internet access and a dedicated Gmail account are available, use a Google App Password in the server `.env` values and enable notifications. The Gmail password is never stored in trial JSON or sent to the browser.

## Replacing the truck image

The shared top-view truck image is `public/uploads/truck.png`. Replace that file with another PNG using the same filename to update the dock, schedule, entry, and monitoring truck visuals.
