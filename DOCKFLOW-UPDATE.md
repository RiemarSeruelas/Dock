# DockFlow — workflow and interface update

This ZIP contains the complete DockFlow project source. It includes the earlier receiving/SAP changes and the latest workflow corrections. Existing business data remains in JSON; the SAP worksheet has a separate PostgreSQL connection.

## Apply the update

1. Stop DockFlow and back up the project, including your private `.env` and `data` folder.
2. Extract this ZIP into a new folder, or copy its files over the existing project. Do not replace your live `data` folder or private `.env`.
3. Copy the new SAP/network variables from `.env.example` into your existing `.env`, then configure them as described below. Keep your location-encryption key and existing credentials unchanged.
4. Docker: `docker compose up -d --build --force-recreate`. The web container starts independently of PostgreSQL availability, and the API continues with JSON business storage/in-memory sessions if the optional general database is offline. npm: `npm.cmd install`, then `npm.cmd run dev`; for production use `npm.cmd run build` followed by `npm.cmd run start` and a separate API process.
5. Sign out and sign in again. No volumes need to be deleted.

The npm web commands now use `server/web.js`. Use these commands rather than invoking `next start` directly: the wrapper verifies the client address before forwarding API requests.

## Screens and accounts

- Overview, Monitoring and Schedule respect the signed-in account's receiving area. **Admin · Both areas** and Security may switch between Dressings and Savoury; area-scoped accounts see a fixed area label instead of a toggle. Each area has its own independent **Dock 1 - PM**, **Dock 2 - PM** and **Dock 3 - RM** view. Empty docks use a neutral border/background instead of the old green surround; occupied docks use the supplied truck image.
- The split-screen login uses `public/images/dockflow-background.jpg` as its real facility/truck background and `public/uploads/dockflow-logo.png` as its logo. A missing logo falls back cleanly to the DockFlow route mark.
- Administration groups accounts into **Both areas**, **Dressings**, and **Savoury**. The system administrator is **Admin · Both areas**. New Administrator accounts may be Both, Dressings-only, or Savoury-only. Planner, Supplier, Warehouse, and SAP accounts are assigned to an area; Security remains site-wide. An area administrator can create and manage only accounts in that same area. Existing non-admin operational accounts without a saved area are assigned to Dressings during startup.
- Schedule keeps Approved Deliveries, Rescheduling, Day/Week, and the date selector in the calendar header. The Dressings/Savoury control is at the top of the page. **Updated SDS** and **Import SDS** are at the bottom. Administrator and Planner can click any unlocked delivery ticket to edit its date, start/end time, and material quantities. Each change updates DockFlow, creates an in-app supplier notification, and emails verified supplier recipients when SMTP is configured.
- The notification bell sits beside the theme button. Planner is labelled **Planner/Production**.
- New accounts receive their verification email once, on their first successful sign-in, when SMTP is configured. Account creation itself does not send the code. Activation asks for the code and a new password twice, then enters the application without a second sign-in. Existing accounts retain their current activation state. Existing Quality Inspection accounts migrate to Warehouse; new Quality Inspection accounts cannot be created.
- The report month filter remains; the large monthly OTIF scorecard is removed. Report tables and Excel downloads respect the month.

## Supplier confirmation and alternatives

Choose one or two trucks. Each needs plate, driver, phone, PO, DR and a positive assigned quantity; helper names are optional. Plates are normalized to `AAA-1111`: the first three characters are letters and the final four are numbers. Select `+63` or local `0`, then enter exactly ten mobile digits beginning in 9. Material quantities start on the first truck. With two trucks, changing either quantity automatically balances the other truck, and the combined amount must remain exactly equal to the SDS request.

Alternative reasons are Reschedule Time and Date, Change in quantities, and Other. Notes are optional. Blank date/time fields keep the existing schedule. Quantity splits add the remaining amount when you leave the quantity field, rather than on every keystroke. Each material must either be fully allocated across the proposed schedules or marked **Can't deliver** with a reason.

Truck details are not requested with an alternative. After submission, the request timestamp and **Waiting for planner approval** state are read-only; the supplier cannot submit another proposal for the same pending request. Planner approval returns the approved schedule to the supplier, who then assigns one or two trucks and confirms the delivery. That final confirmation creates the booking and QR. Approval and rejection both email verified supplier recipients. Rejection requires a reason; the application never invents drivers or plates.

## Receiving and clearance

The scan sequence is Booking → optional Trip → Gate in → Unloading → Received → Gate out. At Gate in, Security first scans and reviews the booking, then explicitly accepts or rejects it. Entry may begin 15 minutes before the scheduled time. Rejection requires a categorized reason (or written Other reason), leaves the booking available for correction, and notifies the supplier. A received truck gets a separate **Confirm Gate Out** action. Supplier/driver may record Trip, while Warehouse handles unloading/receiving. Ecosystem can record its own incoming gate and receiving stages.

Before unloading begins, the supplier can correct the plate, driver, phone, helper names, and comma-separated PO/DR values. Delivery date and time remain planner-controlled.

At Received choose **OTIF — all items accepted** or **Not OTIF — record the issue**. Gate-in time, including the configured grace period, remains the source of timeliness: selecting full receipt cannot turn a late delivery into OTIF. Not OTIF records the reason and rejected/short quantity for each material. Choosing Other requires a written explanation. Every outstanding quantity requires a Follow up date and time. Finishing receiving emails the supplier and creates a linked, visibly labelled **Follow up** proposal for that schedule. The original truck can then proceed to Gate out.

Administrator, Warehouse and SAP Analyst accounts have a searchable **Clearance** sidebar page with downloadable entries. Administrator and Warehouse can open an entry to complete it. Available supplier, material, truck, driver, helper, DR/PO, quantity, batch/lot and scan timestamps autofill from DockFlow and SAP. SAP Actual Received is used when available, then the recorded accepted quantity. Both left/right copies use the same entered values and download as one A4 landscape page per delivery; multiple material values are combined on that page.

## Ecosystem

Incoming deliveries with Site = Ecosystem appear in its Overview, Monitoring and Schedule. Outgoing ULI requests appear in My entries and notifications. Dressings/Savoury operations use their own docks.

A Dressings or Savoury Planner can import spreadsheet rows whose Site is Ecosystem. The account's normal work-area restriction still applies to every non-Ecosystem row in that upload.

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

SAP Analysis and Administrator can add worksheet rows, edit SAP fields and cell formatting. Every SAP/Administrator add or edit automatically records the actor as `F. Lastname` in Encoded by. Planner/Production can view the register and edit Destination. Warehouse can view the register and edit receiving and clearance fields. Supplier booking inputs remain in Scheduling, and suppliers do not receive access to the internal historical register. The API enforces these permissions even if someone manipulates the browser.

The register searches PostgreSQL server-side and loads 50 rows at a time. Scrolling near the bottom automatically requests the next page; 27,000 rows are not fetched in one request. It supports newest-first/oldest-first sorting and returns every SAP row. It refreshes only the newest page every 10 seconds while the tab is visible, preserves the current pagination position, and keeps unsaved edits. The rest of DockFlow refreshes its JSON-backed operational snapshot every 30 seconds. Outside the allowed network, or when the database is unavailable, SAP displays no data.

The worksheet supports multi-cell, whole-row, and whole-column selection with one continuous outer selection border and the appropriate axis header highlighted; undo, redo, font, emphasis, color, fill, alignment, wrap, indent, borders, row height, and column width. The unused toolbar controls for thousands formatting, delete contents, clear formatting, fill selected, hide rows, and show rows were removed. Copy, cut, paste, copy formatting, paste formatting, and Delete remain available through keyboard shortcuts. Cell formatting and row height are stored in PostgreSQL. Hidden columns and column widths are browser layout preferences. Record cells are deliberately not mergeable because each database row must retain its own field boundaries.

Rows imported by the standalone Python importer appear immediately; their blank SAP fields are editable according to the signed-in role. New application rows appear after Gate in. Existing SAP edits are preserved when application rows synchronize. Saves use optimistic revision checks; stale application saves return a conflict. Direct SQL writers must increment `revision` on each update to participate in conflict detection. No user deletion or application resync deletes SAP records.

| Display column | PostgreSQL column | Initial source |
|---|---|---|
| Delivery date | delivery_date | Gate in, Manila |
| Encoded by | encoded_by | Current analyst/administrator when saved |
| Item | item | Material code |
| Description | description | Internal description, if available |
| DR No | dr_number | Truck/item DR |
| Quantity | quantity | Original DR/scheduled quantity |
| PO Number | po_number | Truck/item PO |
| Batch | batch | Available application batch |
| Breakdown | breakdown | Blank |
| Mfg. Date | mfg_date | Available application value |
| Exp Date | exp_date | Available application value |
| MATDOC | matdoc | Blank |
| Supplier's Lot | supplier_lot | Blank |
| Remarks | remarks | Blank |

After those 14 SAP columns, the unified register adds supplier, plate, driver, Gate in/out, destination and gatepass; then the original Warehouse fields: inventory controller, receiving controller, helper count, truck type, actual received, pallet count, warehouse remarks, unloading timestamps, QA timestamps and QA disposition. The incorrect vehicle-log columns are not part of this schema.

Cell columns are TEXT to preserve leading zeros and source formatting. Internal metadata is `id`, `record_key`, `shipment_id`, `supplier`, `revision`, `verified`, and `updated_at`. `record_key` is `shipmentId:itemId`. Excel exports the same 14 SAP columns first and then the app/Warehouse columns. Configure visible columns in the compact disclosure. Save before downloading.

Cell formatting metadata is stored in `cell_formats`; row sizing and visibility use `row_height` and `row_hidden`. App-created keys use `shipmentId:itemId`.

`SAP_STORAGE=json` remains available only as an explicit local trial option; network checks still apply. Production defaults to PostgreSQL, with no silent JSON fallback.

## Verification and limits

- Automated checks cover workflow, Excel time zones, import/work-area rules, split quantities, receiving/Follow ups, activation, SAP permissions/conflicts/pagination/manual rows/network spoofing, Ecosystem email formatting and single-page clearance. See the handoff message for the final test/build result for this package.
- The requested new Received-to-SAP/OTIF integration is deliberately deferred; this package retains the existing receiving behavior.
- The clearance PDF generation and single-page count were checked automatically; live printer output was not tested in this environment.
- Live PostgreSQL credentials/network were not supplied. Connection to your database, live SMTP delivery and Docker image execution remain unverified.
- Browser-preview permission was unavailable. Desktop/mobile/fullscreen layout changes were checked in source against your screenshots, not in a live browser.
- Business records remain in the single-instance JSON trial store. This update does not migrate the entire application to PostgreSQL.
