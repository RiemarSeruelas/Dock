import bcrypt from "bcryptjs";
import cors from "cors";
import express from "express";
import helmet from "helmet";
import jwt from "jsonwebtoken";
import multer from "multer";
import pg from "pg";
import QRCode from "qrcode";
import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { importHelpers, parseDeliveryWorkbook } from "./excel-import.js";

const { Pool } = pg;
const PORT = Number(process.env.API_PORT || 3001);
const DATABASE_URL = process.env.DATABASE_URL || "postgresql://dockflow:dockflow@localhost:5432/dockflow";
const JWT_SECRET = process.env.JWT_SECRET || "change-this-secret-before-production";
const UPLOAD_DIR = resolve(process.env.UPLOAD_DIR || "./uploads");
const APP_ORIGIN = process.env.APP_ORIGIN || "http://localhost:5059";
const pool = new Pool({ connectionString: DATABASE_URL });
const app = express();

await mkdir(UPLOAD_DIR, { recursive: true });
const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (_request, file, callback) => callback(null, `${Date.now()}-${Math.random().toString(36).slice(2, 9)}${extname(file.originalname).toLowerCase()}`),
  }),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (_request, file, callback) => callback(null, ["application/pdf", "image/jpeg", "image/png", "image/webp"].includes(file.mimetype)),
});
const excelUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
  fileFilter: (_request, file, callback) => callback(null, [".xlsx", ".xlsm"].includes(extname(file.originalname).toLowerCase())),
});
const importPreviews = new Map();

app.set("trust proxy", 1);
app.use(helmet({ crossOriginResourcePolicy: false }));
app.use(cors({ origin: APP_ORIGIN.split(","), credentials: false }));
app.use(express.json({ limit: "2mb" }));

const asyncRoute = (handler) => (request, response, next) => Promise.resolve(handler(request, response, next)).catch(next);
const signToken = (user) => jwt.sign({ id: user.id, role: user.role, supplierId: user.supplier_id, name: user.name }, JWT_SECRET, { expiresIn: "12h" });
const auth = (request, response, next) => {
  const token = request.headers.authorization?.replace(/^Bearer\s+/i, "");
  if (!token) return response.status(401).json({ message: "Authentication required" });
  try { request.user = jwt.verify(token, JWT_SECRET); next(); } catch { response.status(401).json({ message: "Session expired" }); }
};
const allow = (...roles) => (request, response, next) => roles.includes(request.user.role) ? next() : response.status(403).json({ message: "This action is not available for your role" });
const logEvent = (client, shipmentId, actorId, action, detail, metadata = {}) => client.query("INSERT INTO shipment_events (shipment_id, actor_id, action, detail, metadata) VALUES ($1,$2,$3,$4,$5)", [shipmentId || null, actorId || null, action, detail, metadata]);
const nextCode = (prefix, id, date = new Date()) => `${prefix}-${date.toISOString().slice(0, 10).replaceAll("-", "")}-${String(id).padStart(3, "0")}`;
const validTime = (value) => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(value || ""));
const scheduleLabel = (start, end) => end ? `${start} - ${end}` : start;
const durationMinutes = (start, end) => {
  if (!start || !end) return null;
  const [startHour, startMinute] = start.split(":").map(Number);
  const [endHour, endMinute] = end.split(":").map(Number);
  let duration = endHour * 60 + endMinute - (startHour * 60 + startMinute);
  if (duration <= 0) duration += 24 * 60;
  return duration;
};

async function initializeDatabase() {
  for (let attempt = 1; attempt <= 30; attempt += 1) {
    try {
      const sql = await readFile(new URL("../db/init.sql", import.meta.url), "utf8");
      await pool.query(sql);
      await seedDatabase();
      return;
    } catch (error) {
      if (attempt === 30) throw error;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 2000));
    }
  }
}

async function seedDatabase() {
  const accounts = [
    ["System Administrator", "admin", "admin123", "admin", null],
    ["Planner User", "planner", "planner123", "planner", null],
    ["Supplier User", "supplier", "supplier123", "supplier", null],
    ["Driver User", "driver", "driver123", "driver", null],
    ["Security User", "security", "security123", "security", null],
    ["Warehouse User", "warehouse", "warehouse123", "warehouse", null],
  ];
  for (const account of accounts) {
    const hash = await bcrypt.hash(account[2], 10);
    await pool.query("INSERT INTO users (name,username,password_hash,role,supplier_id) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (username) DO NOTHING", [account[0], account[1], hash, account[3], account[4]]);
  }
  await pool.query("INSERT INTO app_settings (key,value) VALUES ('schedule',$1) ON CONFLICT (key) DO NOTHING", [{ flexibleScheduling: true, dockCount: 3, graceMinutes: 30, siteName: "Cavite Foods Receiving" }]);
}

app.get("/api/health", (_request, response) => response.json({ status: "ok" }));

app.post("/api/auth/login", asyncRoute(async (request, response) => {
  const { username, password } = request.body || {};
  const result = await pool.query("SELECT * FROM users WHERE lower(username)=lower($1) AND active=TRUE", [String(username || "")]);
  const user = result.rows[0];
  if (!user || !await bcrypt.compare(String(password || ""), user.password_hash)) return response.status(401).json({ message: "Incorrect username or password" });
  response.json({ token: signToken(user), user: { id: user.id, name: user.name, username: user.username, role: user.role, supplierId: user.supplier_id } });
}));

app.get("/api/bootstrap", auth, asyncRoute(async (request, response) => {
  const [shipmentsResult, itemsResult, palletResult, documentsResult, rdsResult, materialsResult, usersResult, eventsResult, settingsResult, importsResult] = await Promise.all([
    pool.query("SELECT s.*, sp.name AS supplier, sp.vendor_code, ib.file_name AS import_file FROM shipments s JOIN suppliers sp ON sp.id=s.supplier_id LEFT JOIN import_batches ib ON ib.id=s.import_batch_id ORDER BY s.scheduled_date, s.scheduled_time NULLS LAST, s.time_slot, s.id"),
    pool.query("SELECT * FROM shipment_items ORDER BY id"),
    pool.query("SELECT shipment_id, COUNT(*)::int AS scanned FROM pallet_scans GROUP BY shipment_id"),
    pool.query("SELECT d.*, si.shipment_id FROM shipment_documents d JOIN shipment_items si ON si.id=d.shipment_item_id"),
    pool.query("SELECT r.id,r.rds_number,r.status,d.dpp_number,d.requested_date,d.arrival_shift,d.notes,sp.name AS supplier,sp.id AS supplier_id FROM rds_requests r JOIN dpps d ON d.id=r.dpp_id JOIN suppliers sp ON sp.id=d.supplier_id ORDER BY r.created_at DESC"),
    pool.query("SELECT * FROM materials WHERE active=TRUE ORDER BY name"),
    pool.query("SELECT id,name,username,role,supplier_id FROM users WHERE active=TRUE ORDER BY name"),
    pool.query("SELECT e.id,e.created_at,e.action,e.detail,s.shipment_number,u.name AS actor FROM shipment_events e LEFT JOIN shipments s ON s.id=e.shipment_id LEFT JOIN users u ON u.id=e.actor_id ORDER BY e.created_at DESC LIMIT 50"),
    pool.query("SELECT value FROM app_settings WHERE key='schedule'"),
    pool.query("SELECT id,file_name,status,total_rows,imported_rows,skipped_rows,delivery_count,created_at,completed_at FROM import_batches ORDER BY created_at DESC LIMIT 15"),
  ]);
  let shipmentRows = shipmentsResult.rows;
  let rdsRows = rdsResult.rows;
  if (request.user.role === "supplier") { shipmentRows = shipmentRows.filter(row => row.supplier_id === request.user.supplierId); rdsRows = rdsRows.filter(row => row.supplier_id === request.user.supplierId); }
  if (request.user.role === "driver") shipmentRows = shipmentRows.filter(row => row.driver_name.toLowerCase() === request.user.name.toLowerCase());
  const visibleIds = new Set(shipmentRows.map(row => row.id));
  const items = itemsResult.rows.filter(row => visibleIds.has(row.shipment_id));
  const documents = documentsResult.rows.filter(row => visibleIds.has(row.shipment_id));
  const palletMap = new Map(palletResult.rows.map(row => [row.shipment_id, row.scanned]));
  response.json({
    shipments: shipmentRows.map(row => ({ id: row.id, shipmentNumber: row.shipment_number, bookingReceipt: row.booking_receipt, supplier: row.supplier, vendorCode: row.vendor_code, scheduledDate: row.scheduled_date.toISOString().slice(0,10), scheduledTime: row.scheduled_time?.slice?.(0,5) || row.time_slot.slice(0,5), scheduledEndTime: row.scheduled_end_time?.slice?.(0,5) || null, expectedDurationMinutes: row.expected_duration_minutes, timeSlot: row.time_slot, shift: row.arrival_shift, status: row.status, truckPlate: row.truck_plate, driverName: row.driver_name, driverPhone: row.driver_phone, materialWeightKg: Number(row.material_weight_kg), dock: row.dock, arrivalTime: row.arrived_at, startedAt: row.started_at, completedAt: row.completed_at, rejectionReason: row.rejection_reason, importBatchId: row.import_batch_id ? Number(row.import_batch_id) : null, importSource: row.import_file, palletsScanned: palletMap.get(row.id) || 0, palletsTotal: items.filter(item => item.shipment_id === row.id).reduce((sum, item) => sum + item.pallet_count, 0), items: items.filter(item => item.shipment_id === row.id).map(item => ({ id: item.id, poNumber: item.po_number, materialCode: item.material_code, materialName: item.material_name, quantity: Number(item.quantity), uom: item.uom, palletCount: item.pallet_count, dnNumber: item.dn_number, batchNumber: item.batch_number, productionDate: item.production_date?.toISOString?.().slice(0,10) || item.production_date, expiryDate: item.expiry_date?.toISOString?.().slice(0,10) || item.expiry_date, sourceSheet: item.source_sheet, sourceRow: item.source_row, sourceFile: item.source_file, deliverySite: item.delivery_site, deliveryWeek: item.delivery_week, poBalance: item.po_balance == null ? null : Number(item.po_balance), poQuantity: item.po_quantity == null ? null : Number(item.po_quantity), stillToBeDelivered: item.still_to_be_delivered == null ? null : Number(item.still_to_be_delivered), remarks: item.remarks, dnFileName: documents.find(doc => doc.shipment_item_id === item.id && doc.document_type === "DN")?.original_name, coaFileName: documents.find(doc => doc.shipment_item_id === item.id && doc.document_type === "COA")?.original_name })) })),
    rdsRequests: rdsRows.map(row => ({ id: row.id, rdsNumber: row.rds_number, dppNumber: row.dpp_number, supplier: row.supplier, requestedDate: row.requested_date.toISOString().slice(0,10), arrivalShift: row.arrival_shift, status: row.status, notes: row.notes })),
    materials: materialsResult.rows.map(row => ({ id: row.id, code: row.code, name: row.name, type: row.type, uom: row.uom, shelfLifeDays: row.shelf_life_days, unitsPerPallet: Number(row.units_per_pallet), storageZone: row.storage_zone })),
    users: usersResult.rows.map(row => ({ id: row.id, name: row.name, username: row.username, role: row.role, supplierId: row.supplier_id })),
    audit: eventsResult.rows.map(row => ({ id: Number(row.id), at: row.created_at, actor: row.actor || "System", action: row.action, shipmentNumber: row.shipment_number, detail: row.detail })),
    settings: settingsResult.rows[0]?.value || { flexibleScheduling: true, dockCount: 3, graceMinutes: 30, siteName: "Receiving" },
    importBatches: ["admin", "planner"].includes(request.user.role) ? importsResult.rows.map(row => ({ id: Number(row.id), fileName: row.file_name, status: row.status, totalRows: row.total_rows, importedRows: row.imported_rows, skippedRows: row.skipped_rows, deliveryCount: row.delivery_count, createdAt: row.created_at, completedAt: row.completed_at })) : [],
  });
}));

app.post("/api/rds", auth, allow("admin", "planner"), asyncRoute(async (request, response) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const supplier = (await client.query("SELECT id FROM suppliers WHERE name=$1 AND active=TRUE", [request.body.supplier])).rows[0];
    if (!supplier) { await client.query("ROLLBACK"); return response.status(400).json({ message: "Supplier not found" }); }
    const items = [{ poNumber: request.body.poNumber, materialCode: request.body.materialCode, materialName: request.body.materialName, quantity: Number(request.body.quantity), uom: request.body.uom, palletCount: Number(request.body.palletCount) }];
    const dpp = await client.query("INSERT INTO dpps (dpp_number,supplier_id,requested_date,arrival_shift,notes,items,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id", [request.body.dppNumber, supplier.id, request.body.requestedDate, request.body.arrivalShift, request.body.notes || null, JSON.stringify(items), request.user.id]);
    const id = Number((await client.query("SELECT COALESCE(MAX(id),0)+1 AS id FROM rds_requests")).rows[0].id);
    const rdsNumber = nextCode("RDS", id);
    const rds = await client.query("INSERT INTO rds_requests (rds_number,dpp_id) VALUES ($1,$2) RETURNING id", [rdsNumber, dpp.rows[0].id]);
    await logEvent(client, null, request.user.id, "RDS_CREATED", `${rdsNumber} sent to ${request.body.supplier}`);
    await client.query("COMMIT");
    response.status(201).json({ id: rds.rows[0].id, rdsNumber });
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
}));

app.patch("/api/rds/:id/confirm", auth, allow("admin", "supplier"), asyncRoute(async (request, response) => {
  const result = await pool.query("UPDATE rds_requests r SET status='CONFIRMED',confirmed_by=$1,confirmed_at=NOW() FROM dpps d WHERE r.id=$2 AND d.id=r.dpp_id AND r.status='PENDING' AND ($3::int IS NULL OR d.supplier_id=$3) RETURNING r.rds_number", [request.user.id, request.params.id, request.user.role === "supplier" ? request.user.supplierId : null]);
  if (!result.rowCount) return response.status(404).json({ message: "Pending RDS not found for this supplier" });
  await logEvent(pool, null, request.user.id, "RDS_CONFIRMED", `${result.rows[0].rds_number} confirmed by supplier`);
  response.json({ ok: true });
}));

app.post("/api/shipments", auth, allow("admin", "planner", "supplier"), asyncRoute(async (request, response) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const rds = (await client.query("SELECT r.*,d.supplier_id,d.arrival_shift,d.items FROM rds_requests r JOIN dpps d ON d.id=r.dpp_id WHERE r.id=$1 FOR UPDATE", [request.body.rdsId])).rows[0];
    if (!rds || rds.status !== "CONFIRMED") { await client.query("ROLLBACK"); return response.status(400).json({ message: "RDS must be confirmed before booking" }); }
    if (request.user.role === "supplier" && rds.supplier_id !== request.user.supplierId) { await client.query("ROLLBACK"); return response.status(403).json({ message: "This RDS belongs to another supplier" }); }
    const scheduledTime = String(request.body.scheduledTime || request.body.timeSlot || "").slice(0, 5);
    const scheduledEndTime = String(request.body.scheduledEndTime || "").slice(0, 5) || null;
    if (!validTime(scheduledTime) || (scheduledEndTime && !validTime(scheduledEndTime))) { await client.query("ROLLBACK"); return response.status(400).json({ message: "Choose a valid delivery date and exact arrival time" }); }
    const timeSlot = scheduleLabel(scheduledTime, scheduledEndTime);
    const arrivalShift = importHelpers.shiftForTime(scheduledTime);
    const expectedDuration = scheduledEndTime ? durationMinutes(scheduledTime, scheduledEndTime) : Number(request.body.expectedDurationMinutes || 0) || null;
    const concurrent = Number((await client.query("SELECT COUNT(*) AS count FROM shipments WHERE scheduled_date=$1 AND scheduled_time=$2 AND status<>'REJECTED'", [request.body.scheduledDate, scheduledTime])).rows[0].count);
    const id = Number((await client.query("SELECT COALESCE(MAX(id),0)+1 AS id FROM shipments")).rows[0].id);
    const shipmentNumber = nextCode("SHP", id, new Date(`${request.body.scheduledDate}T12:00:00`));
    const bookingReceipt = nextCode("BKG", id);
    const shipment = await client.query("INSERT INTO shipments (shipment_number,booking_receipt,rds_id,supplier_id,scheduled_date,time_slot,scheduled_time,scheduled_end_time,expected_duration_minutes,arrival_shift,truck_plate,driver_name,driver_phone,material_weight_kg) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id", [shipmentNumber, bookingReceipt, rds.id, rds.supplier_id, request.body.scheduledDate, timeSlot, scheduledTime, scheduledEndTime, expectedDuration, arrivalShift, request.body.truckPlate, request.body.driverName, request.body.driverPhone, request.body.materialWeightKg]);
    const itemIds = [];
    for (const item of rds.items || []) { const inserted = await client.query("INSERT INTO shipment_items (shipment_id,po_number,material_code,material_name,quantity,uom,pallet_count,dn_number,batch_number) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id", [shipment.rows[0].id, item.poNumber, item.materialCode, item.materialName, item.quantity, item.uom, item.palletCount, request.body.dnNumber || null, request.body.batchNumber || null]); itemIds.push(inserted.rows[0].id); }
    await client.query("UPDATE rds_requests SET status='SCHEDULED' WHERE id=$1", [rds.id]);
    await logEvent(client, shipment.rows[0].id, request.user.id, "SHIPMENT_PLANNED", `${shipmentNumber} booked for ${timeSlot}`, { concurrentBookingsAtTime: concurrent });
    await client.query("COMMIT");
    response.status(201).json({ id: shipment.rows[0].id, shipmentNumber, bookingReceipt, itemIds, concurrentBookingsAtTime: concurrent });
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
}));

app.patch("/api/shipments/:id/status", auth, asyncRoute(async (request, response) => {
  const roleTransitions = { driver: ["IN_TRANSIT", "ARRIVED"], security: ["VERIFIED", "PARKING", "AT_DOCK", "REJECTED"], warehouse: ["UNLOADING", "RECEIVED"], admin: ["PLANNED","IN_TRANSIT","ARRIVED","VERIFIED","PARKING","AT_DOCK","UNLOADING","RECEIVED","REJECTED"] };
  if (!(roleTransitions[request.user.role] || []).includes(request.body.status)) return response.status(403).json({ message: "This status change is not available for your role" });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const shipment = (await client.query("SELECT * FROM shipments WHERE id=$1 FOR UPDATE", [request.params.id])).rows[0];
    if (!shipment) { await client.query("ROLLBACK"); return response.status(404).json({ message: "Shipment not found" }); }
    if (request.user.role === "driver" && shipment.driver_name.toLowerCase() !== request.user.name.toLowerCase()) { await client.query("ROLLBACK"); return response.status(403).json({ message: "This shipment is assigned to another driver" }); }
    let status = request.body.status;
    if (request.body.palletId) {
      await client.query("INSERT INTO pallet_scans (shipment_id,pallet_id,scanned_by) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING", [shipment.id, request.body.palletId, request.user.id]);
      const scanned = Number((await client.query("SELECT COUNT(*) AS count FROM pallet_scans WHERE shipment_id=$1", [shipment.id])).rows[0].count);
      const total = Number((await client.query("SELECT COALESCE(SUM(pallet_count),0) AS count FROM shipment_items WHERE shipment_id=$1", [shipment.id])).rows[0].count);
      status = scanned >= total && total > 0 ? "RECEIVED" : "UNLOADING";
    }
    const timestampColumn = { IN_TRANSIT: "started_at", ARRIVED: "arrived_at", VERIFIED: "verified_at", UNLOADING: "unloading_started_at", RECEIVED: "completed_at" }[status];
    const fields = ["status=$1", "updated_at=NOW()"];
    const values = [status];
    if (timestampColumn) fields.push(`${timestampColumn}=NOW()`);
    if (request.body.dock !== undefined) { values.push(request.body.dock || null); fields.push(`dock=$${values.length}`); }
    if (request.body.latitude !== undefined && status === "IN_TRANSIT") { values.push(request.body.latitude, request.body.longitude); fields.push(`start_latitude=$${values.length - 1}`, `start_longitude=$${values.length}`); }
    if (request.body.latitude !== undefined && status === "ARRIVED") { values.push(request.body.latitude, request.body.longitude); fields.push(`arrival_latitude=$${values.length - 1}`, `arrival_longitude=$${values.length}`); }
    values.push(shipment.id);
    await client.query(`UPDATE shipments SET ${fields.join(",")} WHERE id=$${values.length}`, values);
    await logEvent(client, shipment.id, request.user.id, status, request.body.palletId ? `Pallet ${request.body.palletId} scanned` : `${shipment.shipment_number} moved to ${status.replaceAll("_", " ").toLowerCase()}`, request.body);
    await client.query("COMMIT");
    response.json({ ok: true, status });
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
}));

app.patch("/api/shipments/:id/reschedule", auth, allow("admin", "planner"), asyncRoute(async (request, response) => {
  const scheduledTime = String(request.body.scheduledTime || request.body.timeSlot || "").slice(0, 5);
  const scheduledEndTime = String(request.body.scheduledEndTime || "").slice(0, 5) || null;
  if (!validTime(scheduledTime) || (scheduledEndTime && !validTime(scheduledEndTime))) return response.status(400).json({ message: "Choose a valid exact arrival time" });
  const timeSlot = scheduleLabel(scheduledTime, scheduledEndTime);
  const result = await pool.query("UPDATE shipments SET scheduled_date=$1,time_slot=$2,scheduled_time=$3,scheduled_end_time=$4,expected_duration_minutes=$5,arrival_shift=$6,dock=NULL,updated_at=NOW() WHERE id=$7 RETURNING shipment_number", [request.body.scheduledDate, timeSlot, scheduledTime, scheduledEndTime, scheduledEndTime ? durationMinutes(scheduledTime, scheduledEndTime) : null, importHelpers.shiftForTime(scheduledTime), request.params.id]);
  if (!result.rowCount) return response.status(404).json({ message: "Shipment not found" });
  await logEvent(pool, Number(request.params.id), request.user.id, "RESCHEDULED", `${result.rows[0].shipment_number} moved to ${request.body.scheduledDate} ${timeSlot}`);
  response.json({ ok: true });
}));

app.post("/api/imports/excel/preview", auth, allow("admin", "planner"), excelUpload.single("file"), asyncRoute(async (request, response) => {
  if (!request.file) return response.status(400).json({ message: "Choose an .xlsx or .xlsm workbook up to 10 MB" });
  const preview = await parseDeliveryWorkbook(request.file.buffer, request.file.originalname);
  const sourceKeys = preview.rows.filter(row => row.status === "ready").flatMap(row => [row.sourceKey, row.legacySourceKey]).filter(Boolean);
  if (sourceKeys.length) {
    const existing = new Set((await pool.query("SELECT source_key FROM shipment_items WHERE source_key=ANY($1::text[])", [sourceKeys])).rows.map(row => row.source_key));
    for (const row of preview.rows) {
      if (row.status === "ready" && (existing.has(row.sourceKey) || existing.has(row.legacySourceKey))) {
        row.status = "duplicate";
        row.message = "Exact row already imported for this date and time";
      }
    }
  }
  const readyRows = preview.rows.filter(row => row.status === "ready");
  preview.summary.readyRows = readyRows.length;
  preview.summary.skippedRows = preview.rows.length - readyRows.length;
  preview.summary.deliveryGroups = new Set(readyRows.map(row => `${row.supplier.toLowerCase()}|${row.deliveryDate}|${row.deliveryTime}|${row.endTime || ""}|${row.site.toLowerCase()}`)).size;
  preview.summary.poMatchedRows = readyRows.filter(row => row.poNumber).length;
  preview.summary.warningRows = readyRows.filter(row => !row.poNumber).length;
  const expiresAt = Date.now() + 30 * 60 * 1000;
  for (const [key, cached] of importPreviews) if (cached.expiresAt < Date.now()) importPreviews.delete(key);
  const previewToken = randomUUID();
  importPreviews.set(previewToken, { preview, userId: request.user.id, expiresAt });
  response.json({ ...preview, previewToken });
}));

app.post("/api/imports/excel/commit", auth, allow("admin", "planner"), asyncRoute(async (request, response) => {
  const cached = importPreviews.get(String(request.body.previewToken || ""));
  if (!cached || cached.userId !== request.user.id || cached.expiresAt < Date.now()) return response.status(410).json({ message: "The import preview expired. Upload the workbook again." });
  const preview = cached.preview;
  const readyRows = preview.rows.filter(row => row.status === "ready");
  if (!readyRows.length) return response.status(400).json({ message: "There are no valid new rows to import" });
  const groups = new Map();
  for (const row of readyRows) {
    const key = `${row.supplier.toLowerCase()}|${row.deliveryDate}|${row.deliveryTime}|${row.endTime || ""}|${row.site.toLowerCase()}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const client = await pool.connect();
  let importedRows = 0;
  let deliveryCount = 0;
  try {
    await client.query("BEGIN");
    const batch = await client.query("INSERT INTO import_batches (file_name,sheet_names,status,total_rows,skipped_rows,issues,uploaded_by) VALUES ($1,$2,'PREVIEWED',$3,$4,$5,$6) RETURNING id", [preview.fileName, JSON.stringify(preview.detectedSheets.map(sheet => sheet.name)), preview.summary.totalRows, preview.summary.skippedRows, JSON.stringify(preview.issues.slice(0, 250)), request.user.id]);
    const batchId = Number(batch.rows[0].id);
    let groupNumber = 0;
    for (const rows of groups.values()) {
      groupNumber += 1;
      const first = rows[0];
      let supplier = (await client.query("SELECT id,vendor_code FROM suppliers WHERE lower(name)=lower($1) ORDER BY active DESC,id LIMIT 1", [first.supplier])).rows[0];
      if (!supplier) {
        const vendorCode = `XLS-${first.sourceKey.slice(0, 12).toUpperCase()}`;
        supplier = (await client.query("INSERT INTO suppliers (vendor_code,name,contact_name) VALUES ($1,$2,'Imported – details to review') ON CONFLICT (vendor_code) DO UPDATE SET name=EXCLUDED.name RETURNING id,vendor_code", [vendorCode, first.supplier])).rows[0];
      }
      for (const row of rows) {
        await client.query("INSERT INTO materials (code,name,type,uom) VALUES ($1,$2,$3,$4) ON CONFLICT (code) DO UPDATE SET name=EXCLUDED.name,type=EXCLUDED.type,uom=EXCLUDED.uom,updated_at=NOW()", [row.materialCode, row.materialName, row.materialType || "RM", row.uom]);
      }
      const dppNumber = `IMP-DPP-${batchId}-${String(groupNumber).padStart(3, "0")}`;
      const rdsNumber = `IMP-RDS-${batchId}-${String(groupNumber).padStart(3, "0")}`;
      const dppItems = rows.map(row => ({ poNumber: row.poNumber, materialCode: row.materialCode, materialName: row.materialName, quantity: row.quantity, uom: row.uom, palletCount: 0 }));
      const dpp = await client.query("INSERT INTO dpps (dpp_number,supplier_id,requested_date,arrival_shift,notes,items,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id", [dppNumber, supplier.id, first.deliveryDate, first.shift, `Imported from ${preview.fileName}${first.site ? ` · ${first.site}` : ""}`, JSON.stringify(dppItems), request.user.id]);
      const rds = await client.query("INSERT INTO rds_requests (rds_number,dpp_id,status,confirmed_by,confirmed_at) VALUES ($1,$2,'SCHEDULED',$3,NOW()) RETURNING id", [rdsNumber, dpp.rows[0].id, request.user.id]);
      const weightKg = rows.reduce((total, row) => total + (row.uom === "KG" ? row.quantity : row.uom === "MT" ? row.quantity * 1000 : 0), 0);
      const timeSlot = scheduleLabel(first.deliveryTime, first.endTime);
      const insertedShipment = await client.query("INSERT INTO shipments (rds_id,supplier_id,scheduled_date,time_slot,scheduled_time,scheduled_end_time,expected_duration_minutes,arrival_shift,status,truck_plate,driver_name,driver_phone,material_weight_kg,import_batch_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'PLANNED','TO BE ASSIGNED','To be assigned','',$9,$10) RETURNING id", [rds.rows[0].id, supplier.id, first.deliveryDate, timeSlot, first.deliveryTime, first.endTime || null, first.endTime ? durationMinutes(first.deliveryTime, first.endTime) : null, first.shift, weightKg, batchId]);
      const shipmentId = Number(insertedShipment.rows[0].id);
      const shipmentNumber = nextCode("SHP", shipmentId, new Date(`${first.deliveryDate}T12:00:00`));
      const bookingReceipt = nextCode("BKG", shipmentId);
      await client.query("UPDATE shipments SET shipment_number=$1,booking_receipt=$2 WHERE id=$3", [shipmentNumber, bookingReceipt, shipmentId]);
      let groupImported = 0;
      for (const row of rows) {
        const insertedItem = await client.query("INSERT INTO shipment_items (shipment_id,po_number,material_code,material_name,quantity,uom,pallet_count,source_key,source_sheet,source_row,source_file,delivery_site,delivery_week,po_balance,po_quantity,still_to_be_delivered,remarks) VALUES ($1,$2,$3,$4,$5,$6,0,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) ON CONFLICT (source_key) WHERE source_key IS NOT NULL DO NOTHING RETURNING id", [shipmentId, row.poNumber || null, row.materialCode, row.materialName, row.quantity, row.uom, row.sourceKey, row.sheet, row.sourceRow, preview.fileName, row.site || null, row.week || null, row.poBalance, row.poQuantity, row.stillToBeDelivered, row.remarks || null]);
        if (insertedItem.rowCount) { importedRows += 1; groupImported += 1; }
      }
      if (!groupImported) {
        await client.query("DELETE FROM shipments WHERE id=$1", [shipmentId]);
        await client.query("DELETE FROM rds_requests WHERE id=$1", [rds.rows[0].id]);
        await client.query("DELETE FROM dpps WHERE id=$1", [dpp.rows[0].id]);
        continue;
      }
      deliveryCount += 1;
      await logEvent(client, shipmentId, request.user.id, "EXCEL_IMPORTED", `${shipmentNumber} created from ${preview.fileName}`, { batchId, sourceSheets: [...new Set(rows.map(row => row.sheet))], rowCount: groupImported });
    }
    await client.query("UPDATE import_batches SET status='IMPORTED',imported_rows=$1,skipped_rows=$2,delivery_count=$3,completed_at=NOW() WHERE id=$4", [importedRows, preview.summary.totalRows - importedRows, deliveryCount, batchId]);
    await logEvent(client, null, request.user.id, "EXCEL_IMPORT_COMPLETED", `${deliveryCount} deliveries and ${importedRows} material rows imported from ${preview.fileName}`, { batchId });
    await client.query("COMMIT");
    importPreviews.delete(String(request.body.previewToken));
    response.status(201).json({ batchId, importedRows, skippedRows: preview.summary.totalRows - importedRows, deliveryCount });
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
}));

app.post("/api/materials", auth, allow("admin"), asyncRoute(async (request, response) => {
  const { code, name, type, uom, shelfLifeDays, unitsPerPallet, storageZone } = request.body || {};
  if (!String(code || "").trim() || !String(name || "").trim()) return response.status(400).json({ message: "Material code and name are required" });
  const result = await pool.query("INSERT INTO materials (code,name,type,uom,shelf_life_days,units_per_pallet,storage_zone) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id", [String(code).trim(), String(name).trim(), String(type || "ROH"), String(uom || "KG"), Number(shelfLifeDays || 0), Number(unitsPerPallet || 0), String(storageZone || "")]);
  response.status(201).json({ id: result.rows[0].id });
}));

app.post("/api/users", auth, allow("admin"), asyncRoute(async (request, response) => {
  const { name, username, password, role, supplierId } = request.body || {};
  const roles = ["admin", "planner", "supplier", "driver", "security", "warehouse"];
  if (!String(name || "").trim() || !String(username || "").trim() || String(password || "").length < 8 || !roles.includes(role)) return response.status(400).json({ message: "Name, username, valid role, and an 8-character password are required" });
  if (role === "supplier" && !supplierId) return response.status(400).json({ message: "Supplier accounts require a supplier ID" });
  const result = await pool.query("INSERT INTO users (name,username,password_hash,role,supplier_id) VALUES ($1,$2,$3,$4,$5) RETURNING id", [String(name).trim(), String(username).trim().toLowerCase(), await bcrypt.hash(String(password), 10), role, role === "supplier" ? Number(supplierId) : null]);
  response.status(201).json({ id: result.rows[0].id });
}));

app.patch("/api/settings", auth, allow("admin"), asyncRoute(async (request, response) => {
  const value = { flexibleScheduling: true, dockCount: Number(request.body.dockCount), graceMinutes: Number(request.body.graceMinutes), siteName: String(request.body.siteName) };
  await pool.query("INSERT INTO app_settings (key,value,updated_at) VALUES ('schedule',$1,NOW()) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value,updated_at=NOW()", [value]);
  response.json({ ok: true });
}));

app.post("/api/shipment-items/:id/documents", auth, allow("admin", "supplier"), upload.single("file"), asyncRoute(async (request, response) => {
  if (!request.file) return response.status(400).json({ message: "Choose a PDF or image up to 15 MB" });
  const documentType = String(request.body.documentType || "").toUpperCase();
  if (!['DN','COA'].includes(documentType)) return response.status(400).json({ message: "Document type must be DN or COA" });
  const item = (await pool.query("SELECT si.*,s.supplier_id FROM shipment_items si JOIN shipments s ON s.id=si.shipment_id WHERE si.id=$1", [request.params.id])).rows[0];
  if (!item || (request.user.role === "supplier" && item.supplier_id !== request.user.supplierId)) return response.status(403).json({ message: "Shipment item not available" });
  const result = await pool.query("INSERT INTO shipment_documents (shipment_item_id,document_type,original_name,stored_name,mime_type,uploaded_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id", [item.id, documentType, request.file.originalname, request.file.filename, request.file.mimetype, request.user.id]);
  response.status(201).json({ id: result.rows[0].id, fileName: request.file.originalname });
}));

app.get("/api/shipments/:id/qr.svg", asyncRoute(async (request, response) => {
  const shipment = (await pool.query("SELECT shipment_number FROM shipments WHERE id=$1", [request.params.id])).rows[0];
  if (!shipment) return response.status(404).end();
  response.type("image/svg+xml").send(await QRCode.toString(`${APP_ORIGIN}/?shipment=${encodeURIComponent(shipment.shipment_number)}`, { type: "svg", margin: 1, width: 240, color: { dark: "#0b1e38", light: "#ffffff" } }));
}));

app.use((error, _request, response, _next) => {
  void _next;
  console.error(error);
  if (error.code === "LIMIT_FILE_SIZE") return response.status(413).json({ message: "File exceeds the 15 MB limit" });
  if (error.code === "23505") return response.status(409).json({ message: "A record with this number already exists" });
  response.status(500).json({ message: "The server could not complete this request" });
});

await initializeDatabase();
app.listen(PORT, "0.0.0.0", () => console.log(`DockFlow API listening on ${PORT}`));
