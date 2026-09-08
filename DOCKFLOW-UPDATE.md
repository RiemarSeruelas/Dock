# DockFlow — workflow and interface update

This ZIP contains the changed files for the uploaded 7th Project. It includes the earlier receiving/SAP changes and the latest corrections. Existing business data remains in JSON; the SAP worksheet now has a separate PostgreSQL connection.

## Apply the update

1. Stop DockFlow and back up the project, including your private `.env` and `data` folder.
2. Extract this ZIP into the project root and replace matching files. Do not replace your data or `.env`.
3. Copy the new SAP/network variables from `.env.example` into your existing `.env`, then configure them as described below. Keep your location-encryption key and existing credentials unchanged.
4. Docker: `docker compose up -d --build --force-recreate`. npm: `npm.cmd install`, then `npm.cmd run dev`; for production use `npm.cmd run build` followed by `npm.cmd run start` and a separate API process.
5. Sign out and sign in again. No volumes need to be deleted.

The npm web commands now use `server/web.js`. Use these commands rather than invoking `next start` directly: the wrapper verifies the client address before forwarding API requests.

## Screens and accounts

- Overview uses the supplied truck image in larger receiving lanes, only when occupied. Dressings uses Dock 1; Savoury uses Dock 2. Ecosystem has separate receiving docks.
- Administration opens accounts and the protected receiving-site editor directly. Account colors match schedule colors, and unverified accounts use a compact disclosure.
- Schedule has a rescheduling button with a count and a searchable, scrolling review dialog. Booked-day counts are removed. Day view includes supplier, codes, quantities, truck and time.
- The notification bell sits beside the theme button. Planner is labelled **Planner/Production**.
- New accounts receive their verification email once, on their first successful sign-in, when SMTP is configured. Account creation itself does not send the code. Activation asks for the code and a new password twice, then enters the application without a second sign-in. Existing accounts retain their current activation state. Existing Quality Inspection accounts migrate to Warehouse; new Quality Inspection accounts cannot be created.
- The report month filter remains; the large monthly OTIF scorecard is removed. Report tables and Excel downloads respect the month.

## Supplier confirmation and alternatives

Choose one or two trucks. Each needs plate, driver, phone, PO, DR and assigned material codes; helper names are optional. Philippine `09…`, `9…`, `63…` and `+63…` numbers are normalized. Material codes start selected for the first truck. For two trucks, move the relevant codes to the second checklist; every code must appear exactly once.

Alternative reasons are Reschedule Time and Date, Change in quantities, and Other. Notes are optional. Blank date/time fields keep the existing schedule. Quantity splits add the remaining amount when you leave the quantity field, rather than on every keystroke. Each material must either be fully allocated across the proposed schedules or marked **Can't deliver** with a reason.

Truck details are not requested with an alternative. Planner approval returns the approved schedule to the supplier, who then assigns one or two trucks and confirms the delivery. That final confirmation creates the booking and QR. Rejection requires a reason; the application never invents drivers or plates.

## Receiving and clearance

The scan sequence is Booking → Trip → Gate in → Unloading → Received → Gate out. Supplier/driver starts Trip, Security handles the ULI gate, and Warehouse handles unloading/receiving. Each station supports QR scanning and a direct confirmation button after selecting a delivery. Ecosystem can record its own incoming gate and receiving stages.

At Received choose **OTIF — all items accepted** or **Not OTIF — record the issue**. Gate-in time, including the configured grace period, remains the source of timeliness: selecting full receipt cannot turn a late delivery into OTIF. Not OTIF records the reason and rejected/short quantity for each material. Replacement date/time is optional; supply both together. A supplied schedule creates linked replacement proposals. Without one, outstanding quantities and reasons are recorded and emailed with the schedule still to be agreed. Receiving finishes and the truck can proceed to Gate out.

Warehouse, Administrator and receiving Ecosystem users can open **Inbound clearance** in confirmed delivery details. Available supplier, material, truck, driver, helper, DR/PO, quantity, batch/lot and scan timestamps autofill. SAP Actual Received is used when available, then the recorded accepted quantity. Review any manual fields and download the PDF. Both halves use the same values, with one A4 landscape page per material. The supplied original form is retained as the printable background. Print at actual size.

## Ecosystem

Incoming deliveries with Site = Ecosystem appear in its Overview, Monitoring and Schedule. Outgoing ULI requests appear in My entries and notifications. Dressings/Savoury operations use their own docks.

Administrator or Ecosystem maintains requestable material codes and UOMs under **Ecosystem → Manage materials**. Administrator or Planner/Production selects multiple codes, enters quantities, destination and date/time, then sends a delivery request. It appears for the Ecosystem supplier account and is emailed to its verified address. There are no inventory quantities or stock-availability limits. Duplicate submission IDs are rejected.

For a single Ecosystem account, an SDS Site of Ecosystem is sufficient. The destination API can associate an unconfirmed delivery with a specific Ecosystem account when multiple receiving warehouses are used. Existing destination assignments are retained.

## Monthly performance emails

Administration includes **Monthly performance emails**, with day 1–28, Manila time, next planned send, recipient verification status and last successful send per account. Default is the first day at 09:00 Manila. Reports cover the previous calendar month. Only inspected original deliveries enter the OTIF denominator; replacement deliveries are excluded.

SMTP and a running API are required. The scheduler checks each minute once the selected time is due, persists successful recipient/month sends, and retries failures. After downtime it catches up the immediately previous month. It remains a single-instance trial scheduler; a crash between SMTP acceptance and saving success can cause a duplicate.

## SAP PostgreSQL and network setup

Set the following server variables to your actual private database configuration:

```dotenv
SAP_STORAGE=postgres
POSTGRES_HOST=your_postgres_host
POSTGRES_PORT=5432
POSTGRES_DB=docker
POSTGRES_USER=user
POSTGRES_PASSWORD=password
POSTGRES_SCHEMA=Analysis
POSTGRES_SESSION_LOGS_TABLE=SAPAnalysis
POSTGRES_SSL=false
SAP_ALLOWED_CIDRS=
SAP_TRUSTED_PROXY_CIDRS=
WEB_TRUSTED_PROXY_CIDRS=
```

The values above are placeholders, not credentials. Use `POSTGRES_SSL=true` when the database requires TLS; certificate verification stays enabled. `DB_ENABLED=false` still applies to the separate JSON trial/business storage and does not disable the SAP connection.

The API creates schema `"Analysis"` and table `"SAPAnalysis"` on the first authorized request, if absent. It also adds missing unified-data and formatting columns to an existing importer-created DockFlow table without deleting or replacing its rows. Give the configured database user schema and table privileges. Back up and reconcile an unrelated or incompatible table before starting DockFlow.

- `SAP_ALLOWED_CIDRS`: the actual approved client/VPN address ranges as observed by the web/API path. Empty means nobody can see SAP data.
- `SAP_TRUSTED_PROXY_CIDRS`: only the web server's actual address/range on the private API connection. The API trusts client addresses from those proxies only. Keep the API private; do not publish its Docker port to public clients.
- `WEB_TRUSTED_PROXY_CIDRS`: only a trusted ingress/reverse proxy in front of the web server. Leave empty when clients connect directly to the DockFlow web server. A proxy must append the observed peer or overwrite the forwarded chain; do not trust arbitrary public clients.
- Behind Docker or a VPN, confirm the observed source addresses before choosing ranges. Do not allow the entire Docker/private address space merely to make the worksheet load. An IP/network check is not a browser connection to PostgreSQL: the API connects to the database and separately enforces approved client-network access.

SAP Analysis and Administrator can edit SAP fields and cell formatting. Planner/Production can view the register and edit Destination. Warehouse can view the register and edit receiving and clearance fields. Supplier booking inputs remain in Scheduling, and suppliers do not receive access to the internal historical register. The API enforces these permissions even if someone manipulates the browser.

The register searches PostgreSQL server-side, loads 50 rows at a time, and loads more only when requested. It refreshes only the newest page every 10 seconds while the tab is visible and preserves unsaved edits. Outside the allowed network, or when the database is unavailable, it displays no data.

The worksheet supports multi-cell, whole-row, and whole-column selection; fill, undo, redo, delete contents, font, emphasis, color, fill, alignment, wrap, indent, borders, row height, column width, and hide/show controls. Copy, cut, paste, copy formatting, and paste formatting remain available through standard keyboard shortcuts even though their toolbar buttons were removed. Cell formatting, row height, and hidden-row state are stored in PostgreSQL. Hidden columns and column widths are browser layout preferences. Record cells are deliberately not mergeable because each database row must retain its own field boundaries.

Rows imported by the standalone Python importer appear immediately; their blank SAP fields are editable according to the signed-in role. New application rows appear after Gate in. Existing SAP edits are preserved when application rows synchronize. Saves use optimistic revision checks; stale application saves return a conflict. Direct SQL writers must increment `revision` on each update to participate in conflict detection. No user deletion or application resync deletes SAP records.

| Display column | PostgreSQL column | Initial source |
|---|---|---|
| Delivery date | delivery_date | Gate in, Manila |
| Encoded by | encoded_by | Current analyst/administrator when saved |
| Item | item | Material code |
| Description | description | Internal description, if available |
| DR No | dr_number | Truck/item DR |
| Quantity | quantity | Original DR/scheduled quantity |
| UOM | uom | Material UOM |
| Actual Received | actual_received | Blank for SAP entry |
| PO Number | po_number | Truck/item PO |
| Batch | batch | Available application batch |
| Breakdown | breakdown | Blank |
| Mfg. Date | mfg_date | Available application value |
| Exp Date | exp_date | Available application value |
| MATDOC | matdoc | Blank |
| Supplier's Lot | supplier_lot | Blank |
| Remarks | remarks | Blank |

The unified register also adds supplier, plate, driver, Gate in/out, destination, gatepass, inventory and receiving controller, helper count, truck type, pallet count, warehouse remarks, unloading timestamps, QA timestamps, and QA disposition. Existing importer rows keep blank values for fields that were not present in the workbook.

Cell columns are TEXT to preserve leading zeros and source formatting. Internal metadata is `id`, `record_key`, `shipment_id`, `supplier`, `revision`, `verified`, and `updated_at`. `record_key` is `shipmentId:itemId`. Excel exports the same 16 visible columns, navy headers, green Batch cells and red MATDOC; the source-hint row is removed. Configure visible columns in the compact disclosure. Save before downloading.

For this unified update, the Excel download keeps the original 16 columns first and appends the added unified columns. Cell formatting metadata is stored in `cell_formats`; row sizing and visibility use `row_height` and `row_hidden`. Imported historical keys remain unchanged, while app-created keys use `shipmentId:itemId`.

`SAP_STORAGE=json` remains available only as an explicit local trial option; network checks still apply. Production defaults to PostgreSQL, with no silent JSON fallback.

## Verification and limits

- Automated workflow, import, split, receiving, activation, SAP permissions/conflicts/pagination/network spoofing, Ecosystem catalog and clearance checks pass; production build and lint pass.
- The requested new Received-to-SAP/OTIF integration is deliberately deferred; this package retains the existing receiving behavior.
- The clearance PDF was rendered and visually checked against the supplied form; both copies align.
- Live PostgreSQL credentials/network were not supplied. Connection to your database, live SMTP delivery and Docker image execution remain unverified.
- Browser-preview permission was unavailable. Desktop/mobile/fullscreen layout changes were checked in source against your screenshots, not in a live browser.
- Business records remain in the single-instance JSON trial store. This update does not migrate the entire application to PostgreSQL.
