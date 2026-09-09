# DockFlow User Guide

DockFlow manages SDS delivery schedules, supplier truck confirmations, QR scanning, monitoring, history, and reports in Manila time (GMT+8).

See [DOCKFLOW-UPDATE.md](DOCKFLOW-UPDATE.md) for the receiving, OTIF, Ecosystem, SAP and monthly KPI features, update steps, and verification notes.

## First administrator

DockFlow now starts clean: no sample suppliers, staff accounts, schedules, or delivery records are preloaded.

On the first run, it creates one administrator using these private `.env` settings:

- `BOOTSTRAP_ADMIN_USERNAME`
- `BOOTSTRAP_ADMIN_PASSWORD`

After copying `.env.example` to `.env`, set those two values before starting DockFlow. Use the same username and password on the login screen. The dedicated sender mailbox comes from `SMTP_USER` and is kept internal. Create every other account from **Administration**.

## Before importing an SDS

Each supplier in the spreadsheet must have a directly linked supplier account.

1. Open **Administration**.
2. Select **Add account**.
3. Choose **Supplier account** as the role.
4. Use the supplier company name as the account display name.
5. Add the supplier email, username, and initial password. Supplier accounts do not need a separate company selector.

One supplier company can have one active supplier account. Deleting its account keeps its delivery records, but new spreadsheet deliveries for that supplier are blocked until an account is linked again.

## Importing an SDS

Open **Schedule → Import SDS** and choose an Excel, OpenDocument, CSV, or TSV file. Dressings and Savoury Planner accounts remain restricted to their own area, but either may import rows explicitly marked with Site = Ecosystem.

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

Accept the proposed time or propose an alternative date, time or quantity split. Split quantities must total the original amount for each material. Administrator or Planner/Production approval is required for alternatives; while waiting, the request is read-only and cannot be submitted again. Approval returns the new schedule for truck confirmation; rejection requires a reason. Both decisions email verified supplier recipients.

Choose one or two trucks and allocate every remaining material quantity. With two trucks, editing one truck's amount automatically balances the other so the total always matches the request. Provide each truck's `AAA-1111` plate, driver, phone prefix and ten mobile digits, PO and DR numbers; helper names are optional. Each fully confirmed truck receives a unique delivery code, QR, monitoring card and report entry.

## Monitoring and history

**Monitoring** displays confirmed trucks in process order. Use **See all** or the two-click date range. Gate-in and Gate-out timestamps measure factory time. Partial receipt outcomes remain visible, and linked replacement proposals track outstanding quantities.

The notification bell is in the top navigation. Opening an alert marks it read, but an action-required count remains until the linked schedule confirmation or reschedule decision is actually completed.

**History** is one total-record view for previous deliveries and rejected proposals. Company users only see their own company. Supplier and driver views keep the useful material, driver, and date filters without the supplier, outcome, or time controls.

## Scan flow

`Booking → optional Trip → Gate in → Unloading → Received → Gate out`

- Supplier can record Trip, but Trip may be skipped before Security records Gate in.
- Security records Gate in and Gate out.
- Authorized Warehouse, Ecosystem or Administrator users record Unloading and inspect Received.
- Received can be full or **Received – Not in Full**, with outstanding quantities, reason and a required Follow up schedule. Each shortage creates a linked **Follow up** entry.
- Gate out finishes site time and releases the dock.
- Over HTTP, use QR photos, hardware scanners or manual codes. Live camera scanning requires HTTPS.

## Trial storage

Business data remains in the JSON trial store; the SAP worksheet uses its own network-restricted PostgreSQL connection. See DOCKFLOW-UPDATE.md for configuration. Business data is stored in `data/trial-data.json`. Stop the API or Docker containers before manually editing the file, and back it up before replacing the project.

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

## Test email notifications

1. Open the private `.env` file and set `EMAIL_NOTIFICATIONS_ENABLED=true`.
2. Set `SMTP_USER` to the dedicated administrator Gmail and `SMTP_APP_PASSWORD` to its Google App Password. Do not use the normal Gmail password.
3. Restart DockFlow so the API loads the private sender credentials.
4. Planner and Supplier account owners set and verify their own recipient email. Supplier accounts see a persistent verification reminder until this is complete.
5. Security and Warehouse accounts intentionally have no email field. The System Administrator sender uses `SMTP_USER` internally and does not require recipient verification.
6. Import a new SDS. Each linked, verified supplier receives only its own proposed deliveries. New proposals show their schedule and material-code details; rescheduled proposals show **Before** and **After** details. File-level SDS summaries and other suppliers’ changes are not included.
7. Propose an alternative from the supplier account. Verified Planner and Production emails receive the reason and proposed time.
8. Approve or reject the alternative from the company Schedule page. The verified supplier receives the decision and reason by email, and all linked supplier users receive an in-app notification.

The sender address and App Password stay in `.env`; they are not saved in trial JSON, returned by the API, or shown in the browser. In an offline trial, the rest of DockFlow still works, but Gmail delivery and public ETA lookup cannot be tested.

If sending fails, DockFlow now identifies the safe cause: a trial placeholder recipient, rejected Gmail credentials, or an SMTP network/firewall problem. Leave `MAIL_FROM=` blank unless you are supplying a complete valid sender address.

## Login and truck images

- Login background: `public/images/dockflow-background.jpg`
- Dock truck: `public/images/parked-truck.jpg`
- DockFlow logo: `public/uploads/dockflow-logo.png`

Keep those exact names. The login background should be a wide facility/truck photograph; DockFlow applies the dark overlay in CSS. The dock truck is the top-view truck image shown only in occupied receiving lanes.
