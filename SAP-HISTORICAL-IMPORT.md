# Clean SAPAnalysis reset

The incorrect vehicle-log dataset is no longer part of DockFlow SAP Analysis. Use the separately supplied scripts in this order:

```powershell
py -m pip install "psycopg[binary]"
py 01_remove_old_sap_table.py
py 02_create_clean_sap_table.py
```

Both scripts use the same `POSTGRES_*` settings as DockFlow and require an exact typed confirmation. The first permanently deletes the old `Analysis.SAPAnalysis` table. The second refuses to overwrite an existing table and creates the clean schema only when the table is absent.

Install and rebuild this corrected DockFlow project before opening SAP Analysis:

```powershell
docker compose up -d --build --force-recreate
```

On the first authorized SAP page load, DockFlow synchronizes its Gate-In shipment/material records into the new table. Dressings and Savoury use the same SAP table; their area filters apply to operational Overview, Monitoring and Schedule screens rather than splitting SAP storage.

## SAP worksheet columns

The first 14 worksheet columns are:

1. Delivery Date/Time
2. Encoded By
3. Material Code
4. Material Description
5. DR Number
6. DR Quantity
7. PO Number
8. SAP Batch
9. Breakdown
10. Manufacturing Date
11. Expiration Date
12. Material Document
13. Supplier's Lot
14. Remarks

PO remains a text field for manual cross-checking and may contain comma-separated values. It is not used as the delivery identity.

After these columns, DockFlow appends its supplier/system values and the original role-controlled Warehouse values. SAP Analyst can edit destination, the SAP fields, and formatting. Warehouse can edit inventory/receiving controller, helper count, truck type, actual received, pallet count, warehouse remarks, QA timestamps, and QA disposition. Planner can edit destination. Administrator can edit SAP and Warehouse fields.

The removed fields are `title`, `company`, `plate_no`, `helper_1_name`, `helper_2_name`, `date_time_in`, `time_in`, `date_time_out`, `time_out`, `hours_stay`, and `sort_priority`.
