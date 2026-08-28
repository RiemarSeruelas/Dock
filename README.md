# DockFlow User Guide

DockFlow manages SDS delivery schedules, supplier truck confirmations, QR scanning, monitoring, history, and reports in Manila time (GMT+8).

## Trial accounts

| Account | Username | Password | Main use |
|---|---|---|---|
| Administrator | `admin` | `admin123` | Accounts, supplier catalogs, ETA routes, and company views |
| Planner | `planner` | `planner123` | Import and compare SDS schedules |
| Production | `production` | `production123` | View monitoring, schedule, history, and reports |
| Supplier | `supplier` | `supplier123` | Confirm truck loads, view entries, and scan Trip |
| Driver | `driver` | `driver123` | Read-only company monitoring, schedule, QR entries, history, and reports |
| Security | `security` | `security123` | Scan Gate in and Gate out |
| Warehouse | `warehouse` | `warehouse123` | Scan Unloading and Received |

Change every trial password before using the system outside a controlled demo.

## Before importing an SDS

Each supplier in the spreadsheet must have a directly linked supplier account.

1. Open **Administration → Accounts**.
2. Select **Add account**.
3. Choose **Supplier account** as the role.
4. Use the supplier company name as the account display name.
5. Add the supplier email, username, and initial password. Supplier accounts do not need a separate company selector.

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

An imported row is only a proposed schedule. It is not a booking, does not appear in Monitoring or reports, and has no QR code until the supplier completes the truck confirmation.

## Supplier truck confirmation

The supplier opens **Schedule** and selects a proposal.

1. Accept the proposed time, or reject it with a reason and one alternative date and time.
2. Enter one truck plate and driver name, choose the phone country code, then enter the numeric local phone number.
3. Select all material codes carried by that truck.
4. Select **Confirm Delivery**.
5. If material codes remain, open the proposal again and confirm the next truck.

A delivery code is reserved for every truck. As soon as every material code has been assigned and the supplier confirms the final truck, the proposal changes to **Booked** and its QR code, Monitoring card, and report entry become available.

## Monitoring and history

**Monitoring** displays active trucks in process order. Select **See all** for every active delivery, or open the calendar and select a start date followed by an end date to filter a range. ETA appears after the supplier records the Trip scan and uses the saved supplier route.

**History** is one total-record view for previous deliveries and rejected proposals. Company users only see their own company. Supplier and driver views keep the useful material, driver, and date filters without the supplier, outcome, or time controls.

## Scan flow

The confirmed delivery follows this order:

`Booking → Trip → Gate in → Unloading → Received → Gate out`

- Supplier scans **Trip**.
- Security scans **Gate in**, then **Gate out**.
- Warehouse scans **Unloading** and **Received**.
- Driver accounts can inspect their company’s approved QR entries but cannot change schedules or other delivery data.

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

## Test ETA

ETA address lookup and routing require internet access unless the provider URLs point to services hosted on your own network.

1. Sign in as Administrator and open **Administration → Accounts**.
2. Save the receiving-site address.
3. Select the route icon on a supplier account and save its dispatch address.
4. Confirm a supplier delivery and scan **Trip**.
5. Open Monitoring. The truck card should show the calculated distance, travel minutes, and arrival time.

## Test email notifications

1. Sign in as Administrator and open **Administration → Accounts**.
2. Under **Notification email**, select **Configure sender**.
3. Enter the dedicated administrator Gmail and a Google App Password. Do not use the normal Gmail password.
4. Select each administrator, planner, or supplier email, send its six-digit code, and verify it.
5. Import a new SDS. The linked verified supplier receives a notice.
6. Reject a proposal from the supplier account. Verified administrator and planner emails receive the reason and proposed alternative time.

The App Password is submitted once, encrypted server-side with the server secret, and never returned in API responses or logs. In an offline trial, the rest of DockFlow still works, but Gmail delivery and public ETA lookup cannot be tested.

## Replacing the truck image

The shared top-view truck image is `public/uploads/truck.png`. Replace that file with another PNG using the same filename to update the dock, schedule, entry, and monitoring truck visuals.
