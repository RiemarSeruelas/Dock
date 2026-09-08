# DockFlow SAP Historical Excel Import

This package imports the uploaded SAP receiving workbook directly into the PostgreSQL table configured by:

```dotenv
POSTGRES_SCHEMA=Analysis
POSTGRES_SESSION_LOGS_TABLE=SAPAnalysis
```

It does not change `data/trial-data.json`. DockFlow deliveries, schedules, accounts, reports and other trial features remain JSON-based.

## What was found in Book2.xlsx

- Worksheet: `Delivery Record_SAP Analyst`
- 17 actual records (rows 3–19), not 12,000 records
- Row 1 contains the headers and row 2 contains instructions
- The workbook has 14 visible data columns
- `UOM` and `ACTUAL RECEIVED` are not present, so they import as blank
- Delivery Date and Description are formulas; the importer uses their saved/cached Excel results
- DR numbers, batches and supplier lots are preserved as text where available

Use the complete 12,000-row workbook with the same importer when it is available.

## Install

Copy `server/import-sap-excel.mjs` into the same location in the DockFlow project. Keep the existing `.env` containing the PostgreSQL connection values.

The importer is included automatically in the API Docker image because the Dockerfile copies the complete `server` folder.

Rebuild the API image:

```powershell
docker compose build api
```

Place the Excel file in the DockFlow project folder.

## Step 1 — Safe dry run

Run this from PowerShell in the DockFlow project folder:

```powershell
docker compose run --rm --no-deps -v "$($PWD.Path)\Book2.xlsx:/tmp/Book2.xlsx:ro" api node server/import-sap-excel.mjs /tmp/Book2.xlsx --dry-run
```

The dry run reads and validates the workbook but does not connect to or change PostgreSQL.

If the full workbook has several sheets, all sheets with recognizable SAP headers are imported. To select one sheet:

```powershell
docker compose run --rm --no-deps -v "$($PWD.Path)\Book2.xlsx:/tmp/Book2.xlsx:ro" api node server/import-sap-excel.mjs /tmp/Book2.xlsx --dry-run "--sheet=Delivery Record_SAP Analyst"
```

## Step 2 — Import into PostgreSQL

After checking the dry-run row count, run:

```powershell
docker compose run --rm --no-deps -v "$($PWD.Path)\Book2.xlsx:/tmp/Book2.xlsx:ro" api node server/import-sap-excel.mjs /tmp/Book2.xlsx --commit
```

The script:

- Creates the configured schema/table if they do not exist
- Checks that an existing table has all DockFlow-required columns
- Imports in batches of 500 rows inside one transaction
- Generates numeric `shipment_id` and `record_key` values compatible with DockFlow
- Upserts deterministically, so rerunning the same workbook does not duplicate its rows
- Rolls back the entire import if any database operation fails

The default supplier metadata is `Historical Import`. To use a different internal label:

```powershell
docker compose run --rm --no-deps -v "$($PWD.Path)\Book2.xlsx:/tmp/Book2.xlsx:ro" api node server/import-sap-excel.mjs /tmp/Book2.xlsx --commit "--supplier=Historical SAP Data"
```

The workbook filename is the default stable batch identity. When importing a corrected copy under another filename, reuse the original identity to update the same records:

```powershell
docker compose run --rm --no-deps -v "$($PWD.Path)\Corrected.xlsx:/tmp/Corrected.xlsx:ro" api node server/import-sap-excel.mjs /tmp/Corrected.xlsx --commit "--batch=Book2"
```

## Step 3 — Verify in pgAdmin

```sql
SELECT COUNT(*) AS total_rows
FROM "Analysis"."SAPAnalysis";

SELECT
    id,
    delivery_date,
    encoded_by,
    item,
    description,
    dr_number,
    quantity,
    po_number,
    batch,
    matdoc,
    supplier_lot,
    remarks
FROM "Analysis"."SAPAnalysis"
ORDER BY id DESC
LIMIT 25;
```

## Important

- Keep the same `--batch` name when rerunning or correcting one dataset.
- Do not change `SAP_STORAGE` to `json`; SAP Analysis must remain `postgres`.
- Do not load all 12,000 rows in the current SAP browser table. It still needs search and server-side pagination for a dataset that large.
- Back up the database before importing the full historical dataset.

