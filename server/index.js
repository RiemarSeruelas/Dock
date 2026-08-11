import bcrypt from "bcryptjs";
import cors from "cors";
import express from "express";
import helmet from "helmet";
import jwt from "jsonwebtoken";
import multer from "multer";
import pg from "pg";
import QRCode from "qrcode";
import { mkdir, readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";

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
  const suppliers = [
    ["V9001", "Pacific Oils Inc.", "Paolo Garcia", "paolo@example.local"],
    ["V9002", "Cavite Packaging", "Mia Torres", "mia@example.local"],
    ["V9003", "Luzon Ingredients", "Nico Ramos", "nico@example.local"],
    ["V9004", "Prime Cartons Corp.", "Celine Ong", "celine@example.local"],
    ["V9005", "Southline Trading", "Ben Flores", "ben@example.local"],
  ];
  for (const row of suppliers) await pool.query("INSERT INTO suppliers (vendor_code,name,contact_name,contact_email) VALUES ($1,$2,$3,$4) ON CONFLICT (vendor_code) DO NOTHING", row);
  const supplierId = (await pool.query("SELECT id FROM suppliers WHERE vendor_code='V9001'")).rows[0].id;
  const accounts = [
    ["System Administrator", "admin", "admin123", "admin", null],
    ["Andrea Lim", "planner", "planner123", "planner", null],
    ["Paolo Garcia", "supplier", "supplier123", "supplier", supplierId],
    ["Marco Reyes", "driver", "driver123", "driver", null],
    ["Ana Mendoza", "security", "security123", "security", null],
    ["Leo Villanueva", "warehouse", "warehouse123", "warehouse", null],
  ];
  for (const account of accounts) {
    const hash = await bcrypt.hash(account[2], 10);
    await pool.query("INSERT INTO users (name,username,password_hash,role,supplier_id) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (username) DO NOTHING", [account[0], account[1], hash, account[3], account[4]]);
  }
  const materials = [
    ["6271711", "Refined soybean oil", "ROH", "KG", 365, 4, "Zone A"],
    ["6271722", "Modified starch", "ROH", "KG", 540, 40, "Zone B"],
    ["6271733", "Iodized salt", "ROH", "KG", 720, 50, "Zone B"],
    ["6271744", "HDPE bottles 500 mL", "PACK", "PC", 0, 2400, "Zone C"],
    ["6271755", "Printed carton cases", "PACK", "PC", 0, 800, "Zone C"],
  ];
  for (const material of materials) await pool.query("INSERT INTO materials (code,name,type,uom,shelf_life_days,units_per_pallet,storage_zone) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (code) DO NOTHING", material);
  await pool.query("INSERT INTO app_settings (key,value) VALUES ('schedule',$1) ON CONFLICT (key) DO NOTHING", [{ slotMinutes: 90, dockCount: 3, graceMinutes: 30, siteName: "Cavite Foods Receiving" }]);
  const count = Number((await pool.query("SELECT COUNT(*) AS count FROM shipments")).rows[0].count);
  if (count > 0) return;

  const adminId = (await pool.query("SELECT id FROM users WHERE username='admin'")).rows[0].id;
  const plannerId = (await pool.query("SELECT id FROM users WHERE username='planner'")).rows[0].id;
  const supplierRows = (await pool.query("SELECT id,name,vendor_code FROM suppliers ORDER BY id")).rows;
  const today = new Date().toISOString().slice(0, 10);
  const statuses = ["UNLOADING", "AT_DOCK", "VERIFIED", "ARRIVED", "IN_TRANSIT", "PLANNED", "PLANNED"];
  const slots = ["06:00 - 07:30", "06:00 - 07:30", "07:30 - 09:00", "09:00 - 10:30", "10:30 - 12:00", "12:00 - 13:30", "13:30 - 15:00"];
  const drivers = ["Marco Reyes", "Joel Santos", "Alvin Cruz", "Ramon Dela Peña"];
  for (let index = 0; index < statuses.length; index += 1) {
    const supplier = supplierRows[index % supplierRows.length];
    const dpp = await pool.query("INSERT INTO dpps (dpp_number,supplier_id,requested_date,arrival_shift,notes,items,created_by) VALUES ($1,$2,$3,'Morning','Seed delivery',$4,$5) RETURNING id", [`DPP-${today.replaceAll("-", "")}-${index + 1}`, supplier.id, today, JSON.stringify([{ poNumber: `45160${17364 + index}`, materialCode: `62717${11 + index}`, materialName: materials[index % materials.length][1], quantity: 4000 + index * 600, uom: "KG", palletCount: 4 + index % 4 }]), plannerId]);
    const rds = await pool.query("INSERT INTO rds_requests (rds_number,dpp_id,status,confirmed_by,confirmed_at) VALUES ($1,$2,'SCHEDULED',$3,NOW()) RETURNING id", [`RDS-${today.replaceAll("-", "")}-${String(index + 1).padStart(3, "0")}`, dpp.rows[0].id, adminId]);
    const shipment = await pool.query("INSERT INTO shipments (shipment_number,booking_receipt,rds_id,supplier_id,scheduled_date,time_slot,arrival_shift,status,truck_plate,driver_name,driver_phone,material_weight_kg,dock,started_at,arrived_at,verified_at,unloading_started_at) VALUES ($1,$2,$3,$4,$5,$6,'Morning',$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id", [nextCode("SHP", index + 1), nextCode("BKG", index + 1), rds.rows[0].id, supplier.id, today, slots[index], statuses[index], `N${index % 2 ? "AJ" : "BK"} ${1200 + index * 83}`, drivers[index % drivers.length], `0917${String(1000000 + index * 1109)}`, 8000 + index * 850, index < 2 ? `Dock ${index + 1}` : null, statuses[index] !== "PLANNED" ? new Date() : null, ["ARRIVED","VERIFIED","AT_DOCK","UNLOADING"].includes(statuses[index]) ? new Date() : null, ["VERIFIED","AT_DOCK","UNLOADING"].includes(statuses[index]) ? new Date() : null, statuses[index] === "UNLOADING" ? new Date() : null]);
    const line = (await pool.query("SELECT items FROM dpps WHERE id=$1", [dpp.rows[0].id])).rows[0].items[0];
    await pool.query("INSERT INTO shipment_items (shipment_id,po_number,material_code,material_name,quantity,uom,pallet_count,dn_number,batch_number) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)", [shipment.rows[0].id, line.poNumber, line.materialCode, line.materialName, line.quantity, line.uom, line.palletCount, `DN-${202600 + index}`, `B26-${index + 1}A`]);
    await logEvent(pool, shipment.rows[0].id, adminId, "SEEDED", `${nextCode("SHP", index + 1)} added to the receiving schedule`);
  }
  const pendingSupplier = supplierRows[0];
  const pendingDpp = await pool.query("INSERT INTO dpps (dpp_number,supplier_id,requested_date,arrival_shift,notes,items,created_by) VALUES ($1,$2,CURRENT_DATE + 2,'Morning','Priority raw material',$3,$4) RETURNING id", [`DPP-${today.replaceAll("-", "")}-104`, pendingSupplier.id, JSON.stringify([{ poNumber: "4516017364", materialCode: "6271711", materialName: "Refined soybean oil", quantity: 12000, uom: "KG", palletCount: 12 }]), plannerId]);
  await pool.query("INSERT INTO rds_requests (rds_number,dpp_id,status) VALUES ($1,$2,'PENDING')", [`RDS-${today.replaceAll("-", "")}-014`, pendingDpp.rows[0].id]);
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
  const [shipmentsResult, itemsResult, palletResult, documentsResult, rdsResult, materialsResult, usersResult, eventsResult, settingsResult] = await Promise.all([
    pool.query("SELECT s.*, sp.name AS supplier, sp.vendor_code FROM shipments s JOIN suppliers sp ON sp.id=s.supplier_id ORDER BY s.scheduled_date, s.time_slot, s.id"),
    pool.query("SELECT * FROM shipment_items ORDER BY id"),
    pool.query("SELECT shipment_id, COUNT(*)::int AS scanned FROM pallet_scans GROUP BY shipment_id"),
    pool.query("SELECT d.*, si.shipment_id FROM shipment_documents d JOIN shipment_items si ON si.id=d.shipment_item_id"),
    pool.query("SELECT r.id,r.rds_number,r.status,d.dpp_number,d.requested_date,d.arrival_shift,d.notes,sp.name AS supplier,sp.id AS supplier_id FROM rds_requests r JOIN dpps d ON d.id=r.dpp_id JOIN suppliers sp ON sp.id=d.supplier_id ORDER BY r.created_at DESC"),
    pool.query("SELECT * FROM materials WHERE active=TRUE ORDER BY name"),
    pool.query("SELECT id,name,username,role,supplier_id FROM users WHERE active=TRUE ORDER BY name"),
    pool.query("SELECT e.id,e.created_at,e.action,e.detail,s.shipment_number,u.name AS actor FROM shipment_events e LEFT JOIN shipments s ON s.id=e.shipment_id LEFT JOIN users u ON u.id=e.actor_id ORDER BY e.created_at DESC LIMIT 50"),
    pool.query("SELECT value FROM app_settings WHERE key='schedule'"),
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
    shipments: shipmentRows.map(row => ({ id: row.id, shipmentNumber: row.shipment_number, bookingReceipt: row.booking_receipt, supplier: row.supplier, vendorCode: row.vendor_code, scheduledDate: row.scheduled_date.toISOString().slice(0,10), timeSlot: row.time_slot, shift: row.arrival_shift, status: row.status, truckPlate: row.truck_plate, driverName: row.driver_name, driverPhone: row.driver_phone, materialWeightKg: Number(row.material_weight_kg), dock: row.dock, arrivalTime: row.arrived_at, startedAt: row.started_at, completedAt: row.completed_at, rejectionReason: row.rejection_reason, palletsScanned: palletMap.get(row.id) || 0, palletsTotal: items.filter(item => item.shipment_id === row.id).reduce((sum, item) => sum + item.pallet_count, 0), items: items.filter(item => item.shipment_id === row.id).map(item => ({ id: item.id, poNumber: item.po_number, materialCode: item.material_code, materialName: item.material_name, quantity: Number(item.quantity), uom: item.uom, palletCount: item.pallet_count, dnNumber: item.dn_number, batchNumber: item.batch_number, productionDate: item.production_date?.toISOString?.().slice(0,10) || item.production_date, expiryDate: item.expiry_date?.toISOString?.().slice(0,10) || item.expiry_date, dnFileName: documents.find(doc => doc.shipment_item_id === item.id && doc.document_type === "DN")?.original_name, coaFileName: documents.find(doc => doc.shipment_item_id === item.id && doc.document_type === "COA")?.original_name })) })),
    rdsRequests: rdsRows.map(row => ({ id: row.id, rdsNumber: row.rds_number, dppNumber: row.dpp_number, supplier: row.supplier, requestedDate: row.requested_date.toISOString().slice(0,10), arrivalShift: row.arrival_shift, status: row.status, notes: row.notes })),
    materials: materialsResult.rows.map(row => ({ id: row.id, code: row.code, name: row.name, type: row.type, uom: row.uom, shelfLifeDays: row.shelf_life_days, unitsPerPallet: Number(row.units_per_pallet), storageZone: row.storage_zone })),
    users: usersResult.rows.map(row => ({ id: row.id, name: row.name, username: row.username, role: row.role, supplierId: row.supplier_id })),
    audit: eventsResult.rows.map(row => ({ id: Number(row.id), at: row.created_at, actor: row.actor || "System", action: row.action, shipmentNumber: row.shipment_number, detail: row.detail })),
    settings: settingsResult.rows[0]?.value || { slotMinutes: 90, dockCount: 3, graceMinutes: 30, siteName: "Receiving" },
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
    const startHour = Number(String(request.body.timeSlot).slice(0,2));
    const allowed = rds.arrival_shift === "Morning" ? startHour >= 6 && startHour < 14 : rds.arrival_shift === "Afternoon" ? startHour >= 14 && startHour < 22 : startHour >= 22 || startHour < 6;
    if (!allowed) { await client.query("ROLLBACK"); return response.status(400).json({ message: "Time slot is outside the confirmed arrival shift" }); }
    const settings = (await client.query("SELECT value FROM app_settings WHERE key='schedule'")).rows[0]?.value || { dockCount: 3 };
    const occupied = Number((await client.query("SELECT COUNT(*) AS count FROM shipments WHERE scheduled_date=$1 AND time_slot=$2 AND status<>'REJECTED'", [request.body.scheduledDate, request.body.timeSlot])).rows[0].count);
    if (occupied >= settings.dockCount) { await client.query("ROLLBACK"); return response.status(409).json({ message: "This time slot is already full" }); }
    const id = Number((await client.query("SELECT COALESCE(MAX(id),0)+1 AS id FROM shipments")).rows[0].id);
    const shipmentNumber = nextCode("SHP", id, new Date(`${request.body.scheduledDate}T12:00:00`));
    const bookingReceipt = nextCode("BKG", id);
    const shipment = await client.query("INSERT INTO shipments (shipment_number,booking_receipt,rds_id,supplier_id,scheduled_date,time_slot,arrival_shift,truck_plate,driver_name,driver_phone,material_weight_kg) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id", [shipmentNumber, bookingReceipt, rds.id, rds.supplier_id, request.body.scheduledDate, request.body.timeSlot, rds.arrival_shift, request.body.truckPlate, request.body.driverName, request.body.driverPhone, request.body.materialWeightKg]);
    const itemIds = [];
    for (const item of rds.items || []) { const inserted = await client.query("INSERT INTO shipment_items (shipment_id,po_number,material_code,material_name,quantity,uom,pallet_count,dn_number,batch_number) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id", [shipment.rows[0].id, item.poNumber, item.materialCode, item.materialName, item.quantity, item.uom, item.palletCount, request.body.dnNumber || null, request.body.batchNumber || null]); itemIds.push(inserted.rows[0].id); }
    await client.query("UPDATE rds_requests SET status='SCHEDULED' WHERE id=$1", [rds.id]);
    await logEvent(client, shipment.rows[0].id, request.user.id, "SHIPMENT_PLANNED", `${shipmentNumber} booked for ${request.body.timeSlot}`);
    await client.query("COMMIT");
    response.status(201).json({ id: shipment.rows[0].id, shipmentNumber, bookingReceipt, itemIds });
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
  const settings = (await pool.query("SELECT value FROM app_settings WHERE key='schedule'")).rows[0]?.value || { dockCount: 3 };
  const occupied = Number((await pool.query("SELECT COUNT(*) AS count FROM shipments WHERE scheduled_date=$1 AND time_slot=$2 AND id<>$3 AND status<>'REJECTED'", [request.body.scheduledDate, request.body.timeSlot, request.params.id])).rows[0].count);
  if (occupied >= settings.dockCount) return response.status(409).json({ message: "Target slot is full" });
  const result = await pool.query("UPDATE shipments SET scheduled_date=$1,time_slot=$2,dock=NULL,updated_at=NOW() WHERE id=$3 RETURNING shipment_number", [request.body.scheduledDate, request.body.timeSlot, request.params.id]);
  if (!result.rowCount) return response.status(404).json({ message: "Shipment not found" });
  await logEvent(pool, Number(request.params.id), request.user.id, "RESCHEDULED", `${result.rows[0].shipment_number} moved to ${request.body.scheduledDate} ${request.body.timeSlot}`);
  response.json({ ok: true });
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
  const value = { slotMinutes: Number(request.body.slotMinutes), dockCount: Number(request.body.dockCount), graceMinutes: Number(request.body.graceMinutes), siteName: String(request.body.siteName) };
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
