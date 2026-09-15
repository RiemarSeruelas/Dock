# DockFlow — September 15 multi-batch update

## What changed

- **My Entries** is now **Delivery Entries**.
- Supplier accounts are linked to a supplier company without a Dressings/Savoury account split.
- Gate In no longer blocks early arrivals. Arrival status is:
  - **Advanced:** more than 30 minutes early
  - **On Time:** 30 minutes early through 15 minutes late
  - **Late:** more than 15 minutes late
- Supplier truck confirmation now requires batch number, supplier lot, batch quantity, production date, and expiration date for every assigned material.
- A truck may carry multiple materials under one DR. Each material has its own clearance record and PDF page while retaining that shared DR.
- A material may have multiple batches. DockFlow creates one Receiving Records/PostgreSQL row per batch and repeats the shared DR/material/truck information on those rows.
- Supplier-confirmed batch rows become available on the next Receiving Records refresh, before Gate In. Gate and warehouse details update the same rows later.
- Replacement quantities require fresh batch details instead of reusing the original delivery's batch identity.

## PostgreSQL behavior

No table reset is required for this update. The existing `Analysis.SAPAnalysis` columns already hold the batch fields. New application-backed rows use a batch-specific `record_key`, so batches do not overwrite one another. Existing historical/imported rows and SAP edits are preserved.

The operational SDS, confirmation, and scan workflow remains in the JSON trial store. Only Receiving Records/SAP Analysis uses PostgreSQL.

## Install

1. Back up the current DockFlow folder, `.env`, and `data` folder.
2. Extract this full-project ZIP into a new folder.
3. Copy your existing private `.env`, `data/trial-data.json`, and uploaded branding images into the matching locations in the new folder.
4. From the new project folder, rebuild:

   ```powershell
   docker compose up -d --build --force-recreate
   ```

5. Sign out and sign back in before testing the changed account scopes.

## Suggested check

Confirm one delivery with a single DR, two materials, and two batches under one of those materials. Receiving Records should show three PostgreSQL rows. Clearance should show two material records/pages. After Gate In, refresh Receiving Records and confirm the arrival status and Gate In value update without creating extra rows.

## Verification

- 25 automated tests passed.
- Production Next.js build passed.
- ESLint passed.
- Live PostgreSQL, SMTP delivery, printer output, and browser visual layout were not available for environment-level verification here.
