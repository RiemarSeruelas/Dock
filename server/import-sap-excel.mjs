import { createHash } from "node:crypto";
import { basename, extname, resolve } from "node:path";
import { access } from "node:fs/promises";
import ExcelJS from "exceljs";
import pg from "pg";

const SAP_COLUMNS = [
  ["deliveryDate", "delivery_date", ["delivery date"]],
  ["encodedBy", "encoded_by", ["encoded by"]],
  ["item", "item", ["item", "item code", "material", "material code"]],
  ["description", "description", ["description", "material description"]],
  ["drNumber", "dr_number", ["dr no", "dr number", "delivery receipt", "delivery receipt number"]],
  ["quantity", "quantity", ["dr quantity", "quantity", "delivery quantity"]],
  ["uom", "uom", ["uom", "unit of measure"]],
  ["actualReceived", "actual_received", ["actual received", "received quantity"]],
  ["poNumber", "po_number", ["po number", "po no", "purchase order"]],
  ["batch", "batch", ["batch", "batch number"]],
  ["breakdown", "breakdown", ["breakdown"]],
  ["mfgDate", "mfg_date", ["mfg date", "manufacturing date", "production date"]],
  ["expDate", "exp_date", ["exp date", "expiry date", "expiration date"]],
  ["matdoc", "matdoc", ["matdoc", "material document", "material document number"]],
  ["supplierLot", "supplier_lot", ["supplier s lot", "supplier lot", "lot", "lot number"]],
  ["remarks", "remarks", ["remarks", "remark"]],
];

const normalizeHeader = value => String(value ?? "")
  .trim()
  .toLowerCase()
  .replace(/[’']/g, " ")
  .replace(/[^a-z0-9]+/g, " ")
  .trim();

const aliases = new Map();
for (const [key, , names] of SAP_COLUMNS) {
  for (const name of names) aliases.set(normalizeHeader(name), key);
}

const identifier = value => {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) throw new Error(`Invalid PostgreSQL identifier: ${value}`);
  return `"${value}"`;
};

const pad = value => String(value).padStart(2, "0");
const formatExcelDate = (value, includeTime) => {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value ?? "").trim();
  const day = `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
  return includeTime ? `${day} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}` : day;
};

const primitiveText = (value, key) => {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return formatExcelDate(value, key === "deliveryDate");
  if (typeof value === "object") {
    if (Array.isArray(value.richText)) return value.richText.map(part => part.text || "").join("").trim();
    if (Object.hasOwn(value, "result")) return primitiveText(value.result, key);
    if (Object.hasOwn(value, "text")) return primitiveText(value.text, key);
  }
  return String(value).trim();
};

const cellText = (cell, key, warnings) => {
  const value = cell.value;
  if (value && typeof value === "object" && Object.hasOwn(value, "formula") && !Object.hasOwn(value, "result")) {
    warnings.push(`${cell.worksheet.name}!${cell.address} has a formula without a cached result and was imported as blank.`);
    return "";
  }
  return primitiveText(value, key);
};

const parseArguments = argv => {
  const options = { file: "", sheet: "", supplier: "Historical Import", batch: "", commit: false, help: false };
  for (const argument of argv) {
    if (argument === "--commit") options.commit = true;
    else if (argument === "--dry-run") options.commit = false;
    else if (argument === "--help" || argument === "-h") options.help = true;
    else if (argument.startsWith("--sheet=")) options.sheet = argument.slice(8).trim();
    else if (argument.startsWith("--supplier=")) options.supplier = argument.slice(11).trim();
    else if (argument.startsWith("--batch=")) options.batch = argument.slice(8).trim();
    else if (argument.startsWith("--")) throw new Error(`Unknown option: ${argument}`);
    else if (!options.file) options.file = argument;
    else throw new Error(`Unexpected argument: ${argument}`);
  }
  return options;
};

const usage = () => console.log(`
DockFlow SAP historical Excel importer

Usage:
  node server/import-sap-excel.mjs <workbook.xlsx> [options]

Options:
  --dry-run                 Parse and validate only (default)
  --commit                  Write/upsert the parsed rows to PostgreSQL
  --sheet=<name>            Import one sheet; otherwise all recognized sheets
  --supplier=<name>         Internal supplier label (default: Historical Import)
  --batch=<stable-name>     Stable import identity (default: workbook filename)

Keep the same --batch value when re-importing a corrected version of the same
dataset. A dry run never connects to or changes PostgreSQL.
`);

const findHeader = worksheet => {
  for (let rowNumber = 1; rowNumber <= Math.min(25, worksheet.rowCount); rowNumber += 1) {
    const mapping = new Map();
    worksheet.getRow(rowNumber).eachCell({ includeEmpty: false }, (cell, columnNumber) => {
      const key = aliases.get(normalizeHeader(cell.text));
      if (key && !mapping.has(key)) mapping.set(key, columnNumber);
    });
    if (mapping.size >= 5 && mapping.has("item")) return { rowNumber, mapping };
  }
  return null;
};

const historicalIdentity = (batch, sheet, sourceRow) => {
  const digest = createHash("sha256").update(`${batch}\0${sheet}\0${sourceRow}`).digest("hex");
  const shipmentId = 8_000_000_000_000_000_000n + BigInt(`0x${digest.slice(0, 15)}`);
  return { shipmentId: shipmentId.toString(), recordKey: `${shipmentId}:1` };
};

export async function parseWorkbook(filePath, options = {}) {
  const absolutePath = resolve(filePath);
  await access(absolutePath);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(absolutePath);
  const selected = options.sheet ? workbook.worksheets.filter(sheet => sheet.name === options.sheet) : workbook.worksheets;
  if (options.sheet && !selected.length) throw new Error(`Worksheet not found: ${options.sheet}`);

  const batch = String(options.batch || basename(absolutePath, extname(absolutePath))).trim();
  if (!batch) throw new Error("The import batch name cannot be blank");
  const supplier = String(options.supplier || "Historical Import").trim();
  const warnings = [];
  const skippedSheets = [];
  const rows = [];

  for (const worksheet of selected) {
    const header = findHeader(worksheet);
    if (!header) {
      skippedSheets.push(worksheet.name);
      continue;
    }
    for (let rowNumber = header.rowNumber + 1; rowNumber <= worksheet.rowCount; rowNumber += 1) {
      const values = {};
      for (const [key] of SAP_COLUMNS) {
        const columnNumber = header.mapping.get(key);
        values[key] = columnNumber ? cellText(worksheet.getCell(rowNumber, columnNumber), key, warnings) : "";
      }
      const meaningful = Object.values(values).some(value => value !== "");
      if (!meaningful) continue;
      // The supplied template's second row contains field guidance, not a record.
      const looksLikeNotes = normalizeHeader(values.encodedBy) === "sap analysts" || /can get from dockflow|internal data only|from planner/i.test(Object.values(values).join(" "));
      if (looksLikeNotes) continue;
      const identity = historicalIdentity(batch, worksheet.name, rowNumber);
      rows.push({ ...identity, supplier, sheet: worksheet.name, sourceRow: rowNumber, values });
    }
  }
  if (!rows.length) throw new Error("No SAP data rows were found. Check the worksheet headers or --sheet option.");
  return { absolutePath, batch, supplier, rows, warnings, skippedSheets };
}

const summarize = parsed => {
  const missing = Object.fromEntries(SAP_COLUMNS.map(([key]) => [key, parsed.rows.filter(row => !row.values[key]).length]));
  console.log(`Workbook: ${parsed.absolutePath}`);
  console.log(`Batch: ${parsed.batch}`);
  console.log(`Supplier label: ${parsed.supplier}`);
  console.log(`Rows ready: ${parsed.rows.length.toLocaleString("en-US")}`);
  if (parsed.skippedSheets.length) console.log(`Skipped sheets without recognized SAP headers: ${parsed.skippedSheets.join(", ")}`);
  console.log(`Missing UOM: ${missing.uom.toLocaleString("en-US")}; missing Actual Received: ${missing.actualReceived.toLocaleString("en-US")}`);
  console.log(`Missing Item: ${missing.item.toLocaleString("en-US")}; missing DR No: ${missing.drNumber.toLocaleString("en-US")}; missing Delivery Date: ${missing.deliveryDate.toLocaleString("en-US")}`);
  if (parsed.warnings.length) {
    console.log(`Warnings: ${parsed.warnings.length.toLocaleString("en-US")}`);
    parsed.warnings.slice(0, 10).forEach(warning => console.log(`  - ${warning}`));
    if (parsed.warnings.length > 10) console.log(`  - ...and ${parsed.warnings.length - 10} more`);
  }
  console.log("Sample:");
  parsed.rows.slice(0, 3).forEach(row => console.log(`  ${row.sheet}!${row.sourceRow}: ${row.values.deliveryDate} | ${row.values.item} | ${row.values.drNumber} | ${row.values.quantity}`));
};

const databaseConfig = () => {
  const host = String(process.env.POSTGRES_HOST || "").trim();
  const password = String(process.env.POSTGRES_PASSWORD || "");
  const user = String(process.env.POSTGRES_USER || "").trim();
  if (!host || host === "your_postgres_host" || !user || !password) throw new Error("Set POSTGRES_HOST, POSTGRES_USER and POSTGRES_PASSWORD in .env before using --commit");
  return {
    host,
    port: Number(process.env.POSTGRES_PORT || 5432),
    database: process.env.POSTGRES_DB || "docker",
    user,
    password,
    ssl: process.env.POSTGRES_SSL === "true" ? { rejectUnauthorized: true } : false,
    connectionTimeoutMillis: 5000,
    query_timeout: 30000,
  };
};

const importRows = async parsed => {
  const schemaName = process.env.POSTGRES_SCHEMA || "Analysis";
  const tableName = process.env.POSTGRES_SESSION_LOGS_TABLE || "SAPAnalysis";
  const schema = identifier(schemaName);
  const table = `${schema}.${identifier(tableName)}`;
  const client = new pg.Client(databaseConfig());
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
    await client.query(`CREATE TABLE IF NOT EXISTS ${table} (id BIGSERIAL PRIMARY KEY, record_key TEXT UNIQUE NOT NULL, shipment_id BIGINT, supplier TEXT, revision INTEGER NOT NULL DEFAULT 0, verified BOOLEAN NOT NULL DEFAULT FALSE, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), ${SAP_COLUMNS.map(([, db]) => `${identifier(db)} TEXT NOT NULL DEFAULT ''`).join(",")})`);

    const expected = ["record_key", "shipment_id", "supplier", "revision", "verified", "updated_at", ...SAP_COLUMNS.map(([, db]) => db)];
    const columnResult = await client.query("SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2", [schemaName, tableName]);
    const found = new Set(columnResult.rows.map(row => row.column_name));
    const absent = expected.filter(column => !found.has(column));
    if (absent.length) throw new Error(`Existing ${schemaName}.${tableName} table is incompatible; missing columns: ${absent.join(", ")}`);

    let inserted = 0;
    let updated = 0;
    for (let index = 0; index < parsed.rows.length; index += 500) {
      const batch = parsed.rows.slice(index, index + 500);
      const keys = batch.map(row => row.recordKey);
      const existing = new Set((await client.query(`SELECT record_key FROM ${table} WHERE record_key=ANY($1::text[])`, [keys])).rows.map(row => row.record_key));
      const records = batch.map(row => ({
        record_key: row.recordKey,
        shipment_id: row.shipmentId,
        supplier: row.supplier,
        ...Object.fromEntries(SAP_COLUMNS.map(([key, db]) => [db, row.values[key] || ""])),
      }));
      const dbColumns = SAP_COLUMNS.map(([, db]) => db);
      await client.query(`
        INSERT INTO ${table} AS target
          (record_key, shipment_id, supplier, ${dbColumns.map(identifier).join(",")})
        SELECT record_key, shipment_id, supplier, ${dbColumns.map(identifier).join(",")}
        FROM jsonb_to_recordset($1::jsonb) AS source
          (record_key TEXT, shipment_id BIGINT, supplier TEXT, ${dbColumns.map(db => `${identifier(db)} TEXT`).join(",")})
        ON CONFLICT (record_key) DO UPDATE SET
          shipment_id=EXCLUDED.shipment_id,
          supplier=EXCLUDED.supplier,
          ${dbColumns.map(db => `${identifier(db)}=EXCLUDED.${identifier(db)}`).join(",")},
          revision=target.revision+1,
          updated_at=NOW()
      `, [JSON.stringify(records)]);
      updated += existing.size;
      inserted += batch.length - existing.size;
      console.log(`Processed ${Math.min(index + batch.length, parsed.rows.length).toLocaleString("en-US")} / ${parsed.rows.length.toLocaleString("en-US")}`);
    }
    await client.query("COMMIT");
    return { inserted, updated, table: `${schemaName}.${tableName}` };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end().catch(() => undefined);
  }
};

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help || !options.file) {
    usage();
    process.exitCode = options.help ? 0 : 1;
    return;
  }
  const parsed = await parseWorkbook(options.file, options);
  summarize(parsed);
  if (!options.commit) {
    console.log("DRY RUN ONLY — PostgreSQL was not contacted or changed. Add --commit after reviewing this summary.");
    return;
  }
  const result = await importRows(parsed);
  console.log(`Import complete: ${result.inserted.toLocaleString("en-US")} inserted, ${result.updated.toLocaleString("en-US")} updated in ${result.table}.`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  main().catch(error => {
    console.error(`SAP import failed: ${error.message}`);
    process.exitCode = 1;
  });
}

