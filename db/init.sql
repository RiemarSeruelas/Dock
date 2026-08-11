CREATE TABLE IF NOT EXISTS suppliers (
  id SERIAL PRIMARY KEY,
  vendor_code VARCHAR(40) NOT NULL UNIQUE,
  name VARCHAR(180) NOT NULL,
  contact_name VARCHAR(180),
  contact_email VARCHAR(220),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  name VARCHAR(180) NOT NULL,
  username VARCHAR(80) NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role VARCHAR(30) NOT NULL CHECK (role IN ('admin','planner','supplier','driver','security','warehouse')),
  supplier_id INTEGER REFERENCES suppliers(id),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS materials (
  id SERIAL PRIMARY KEY,
  code VARCHAR(80) NOT NULL UNIQUE,
  name VARCHAR(220) NOT NULL,
  type VARCHAR(30) NOT NULL DEFAULT 'ROH',
  uom VARCHAR(20) NOT NULL,
  shelf_life_days INTEGER NOT NULL DEFAULT 0,
  units_per_pallet NUMERIC(14,3) NOT NULL DEFAULT 0,
  storage_zone VARCHAR(80),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS dpps (
  id SERIAL PRIMARY KEY,
  dpp_number VARCHAR(80) NOT NULL UNIQUE,
  supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
  requested_date DATE NOT NULL,
  arrival_shift VARCHAR(30) NOT NULL,
  notes TEXT,
  items JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_by INTEGER REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS rds_requests (
  id SERIAL PRIMARY KEY,
  rds_number VARCHAR(80) NOT NULL UNIQUE,
  dpp_id INTEGER NOT NULL REFERENCES dpps(id),
  status VARCHAR(30) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','CONFIRMED','SCHEDULED')),
  confirmed_by INTEGER REFERENCES users(id),
  confirmed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS shipments (
  id SERIAL PRIMARY KEY,
  shipment_number VARCHAR(90) UNIQUE,
  booking_receipt VARCHAR(90) UNIQUE,
  rds_id INTEGER REFERENCES rds_requests(id),
  supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
  scheduled_date DATE NOT NULL,
  time_slot VARCHAR(40) NOT NULL,
  arrival_shift VARCHAR(30) NOT NULL,
  status VARCHAR(30) NOT NULL DEFAULT 'PLANNED',
  truck_plate VARCHAR(40) NOT NULL,
  driver_name VARCHAR(180) NOT NULL,
  driver_phone VARCHAR(50),
  material_weight_kg NUMERIC(14,3) NOT NULL DEFAULT 0,
  dock VARCHAR(40),
  started_at TIMESTAMPTZ,
  start_latitude NUMERIC(10,7),
  start_longitude NUMERIC(10,7),
  arrived_at TIMESTAMPTZ,
  arrival_latitude NUMERIC(10,7),
  arrival_longitude NUMERIC(10,7),
  verified_at TIMESTAMPTZ,
  unloading_started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  rejection_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS shipment_items (
  id SERIAL PRIMARY KEY,
  shipment_id INTEGER NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
  po_number VARCHAR(80),
  material_code VARCHAR(80),
  material_name VARCHAR(220),
  quantity NUMERIC(14,3) NOT NULL DEFAULT 0,
  uom VARCHAR(20),
  pallet_count INTEGER NOT NULL DEFAULT 0,
  dn_number VARCHAR(100),
  batch_number VARCHAR(100),
  production_date DATE,
  expiry_date DATE
);

CREATE TABLE IF NOT EXISTS shipment_documents (
  id SERIAL PRIMARY KEY,
  shipment_item_id INTEGER NOT NULL REFERENCES shipment_items(id) ON DELETE CASCADE,
  document_type VARCHAR(20) NOT NULL CHECK (document_type IN ('DN','COA')),
  original_name TEXT NOT NULL,
  stored_name TEXT NOT NULL,
  mime_type VARCHAR(120),
  uploaded_by INTEGER REFERENCES users(id),
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS pallet_scans (
  id SERIAL PRIMARY KEY,
  shipment_id INTEGER NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
  pallet_id VARCHAR(120) NOT NULL,
  scanned_by INTEGER REFERENCES users(id),
  scanned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (shipment_id, pallet_id)
);

CREATE TABLE IF NOT EXISTS shipment_events (
  id BIGSERIAL PRIMARY KEY,
  shipment_id INTEGER REFERENCES shipments(id) ON DELETE CASCADE,
  actor_id INTEGER REFERENCES users(id),
  action VARCHAR(80) NOT NULL,
  detail TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS app_settings (
  key VARCHAR(80) PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS shipments_schedule_idx ON shipments (scheduled_date, time_slot);
CREATE INDEX IF NOT EXISTS shipments_status_idx ON shipments (status);
CREATE INDEX IF NOT EXISTS events_created_idx ON shipment_events (created_at DESC);
