# DockFlow SAP / Vehicle-log Excel Import

Use the separate `DockFlow-SAP-Importer` folder for large historical workbooks. Keep `import_sap_excel.py` and `Book2.xlsx` together, put your PostgreSQL connection values in the script's SETTINGS section, install `requirements.txt`, and run:

```powershell
py -m pip install -r requirements.txt
py import_sap_excel.py
```

Review the detected sheet names and row count, then type exactly `IMPORT` to write. The script connects to the same database as DockFlow and targets:

```text
DockFlow database → Analysis schema → SAPAnalysis table
```

## Large-file safety

The importer does not send 27,000 rows simultaneously. It uses one connection and commits sequential batches of 250 rows. A 27,000-row workbook therefore uses 108 transactions, with one active transaction at a time and a short pause between them. The console bar separately reports Sent and database-verified Recorded rows.

If interrupted, the current 250-row batch rolls back and prior batches remain committed. Run the same file again with the same `IMPORT_BATCH_ID`: deterministic `record_key` values update existing records rather than duplicating them.

## Supported layouts

Material/SAP columns include Delivery Date, Encoded By, Item/Material Code, Description, DR Number, Quantity, UOM, Actual Received, PO Number, Batch, Breakdown, Mfg/Exp Date, MATDOC, Supplier Lot, Remarks, and the unified DockFlow operational fields.

Vehicle-log columns map as follows:

| Excel heading | PostgreSQL column |
|---|---|
| Title | `title` |
| Company | `company` |
| Plate No | `plate_no` |
| Driver Name | `driver_name` |
| Helper 1 Name | `helper_1_name` |
| Helper 2 Name | `helper_2_name` |
| Date and Time IN | `date_time_in` |
| Time In | `time_in` |
| Date and Time OUT | `date_time_out` |
| Time Out | `time_out` |
| Hours Stay | `hours_stay` |
| SortPriority | `sort_priority` |

The schema, table, and missing supported columns are created automatically when the configured PostgreSQL user has permission. Vehicle-log rows have `record_key` values beginning with `vehicle-log:` and a null `shipment_id`; this is intentional because they are visits, not DockFlow shipment records.

Multiple batches under one DR are separate database rows. The DR and shipment ID repeat while the record key, batch, quantity, dates, MATDOC, and supplier lot can differ.

## Verify in pgAdmin

```sql
SELECT COUNT(*) AS total_rows
FROM "Analysis"."SAPAnalysis";

SELECT
  id, record_key, shipment_id,
  item, dr_number, batch,
  title, company, plate_no, driver_name,
  helper_1_name, helper_2_name,
  date_time_in, time_in, date_time_out, time_out,
  hours_stay, sort_priority
FROM "Analysis"."SAPAnalysis"
ORDER BY id DESC
LIMIT 50;
```

Keep DockFlow configured with `SAP_STORAGE=postgres`, the same database/schema/table values, and an allowed client CIDR. SAP Analysis loads 50 rows per request and fetches more through pagination; it does not download the entire table into the browser at once.
