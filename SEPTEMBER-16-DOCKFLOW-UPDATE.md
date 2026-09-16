# DockFlow September 16 update

This build implements the requested account, scheduling, receiving, SAP, monitoring, and reporting changes.

## Empty-data preview

- The six monitoring counters stay in one horizontal row; narrower screens scroll the row instead of wrapping it.
- Calendar booking cards show the supplier first, the booking time second, and the truck plate at the bottom.
- Operational trial records are empty: deliveries, requests, notifications, audit history, imports, and SAP rows all start at zero.
- The administrator and Ajinomoto supplier accounts, supplier preset, and material catalog remain available so the preview can be signed into and tested before server data is added.

## Operational changes

- Sign-in accepts either username or email.
- Supplier accounts can be assigned to Dressings, Savoury, or both; scoped administrators remain limited to their assigned area.
- Monthly performance email is opt-in and disabled for new accounts by default.
- Suppliers and company planners can create delivery requests without importing an SDS workbook.
- Supplier confirmation uses a PO number per material and no longer asks for batch details.
- The scan journey is now Booking → Trip → Gate In → SAP Clearance → Unloading → Received → Gate Out.
- SAP Clearance is recorded by SAP Analyst or administrator accounts and appears with the scanner's name and timestamp on the ticket.
- Address-based ETA estimates use a conservative traffic allowance and no longer require a Google Maps field in the interface.

## SAP and reporting

- SAPAnalyst Dressings and SAPAnalyst Savoury use separate PostgreSQL tables.
- Configure `POSTGRES_SAP_DRESSINGS_TABLE` and `POSTGRES_SAP_SAVOURY_TABLE`; the defaults are `SAPAnalysis` and `SAPAnalysisSavoury`.
- The SAP worksheet includes pallet-tag fields for week number, type/allergen, foil weight, weight, expiry, quantity, material code, and material description.
- Report exports contain only Deliveries and Material Codes sheets. They include human-readable site time plus actual received, breakdown, MFG, EXP, material document, and supplier dock fields.

## Verification

- `npm run lint`
- `npm test` (21 tests plus the production Next.js build)

Both commands pass in this build.
