# DockFlow one-time migration data

Keep and back up the existing `trial-data.json` while moving an older installation to PostgreSQL. When the PostgreSQL application tables are empty, DockFlow imports this file once and records a database initialization marker.

After a successful import, the application reads and writes PostgreSQL only. The JSON file is not a live database and is not rewritten. A brand-new installation without this file creates the first administrator directly in PostgreSQL from the `BOOTSTRAP_ADMIN_*` settings.
