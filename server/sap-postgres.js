import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { clientAddress, inNetworks } from './client-network.js';
import { fail } from './receiving.js';

// key, worksheet heading, default width, PostgreSQL column, source section
export const sapColumns = [
  ['supplierName', 'SUPPLIER', 24, 'supplier_name', 'scheduling'],
  ['plateNumber', 'PLATE NO.', 16, 'plate_number', 'scheduling'],
  ['driverName', 'DRIVER NAME', 22, 'driver_name', 'scheduling'],
  ['gateIn', 'GATE IN', 22, 'gate_in', 'system'],
  ['gateOut', 'GATE OUT', 22, 'gate_out', 'system'],
  ['destination', 'DESTINATION', 22, 'destination', 'shared'],
  ['deliveryDate', 'DELIVERY DATE/TIME', 23, 'delivery_date', 'system'],
  ['encodedBy', 'ENCODED BY', 20, 'encoded_by', 'sap'],
  ['item', 'MATERIAL CODE', 18, 'item', 'sap'],
  ['description', 'MATERIAL DESCRIPTION', 40, 'description', 'sap'],
  ['drNumber', 'DR NUMBER', 18, 'dr_number', 'sap'],
  ['gatepassNumber', 'GATEPASS NUMBER', 20, 'gatepass_number', 'sap'],
  ['quantity', 'DR QUANTITY', 15, 'quantity', 'sap'],
  ['uom', 'UOM', 10, 'uom', 'sap'],
  ['poNumber', 'PO NUMBER', 19, 'po_number', 'sap'],
  ['batch', 'SAP BATCH', 20, 'batch', 'sap'],
  ['breakdown', 'BREAKDOWN', 24, 'breakdown', 'sap'],
  ['mfgDate', 'MANUFACTURING DATE', 20, 'mfg_date', 'sap'],
  ['expDate', 'EXPIRATION DATE', 18, 'exp_date', 'sap'],
  ['matdoc', 'MATERIAL DOCUMENT', 22, 'matdoc', 'sap'],
  ['supplierLot', "SUPPLIER'S LOT", 22, 'supplier_lot', 'sap'],
  ['remarks', 'REMARKS', 32, 'remarks', 'sap'],
  ['inventoryController', 'INVENTORY CONTROLLER', 24, 'inventory_controller', 'warehouse'],
  ['receivingController', 'RECEIVING CONTROLLER', 24, 'receiving_controller', 'warehouse'],
  ['helperCount', 'NO. OF HELPER', 16, 'helper_count', 'warehouse'],
  ['truckType', 'TYPE OF TRUCK', 18, 'truck_type', 'warehouse'],
  ['actualReceived', 'ACTUAL QUANTITY RECEIVED', 24, 'actual_received', 'warehouse'],
  ['palletCount', 'NO. OF PALLETS', 17, 'pallet_count', 'warehouse'],
  ['warehouseRemarks', 'WAREHOUSE REMARKS', 30, 'warehouse_remarks', 'warehouse'],
  ['startUnloading', 'START UNLOADING', 22, 'start_unloading', 'system'],
  ['endUnloading', 'END UNLOADING', 22, 'end_unloading', 'system'],
  ['qaStart', 'QA INSPECTION (START)', 23, 'qa_start', 'warehouse'],
  ['qaEnd', 'QA INSPECTION (END)', 23, 'qa_end', 'warehouse'],
  ['qaDisposition', 'QA DISPOSITION', 20, 'qa_disposition', 'warehouse'],
  ['title', 'LOG TITLE', 20, 'title', 'log'],
  ['company', 'LOG COMPANY', 24, 'company', 'log'],
  ['logPlateNumber', 'LOG PLATE NO.', 16, 'plate_no', 'log'],
  ['helper1Name', 'HELPER 1 NAME', 22, 'helper_1_name', 'log'],
  ['helper2Name', 'HELPER 2 NAME', 22, 'helper_2_name', 'log'],
  ['dateTimeIn', 'DATE AND TIME IN', 23, 'date_time_in', 'log'],
  ['timeIn', 'TIME IN', 13, 'time_in', 'log'],
  ['dateTimeOut', 'DATE AND TIME OUT', 23, 'date_time_out', 'log'],
  ['timeOut', 'TIME OUT', 13, 'time_out', 'log'],
  ['hoursStay', 'HOURS STAY', 14, 'hours_stay', 'log'],
  ['sortPriority', 'SORT PRIORITY', 14, 'sort_priority', 'log'],
];

const logFields = ['title', 'company', 'logPlateNumber', 'helper1Name', 'helper2Name', 'dateTimeIn', 'timeIn', 'dateTimeOut', 'timeOut', 'hoursStay', 'sortPriority'];
const sapFields = ['destination', 'item', 'description', 'drNumber', 'gatepassNumber', 'quantity', 'uom', 'poNumber', 'batch', 'breakdown', 'mfgDate', 'expDate', 'matdoc', 'supplierLot', 'remarks', ...logFields];
const warehouseFields = ['inventoryController', 'receivingController', 'helperCount', 'truckType', 'actualReceived', 'palletCount', 'warehouseRemarks', 'qaStart', 'qaEnd', 'qaDisposition'];
const adminFields = [...new Set([...sapFields, ...warehouseFields])];

export function sapEditableColumns(role) {
  if (role === 'admin') return adminFields;
  if (role === 'sap') return sapFields;
  if (role === 'planner') return ['destination'];
  if (role === 'warehouse') return warehouseFields;
  return [];
}

export function sapCanFormat(role) {
  return role === 'sap' || role === 'admin';
}

export function encodedByName(name) {
  const parts = String(name || 'SAP Analyst').trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return parts[0] || 'SAP Analyst';
  return `${parts[0][0].toUpperCase()}. ${parts.at(-1)}`;
}

const identifier = value => {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) throw new Error('Invalid SAP schema/table identifier');
  return `"${value}"`;
};

export function sapNetworkAllowed(request) {
  return inNetworks(clientAddress(request, process.env.SAP_TRUSTED_PROXY_CIDRS), process.env.SAP_ALLOWED_CIDRS);
}

const cleanFormats = formats => {
  if (!formats || typeof formats !== 'object' || Array.isArray(formats)) return {};
  return Object.fromEntries(Object.entries(formats).filter(([key, value]) => sapColumns.some(([column]) => column === key) && value && typeof value === 'object' && !Array.isArray(value)));
};

export function createSapRepository() {
  const jsonTrial = process.env.SAP_STORAGE === 'json';
  const host = process.env.POSTGRES_HOST || '';
  const configured = !!host && host !== 'your_postgres_host' && !!process.env.POSTGRES_PASSWORD;
  const schemaName = process.env.POSTGRES_SCHEMA || 'Analysis';
  const tableName = process.env.POSTGRES_SESSION_LOGS_TABLE || 'SAPAnalysis';
  const table = `${identifier(schemaName)}.${identifier(tableName)}`;
  const pool = configured && !jsonTrial ? new pg.Pool({
    host,
    port: Number(process.env.POSTGRES_PORT || 5432),
    database: process.env.POSTGRES_DB || 'docker',
    user: process.env.POSTGRES_USER,
    password: process.env.POSTGRES_PASSWORD,
    max: 3,
    connectionTimeoutMillis: 2500,
    query_timeout: 10000,
    ssl: process.env.POSTGRES_SSL === 'true' ? { rejectUnauthorized: true } : false,
  }) : null;
  pool?.on('error', () => {});
  let ready = false;
  const synced = new Set();

  const initialize = async () => {
    if (!pool) fail('SAP database is not configured', 503);
    if (ready) return;
    await pool.query(`CREATE SCHEMA IF NOT EXISTS ${identifier(schemaName)}`);
    await pool.query(`CREATE TABLE IF NOT EXISTS ${table} (
      id BIGSERIAL PRIMARY KEY,
      record_key TEXT UNIQUE NOT NULL,
      shipment_id BIGINT,
      supplier TEXT,
      revision INTEGER NOT NULL DEFAULT 0,
      verified BOOLEAN NOT NULL DEFAULT FALSE,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await pool.query(`ALTER TABLE ${table}
      ${sapColumns.map(([, , , db]) => `ADD COLUMN IF NOT EXISTS ${identifier(db)} TEXT NOT NULL DEFAULT ''`).join(',\n')},
      ADD COLUMN IF NOT EXISTS cell_formats JSONB NOT NULL DEFAULT '{}'::jsonb,
      ADD COLUMN IF NOT EXISTS row_height INTEGER,
      ADD COLUMN IF NOT EXISTS row_hidden BOOLEAN NOT NULL DEFAULT FALSE`);
    ready = true;
  };

  const decode = row => ({
    key: row.record_key,
    shipmentId: row.shipment_id == null ? '' : String(row.shipment_id),
    supplier: row.supplier || '',
    revision: Number(row.revision || 0),
    verified: Boolean(row.verified),
    values: Object.fromEntries(sapColumns.map(([key, , , db]) => [key, key === 'supplierName' ? (row[db] || row.supplier || '') : (row[db] ?? '')])),
    formats: cleanFormats(row.cell_formats),
    rowHeight: row.row_height == null ? null : Number(row.row_height),
    rowHidden: Boolean(row.row_hidden),
  });

  return {
    jsonTrial,
    async sync(rows) {
      await initialize();
      const records = rows.filter(row => !synced.has(row.key)).map(row => ({
        record_key: row.key,
        shipment_id: row.shipmentId || null,
        supplier: row.supplier,
        ...Object.fromEntries(sapColumns.map(([key, , , db]) => [db, String(row.values[key] ?? '')])),
      }));
      if (!records.length) return;
      await pool.query(`INSERT INTO ${table} (record_key, shipment_id, supplier, ${sapColumns.map(([, , , db]) => identifier(db)).join(',')})
        SELECT record_key, shipment_id, supplier, ${sapColumns.map(([, , , db]) => identifier(db)).join(',')}
        FROM jsonb_to_recordset($1::jsonb) AS x(record_key TEXT, shipment_id BIGINT, supplier TEXT, ${sapColumns.map(([, , , db]) => `${identifier(db)} TEXT`).join(',')})
        ON CONFLICT (record_key) DO NOTHING`, [JSON.stringify(records)]);
      records.forEach(row => synced.add(row.record_key));
    },
    async page(offset, limit, search = '', sort = 'desc') {
      await initialize();
      const term = String(search || '').trim().slice(0, 200);
      const args = [limit + 1, offset];
      let where = '';
      if (term) {
        args.push(`%${term}%`);
        const searchable = ['record_key', 'supplier', ...sapColumns.map(([, , , db]) => db)];
        where = `WHERE concat_ws(' ', ${searchable.map(identifier).join(',')}) ILIKE $3`;
      }
      const direction = String(sort).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
      const result = await pool.query(`SELECT * FROM ${table} ${where} ORDER BY id ${direction} LIMIT $1 OFFSET $2`, args);
      return { rows: result.rows.slice(0, limit).map(decode), hasMore: result.rows.length > limit };
    },
    async byKeys(keys) {
      await initialize();
      return (await pool.query(`SELECT * FROM ${table} WHERE record_key=ANY($1::text[])`, [keys])).rows.map(decode);
    },
    async all() {
      await initialize();
      return (await pool.query(`SELECT * FROM ${table} ORDER BY id DESC`)).rows.map(decode);
    },
    async forShipment(id) {
      await initialize();
      return (await pool.query(`SELECT * FROM ${table} WHERE shipment_id=$1 ORDER BY id`, [id])).rows.map(decode);
    },
    async forClearance(shipment) {
      await initialize();
      const materialCodes = [...new Set((shipment.items || []).map(item => String(item.materialCode || '').trim()).filter(Boolean))];
      const drNumbers = [...new Set([shipment.drNumber, ...(shipment.items || []).map(item => item.dnNumber)].flatMap(value => String(value || '').split(',')).map(value => value.trim()).filter(Boolean))];
      const poNumbers = [...new Set([shipment.poNumber, ...(shipment.items || []).map(item => item.poNumber)].flatMap(value => String(value || '').split(',')).map(value => value.trim()).filter(Boolean))];
      const result = await pool.query(`SELECT * FROM ${table}
        WHERE shipment_id=$1
          OR (${identifier('item')} <> '' AND ${identifier('item')}=ANY($2::text[]))
          OR (${identifier('dr_number')} <> '' AND ${identifier('dr_number')}=ANY($3::text[]))
          OR (${identifier('po_number')} <> '' AND ${identifier('po_number')}=ANY($4::text[]))
        ORDER BY CASE WHEN shipment_id=$1 THEN 0 ELSE 1 END, id DESC LIMIT 250`, [shipment.id, materialCodes, drNumbers, poNumbers]);
      return result.rows.map(decode);
    },
    async add(values, name) {
      await initialize();
      const key = `manual:${randomUUID()}`;
      const record = Object.fromEntries(sapColumns.map(([field, , , db]) => [db, String(field === 'encodedBy' ? encodedByName(name) : values?.[field] ?? '')]));
      const result = await pool.query(`INSERT INTO ${table} (record_key, supplier, ${sapColumns.map(([, , , db]) => identifier(db)).join(',')})
        VALUES ($1, $2, ${sapColumns.map((_, index) => `$${index + 3}`).join(',')}) RETURNING *`,
      [key, record.supplier_name || '', ...sapColumns.map(([, , , db]) => record[db])]);
      return decode(result.rows[0]);
    },
    async save(rows, name, role) {
      await initialize();
      const allowed = new Set(sapEditableColumns(role));
      const formatAllowed = sapCanFormat(role);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        for (const row of rows) {
          const assignments = [];
          const args = [];
          for (const [key, , , db] of sapColumns) {
            if (!allowed.has(key) || !Object.prototype.hasOwnProperty.call(row.values || {}, key)) continue;
            args.push(String(row.values[key] ?? ''));
            assignments.push(`${identifier(db)}=$${args.length}`);
          }
          if ((role === 'sap' || role === 'admin') && assignments.length) {
            args.push(encodedByName(name));
            assignments.push(`${identifier('encoded_by')}=$${args.length}`);
          }
          if (formatAllowed && row.formats) {
            args.push(JSON.stringify(cleanFormats(row.formats)));
            assignments.push(`cell_formats=$${args.length}::jsonb`);
          }
          if (formatAllowed && row.rowHeight !== undefined) {
            args.push(row.rowHeight == null ? null : Math.max(20, Math.min(160, Math.round(Number(row.rowHeight)))));
            assignments.push(`row_height=$${args.length}`);
          }
          if (formatAllowed && row.rowHidden !== undefined) {
            args.push(Boolean(row.rowHidden));
            assignments.push(`row_hidden=$${args.length}`);
          }
          if (!assignments.length) fail('No permitted worksheet changes were supplied', 403);
          if (role === 'sap' || role === 'admin') {
            args.push(Boolean(row.verified));
            assignments.push(`verified=$${args.length}`);
          }
          args.push(row.key);
          const keyParameter = args.length;
          args.push(Number(row.revision));
          const revisionParameter = args.length;
          const result = await client.query(`UPDATE ${table} SET ${assignments.join(',')}, revision=revision+1, updated_at=NOW()
            WHERE record_key=$${keyParameter} AND revision=$${revisionParameter} RETURNING record_key`, args);
          if (!result.rowCount) fail('Worksheet changed. Reload before saving.', 409);
        }
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },
  };
}
