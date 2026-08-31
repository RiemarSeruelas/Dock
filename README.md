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

The supplier opens **Schedule** or **My entries** and selects **Review & confirm delivery** on a proposal.

1. Accept the proposed time, or propose an alternative with a reason and one alternative date and time.
2. Enter one truck plate and driver name, choose the phone country code, then enter the numeric local phone number.
3. Select all material codes carried by that truck.
4. Select **Confirm Delivery**.
5. If material codes remain, open the proposal again and confirm the next truck.

If an alternative is proposed, Planner, Production, or Administrator reviews the original time, proposed time, and supplier reason. Company approval applies the new time and asks the supplier to return and confirm the truck details. Company rejection closes the proposal and sends the company reason to the supplier. Both outcomes appear as an in-app notification and are emailed to verified supplier accounts.

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

1. Open the private `.env` file and set `EMAIL_NOTIFICATIONS_ENABLED=true`.
2. Set `SMTP_USER` to the dedicated administrator Gmail and `SMTP_APP_PASSWORD` to its Google App Password. Do not use the normal Gmail password.
3. Restart DockFlow so the API loads the private sender credentials.
4. Sign in as Administrator and open **Administration → Accounts**.
5. Select each account, replace its `@dockflow.local` trial address with the owner’s real email, then send and enter its six-digit verification code.
6. Import a new SDS. Each linked, verified supplier receives only its own proposed deliveries. New proposals show their schedule and material-code details; rescheduled proposals show **Before** and **After** details. File-level SDS summaries and other suppliers’ changes are not included.
7. Propose an alternative from the supplier account. Verified Planner and Production emails receive the reason and proposed time.
8. Approve or reject the alternative from the company Schedule page. The verified supplier receives the decision and reason by email, and all linked supplier users receive an in-app notification.

The sender address and App Password stay in `.env`; they are not saved in trial JSON, returned by the API, or shown in the browser. In an offline trial, the rest of DockFlow still works, but Gmail delivery and public ETA lookup cannot be tested.

If sending fails, DockFlow now identifies the safe cause: a trial placeholder recipient, rejected Gmail credentials, or an SMTP network/firewall problem. Leave `MAIL_FROM=` blank unless you are supplying a complete valid sender address.

## Replacing the truck image

The shared top-view truck image is `public/uploads/truck.png`. Replace that file with another PNG using the same filename to update the dock, schedule, entry, and monitoring truck visuals.
