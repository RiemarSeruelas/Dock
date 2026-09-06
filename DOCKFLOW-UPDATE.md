# DockFlow receiving and SAP update

This update uses the uploaded **7th Project.zip** as its baseline. PostgreSQL stays disconnected. Existing accounts, records, encrypted locations and private environment settings are retained.

## Install

1. Stop DockFlow and back up the project, including its private `.env` and `data` folder.
2. Extract the update ZIP into the project root, replacing the matching files. The ZIP contains only changed/new source files and this guide. Do not replace your data or `.env`.
3. For Docker, run `docker compose up -d --build --force-recreate`.
4. For npm development, stop the running process and run `npm.cmd run dev` again. No new packages are required.
5. Sign out and sign in again, then refresh the browser.

Do not delete volumes. Keep your existing `LOCATION_ENCRYPTION_KEY` unchanged.

## Supplier schedule and trucks

- Accept the proposed time or propose an alternative. Proposed date, time and reason are optional; blank fields retain the original schedule.
- Select **Split proposed quantities** to divide an order into delivery installments. Entering less than the total adds another quantity row. Set a date/time on each row.
- Quantities must be positive and total the original amount **for each material line and unit**. For example, 60 KG can become 30 KG today and 30 KG tomorrow; quantities from different materials are never combined.
- The planner reviews all allocations. Rejection requires a reason. Approval creates separate pending proposals for distinct delivery dates/times, then the supplier confirms their trucks.
- Choose one or two trucks and assign every remaining material code once. Each truck needs plate, driver, international phone number, PO number and DR number. Two helper names are optional.
- Each confirmed truck receives its own delivery code and QR. Existing partially confirmed proposals remain usable, up to the two-truck limit.

## Gate and receiving inspection

The workflow is **Booked → Gate in → Unloading → Received → Gate out**. Trip scanning has been removed. Supplier QR scans only display their delivery data.

- Security records Gate in and Gate out. Gate in always records arrival even when both docks are occupied; such trucks wait for a dock before unloading.
- Warehouse, Quality inspection, Ecosystem receivers and Administrators can perform authorized receiving steps. Work-area and Ecosystem ownership restrictions are enforced by the API.
- Received opens an inspection form. Choose **Received — In Full** or **Received – Not in Full**.
- A partial receipt requires accepted quantities, issue/reason, and replacement date/time for each affected material. Unaffected items retain their full accepted quantity.
- Finishing a partial receipt completes receiving for that truck. Gate out still releases its dock. Linked pending replacement proposals contain only the outstanding quantities, and the supplier receives the details in-app and by email when configured.
- Repeated receiving scans do not create another replacement proposal. The old direct status-update API is disabled so it cannot bypass inspection.
- Previous Trip timestamps are retained as historical data; new deliveries do not use them.

## OTIF and monthly email

- On time: Gate in is no later than scheduled entrance plus `settings.graceMinutes` (the existing default is 30 minutes).
- In full: all quantities are accepted by inspection.
- OTIF: both conditions are true. A late full delivery and an on-time partial delivery both fail OTIF.
- The monthly scorecard groups original confirmed deliveries by scheduled month. Only inspected deliveries with a Gate-in timestamp enter the percentage denominator; pending inspection is shown separately. Replacement trips are excluded from the original-delivery denominator.
- Site time is Gate in to Gate out. Reports include helpers, PO/DR and inspection outcomes.
- The single-instance API checks hourly and emails the previous calendar month's results to verified Supplier/Ecosystem recipients and ULI Administrator/Planner recipients. Planner emails follow work-area scope; supplier emails contain only their own performance.
- Enable the existing `EMAIL_NOTIFICATIONS_ENABLED` and SMTP settings. Account email verification remains required. Successful recipient/month sends persist in JSON; failed sends retry. The API must be running. After downtime it catches up the immediately previous month, not every historical missed month.
- Live SMTP was not exercised. This trial scheduler has no durable outbox: a crash after SMTP accepts a message but before the success record is written can cause a duplicate email.

## Ecosystem receiving and supplying

Create **Ecosystem (receive & supply)** in Administration using the warehouse company's name and email.

1. An Administrator/Planner opens **Ecosystem** and assigns a pending, unconfirmed inbound proposal to that receiving warehouse.
2. The original supplier confirms its delivery. The named Ecosystem account sees its inbound delivery and can record unloading and inspection. Security records gate events.
3. Accepted inventory appears in **Ecosystem stock & transfers**. Rejected quantities do not enter available stock.
4. An Administrator/Planner requests an available material quantity, destination Dressings/Savoury, and date/time.
5. The Ecosystem receives a supplier proposal and confirms truck/material details. The normal receiving workflow then runs at ULI.

Stock is reserved atomically when a transfer is requested. Requests above available stock are rejected, including repeated requests after the stock has been reserved. This is a delivery-linked trial stock ledger, not a complete warehouse-management or stock-adjustment system.

## SAP receiving register

Create **SAP Analysis** in Administration. Only that role can open, edit, verify, save or download the register; Administrator and Supplier accounts cannot call the SAP worksheet endpoints.

The layout follows the reference: navy headers, teal source hints, green Batch cells and red MATDOC values. Rows appear after Gate in.

| Column | Initial source |
| --- | --- |
| Delivery date | Gate in, displayed in Manila time |
| Encoded by | Current SAP analyst on save |
| Item | DockFlow material code |
| Description | Internal material description when present |
| DR / PO | Truck confirmation or existing item record |
| Quantity | Accepted amount after inspection; scheduled amount before inspection |
| Batch / manufacturing / expiry | Existing item fields when present |
| Breakdown / MATDOC / supplier lot / remarks | Blank for SAP entry |

Use **Configure visible columns**, edit cells, mark rows verified, then **Save**. Download exports saved data as a styled Excel workbook. Concurrent edits use row revisions; stale saves are rejected instead of silently overwriting another analyst. The SAP verified checkbox is independent of physical receiving inspection.

This release is a JSON prototype. It makes no PostgreSQL connection and does not claim to enforce access based on membership of a PostgreSQL network. The later database integration needs a server-side trusted-network/VPN gateway and database permissions; a browser cannot prove database-network membership.

## Verification

- `npm test`: 11 tests pass, including the expanded API workflow, followed by a successful production build.
- `npm run lint`: passes.
- Coverage includes per-material split totals, partial receipt validation, replacement idempotency, role/ownership restrictions, SAP save conflicts, workbook contents/styles, Ecosystem stock reservation and report calculations.
- Tests use isolated synthetic data. User data, credentials and live emails are not used.
- Local browser-preview access was denied. Desktop/mobile/fullscreen visual checks and live SMTP delivery therefore remain unverified. Test those on your local trial before operational use.

No PostgreSQL migration or Docker image build was performed in this environment.
