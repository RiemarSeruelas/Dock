import bcrypt from "bcryptjs";
import cors from "cors";
import express from "express";
import helmet from "helmet";
import jwt from "jsonwebtoken";
import multer from "multer";
import QRCode from "qrcode";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { parseDeliveryWorkbook } from "./excel-import.js";
import { JsonStore } from "./json-store.js";

const PORT = Number(process.env.API_PORT || 3001);
const JWT_SECRET = process.env.JWT_SECRET || "change-this-secret-before-production";
const UPLOAD_DIR = resolve(process.env.UPLOAD_DIR || "./uploads");
const DATA_FILE = resolve(process.env.DATA_FILE || "./data/trial-data.json");
const APP_ORIGIN = process.env.APP_ORIGIN || "http://localhost:5059";
const TIME_ZONE = process.env.TZ || "Asia/Manila";
const app = express();
const importPreviews = new Map();

const localDate = (days = 0) => {
  const date = new Date(Date.now() + days * 86400000);
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
};
const validDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(String(value || ""));
const validTime = (value) => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(value || ""));
const toMinutes = (value) => {
  const [hour, minute] = String(value || "00:00").split(":").map(Number);
  return hour * 60 + minute;
};
const toTime = (minutes) => `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
const nextId = (rows) => Math.max(0, ...rows.map((row) => Number(row.id) || 0)) + 1;
const nextCode = (prefix, id, date = localDate()) => `${prefix}-${String(date).replaceAll("-", "")}-${String(id).padStart(3, "0")}`;
const scheduleLabel = (start, end) => end ? `${start} - ${end}` : start;
const durationMinutes = (start, end) => {
  if (!start || !end) return null;
  const [startHour, startMinute] = start.split(":").map(Number);
  const [endHour, endMinute] = end.split(":").map(Number);
  let duration = endHour * 60 + endMinute - (startHour * 60 + startMinute);
  if (duration <= 0) duration += 1440;
  return duration;
};
const defaultAvailabilityForDates = (dates) => dates.flatMap((date, index) => [
  { id: index * 2 + 1, date, startTime: "07:00", endTime: "12:00", label: "Open receiving window" },
  { id: index * 2 + 2, date, startTime: "13:00", endTime: "20:00", label: "Open receiving window" },
]);
const matchingAvailability = (state, date, startTime, endTime) => (state.settings.availableSlots || []).find((slot) =>
  slot.date === date && startTime >= slot.startTime && startTime < slot.endTime && (!endTime || endTime <= slot.endTime)
);
const syncAvailableDates = (state) => {
  state.settings.availableDates = [...new Set((state.settings.availableSlots || []).map((slot) => slot.date))].sort();
};
const ensureAvailabilityForTime = (state, date, time) => {
  state.settings.availableSlots ||= [];
  if (matchingAvailability(state, date, time, null)) return;
  const startMinutes = Math.max(0, toMinutes(time) - 30);
  const endMinutes = Math.min(1439, toMinutes(time) + 90);
  state.settings.availableSlots.push({ id: nextId(state.settings.availableSlots), date, startTime: toTime(startMinutes), endTime: toTime(endMinutes), label: "Imported delivery window" });
  syncAvailableDates(state);
};
const addAudit = (state, actor, action, detail, shipmentNumber) => state.audit.unshift({
  id: nextId(state.audit),
  at: new Date().toISOString(),
  actor: actor?.name || "System",
  action,
  shipmentNumber: shipmentNumber || undefined,
  detail,
});
const publicUser = (user) => ({ id: user.id, name: user.name, username: user.username, role: user.role, supplierId: user.supplierId ?? null });
const ensureSupplier = (state, name) => {
  const supplierName = String(name || "").trim() || "Supplier to assign";
  let supplier = state.suppliers.find((row) => row.name.toLowerCase() === supplierName.toLowerCase());
  if (!supplier) {
    supplier = { id: nextId(state.suppliers), vendorCode: `TRIAL-${String(nextId(state.suppliers)).padStart(3, "0")}`, name: supplierName };
    state.suppliers.push(supplier);
  }
  return supplier;
};
const makeItem = (id, data) => ({
  id,
  poNumber: String(data.poNumber || ""),
  materialCode: String(data.materialCode || `UNSPECIFIED-${id}`),
  materialName: String(data.materialName || "Material to review"),
  quantity: Number(data.quantity || 0),
  uom: String(data.uom || "N/A"),
  palletCount: Number(data.palletCount || 0),
  dnNumber: String(data.dnNumber || ""),
  batchNumber: String(data.batchNumber || ""),
  sourceSheet: data.sourceSheet || null,
  sourceRow: data.sourceRow || null,
  sourceFile: data.sourceFile || null,
  deliverySite: data.deliverySite || null,
  deliveryWeek: data.deliveryWeek || null,
  poBalance: data.poBalance ?? null,
  poQuantity: data.poQuantity ?? null,
  stillToBeDelivered: data.stillToBeDelivered ?? null,
  remarks: data.remarks || null,
});

async function createInitialState() {
  const accountRows = [
    ["System Administrator", "admin", "admin123", "admin", null],
    ["Planner User", "planner", "planner123", "planner", null],
    ["Supplier User", "supplier", "supplier123", "supplier", 1],
    ["Driver User", "driver", "driver123", "driver", null],
    ["Security User", "security", "security123", "security", null],
    ["Warehouse User", "warehouse", "warehouse123", "warehouse", null],
  ];
  const users = await Promise.all(accountRows.map(async (row, index) => ({
    id: index + 1,
    name: row[0],
    username: row[1],
    passwordHash: await bcrypt.hash(row[2], 10),
    role: row[3],
    supplierId: row[4],
  })));
  const dates = [localDate(), localDate(1), localDate(2), localDate(3), localDate(5)];
  const materials = [
    { id: 1, code: "65013575", name: "Aspartame Powder", type: "RM", uom: "KG", shelfLifeDays: 730, unitsPerPallet: 500, storageZone: "Dry store" },
    { id: 2, code: "65013507", name: "Mustard Pure", type: "RM", uom: "KG", shelfLifeDays: 365, unitsPerPallet: 1044, storageZone: "Dry store" },
    { id: 3, code: "65013743", name: "Delta Cap 470/700/940 ML", type: "PM", uom: "PC", shelfLifeDays: 0, unitsPerPallet: 18480, storageZone: "Packaging" },
    { id: 4, code: "65013333", name: "Corn Starch", type: "RM", uom: "KG", shelfLifeDays: 730, unitsPerPallet: 600, storageZone: "Dry store" },
  ];
  const shipments = [
    { id: 1, supplier: "Trial Ingredients Supplier", vendorCode: "TRIAL-001", scheduledDate: dates[0], scheduledTime: "08:20", scheduledEndTime: null, status: "PLANNED", truckPlate: "ABC 1234", driverName: "Driver User", driverPhone: "09170000001", materialWeightKg: 300, dock: null, items: [makeItem(1, { poNumber: "450000101", materialCode: materials[0].code, materialName: materials[0].name, quantity: 300, uom: "KG", palletCount: 1 })], palletsScanned: 0 },
    { id: 2, supplier: "Trial Packaging Supplier", vendorCode: "TRIAL-002", scheduledDate: dates[0], scheduledTime: "10:45", scheduledEndTime: "11:30", status: "IN_TRANSIT", truckPlate: "DEF 5678", driverName: "Driver User", driverPhone: "09170000002", materialWeightKg: 0, dock: null, items: [makeItem(2, { poNumber: "450000102", materialCode: materials[2].code, materialName: materials[2].name, quantity: 18480, uom: "PC", palletCount: 2 })], palletsScanned: 0 },
    { id: 3, supplier: "Trial Ingredients Supplier", vendorCode: "TRIAL-001", scheduledDate: dates[1], scheduledTime: "13:10", scheduledEndTime: null, status: "ARRIVED", truckPlate: "GHI 9012", driverName: "Alex Santos", driverPhone: "09170000003", materialWeightKg: 1044, dock: null, items: [makeItem(3, { poNumber: "450000103", materialCode: materials[1].code, materialName: materials[1].name, quantity: 1044, uom: "KG", palletCount: 2 })], palletsScanned: 0 },
    { id: 4, supplier: "Trial Starch Supplier", vendorCode: "TRIAL-003", scheduledDate: dates[2], scheduledTime: "15:35", scheduledEndTime: "16:30", status: "AT_DOCK", truckPlate: "JKL 3456", driverName: "Ben Cruz", driverPhone: "09170000004", materialWeightKg: 600, dock: "Dock 1", items: [makeItem(4, { poNumber: "450000104", materialCode: materials[3].code, materialName: materials[3].name, quantity: 600, uom: "KG", palletCount: 2 })], palletsScanned: 0 },
    { id: 5, supplier: "Trial Packaging Supplier", vendorCode: "TRIAL-002", scheduledDate: dates[3], scheduledTime: "19:25", scheduledEndTime: null, status: "UNLOADING", truckPlate: "MNO 7890", driverName: "Carlo Reyes", driverPhone: "09170000005", materialWeightKg: 0, dock: "Dock 2", items: [makeItem(5, { poNumber: "450000105", materialCode: materials[2].code, materialName: materials[2].name, quantity: 9200, uom: "PC", palletCount: 3 })], palletsScanned: 1 },
    { id: 6, supplier: "Trial Ingredients Supplier", vendorCode: "TRIAL-001", scheduledDate: dates[4], scheduledTime: "07:05", scheduledEndTime: null, status: "RECEIVED", truckPlate: "PQR 1122", driverName: "Dana Flores", driverPhone: "09170000006", materialWeightKg: 500, dock: "Dock 1", items: [makeItem(6, { poNumber: "450000106", materialCode: materials[0].code, materialName: materials[0].name, quantity: 500, uom: "KG", palletCount: 1 })], palletsScanned: 1 },
  ].map((shipment) => ({
    ...shipment,
    shipmentNumber: nextCode("SHP", shipment.id, shipment.scheduledDate),
    bookingReceipt: nextCode("BKG", shipment.id, shipment.scheduledDate),
    expectedDurationMinutes: shipment.scheduledEndTime ? durationMinutes(shipment.scheduledTime, shipment.scheduledEndTime) : null,
    timeSlot: scheduleLabel(shipment.scheduledTime, shipment.scheduledEndTime),
    shift: "Flexible date",
    bookingStatus: "APPROVED",
    arrivalTime: null,
    startedAt: shipment.status === "IN_TRANSIT" ? new Date().toISOString() : null,
    completedAt: shipment.status === "RECEIVED" ? new Date().toISOString() : null,
    rejectionReason: null,
    importBatchId: null,
    importSource: "Trial placeholder",
    palletsTotal: shipment.items.reduce((sum, item) => sum + item.palletCount, 0),
    palletIds: [],
  }));
  return {
    version: 1,
    settings: { flexibleScheduling: true, dockCount: 2, graceMinutes: 30, siteName: "Cavite Foods Receiving · Trial", availableDates: dates, availableSlots: defaultAvailabilityForDates(dates) },
    users,
    suppliers: [
      { id: 1, vendorCode: "TRIAL-001", name: "Trial Ingredients Supplier" },
      { id: 2, vendorCode: "TRIAL-002", name: "Trial Packaging Supplier" },
      { id: 3, vendorCode: "TRIAL-003", name: "Trial Starch Supplier" },
    ],
    materials,
    shipments,
    rdsRequests: [
      { id: 1, rdsNumber: "RDS-TRIAL-001", dppNumber: "DPP-TRIAL-001", supplier: "Trial Packaging Supplier", supplierId: 2, requestedDate: dates[2], requestedTime: "15:00", availabilitySlotId: 6, status: "PENDING", notes: "Placeholder request for testing", items: [makeItem(7, { poNumber: "450000201", materialCode: materials[2].code, materialName: materials[2].name, quantity: 12000, uom: "PC", palletCount: 2 })] },
      { id: 2, rdsNumber: "RDS-TRIAL-002", dppNumber: "DPP-TRIAL-002", supplier: "Trial Ingredients Supplier", supplierId: 1, requestedDate: dates[3], requestedTime: "16:00", availabilitySlotId: 8, status: "CONFIRMED", notes: "Ready to schedule at any exact time", items: [makeItem(8, { poNumber: "450000202", materialCode: materials[1].code, materialName: materials[1].name, quantity: 500, uom: "KG", palletCount: 1 })] },
    ],
    audit: [
      { id: 3, at: new Date().toISOString(), actor: "Warehouse User", action: "UNLOADING", shipmentNumber: shipments[4].shipmentNumber, detail: `${shipments[4].shipmentNumber} started unloading at Dock 2` },
      { id: 2, at: new Date(Date.now() - 20 * 60000).toISOString(), actor: "Security User", action: "AT_DOCK", shipmentNumber: shipments[3].shipmentNumber, detail: `${shipments[3].shipmentNumber} directed to Dock 1` },
      { id: 1, at: new Date(Date.now() - 45 * 60000).toISOString(), actor: "Driver User", action: "IN_TRANSIT", shipmentNumber: shipments[1].shipmentNumber, detail: `${shipments[1].shipmentNumber} started the trip` },
    ],
    importBatches: [],
  };
}

const store = new JsonStore(DATA_FILE, createInitialState);
await mkdir(UPLOAD_DIR, { recursive: true });
await store.initialize();
await store.update(async (state) => {
  state.version = 3;
  state.settings ||= {};
  state.shipments = Array.isArray(state.shipments) ? state.shipments : [];
  state.rdsRequests = Array.isArray(state.rdsRequests) ? state.rdsRequests : [];
  state.suppliers = Array.isArray(state.suppliers) ? state.suppliers : [];
  state.materials = Array.isArray(state.materials) ? state.materials : [];
  state.audit = Array.isArray(state.audit) ? state.audit : [];
  state.importBatches = Array.isArray(state.importBatches) ? state.importBatches : [];
  state.users = Array.isArray(state.users) ? state.users : [];
  if (!state.users.length) state.users = (await createInitialState()).users;
  let nextUserId = nextId(state.users);
  for (const user of state.users) {
    user.id ||= nextUserId++;
    user.name = String(user.name || `User ${user.id}`);
    user.username = String(user.username || `user${user.id}`).toLowerCase();
    user.role = ["admin", "planner", "supplier", "driver", "security", "warehouse"].includes(user.role) ? user.role : "planner";
    if (!user.passwordHash && user.password) user.passwordHash = await bcrypt.hash(String(user.password), 10);
    if (!user.passwordHash) user.passwordHash = await bcrypt.hash(`${user.username}123`, 10);
    delete user.password;
  }
  state.settings.dockCount = 2;
  state.settings.flexibleScheduling = true;
  state.settings.graceMinutes = Number(state.settings.graceMinutes ?? 30);
  state.settings.siteName = String(state.settings.siteName || "Cavite Foods Receiving · Trial");
  if (!Array.isArray(state.settings.availableSlots)) state.settings.availableSlots = defaultAvailabilityForDates(state.settings.availableDates || []);
  state.settings.availableSlots = state.settings.availableSlots.filter((slot) => validDate(slot.date) && validTime(slot.startTime) && validTime(slot.endTime) && toMinutes(slot.endTime) > toMinutes(slot.startTime));
  let nextSlotId = nextId(state.settings.availableSlots);
  for (const slot of state.settings.availableSlots) { slot.id ||= nextSlotId++; slot.label = String(slot.label || "Open receiving window"); }
  let nextSupplierId = nextId(state.suppliers);
  for (const supplier of state.suppliers) { supplier.id ||= nextSupplierId++; supplier.name = String(supplier.name || "Supplier to assign"); supplier.vendorCode = String(supplier.vendorCode || `TRIAL-${String(supplier.id).padStart(3, "0")}`); }
  let nextMaterialId = nextId(state.materials);
  for (const material of state.materials) { material.id ||= nextMaterialId++; material.code = String(material.code || `UNSPECIFIED-${material.id}`); material.name = String(material.name || "Material to review"); material.type = String(material.type || "RM"); material.uom = String(material.uom || "N/A"); material.shelfLifeDays = Number(material.shelfLifeDays || 0); material.unitsPerPallet = Number(material.unitsPerPallet || 0); material.storageZone = String(material.storageZone || "To review"); }
  let nextShipmentId = nextId(state.shipments);
  let nextItemId = Math.max(0, ...state.shipments.flatMap((shipment) => shipment.items || []).map((item) => Number(item.id) || 0), ...state.rdsRequests.flatMap((rds) => rds.items || []).map((item) => Number(item.id) || 0)) + 1;
  for (const shipment of state.shipments) {
    shipment.id ||= nextShipmentId++;
    shipment.scheduledDate = validDate(shipment.scheduledDate) ? shipment.scheduledDate : localDate();
    shipment.scheduledTime = validTime(shipment.scheduledTime) ? shipment.scheduledTime : "12:00";
    shipment.scheduledEndTime = validTime(shipment.scheduledEndTime) ? shipment.scheduledEndTime : null;
    shipment.status = ["PLANNED", "IN_TRANSIT", "ARRIVED", "VERIFIED", "PARKING", "AT_DOCK", "UNLOADING", "RECEIVED", "REJECTED"].includes(shipment.status) ? shipment.status : "PLANNED";
    shipment.bookingStatus ||= shipment.status === "REJECTED" ? "REJECTED" : "APPROVED";
    shipment.shipmentNumber ||= nextCode("SHP", shipment.id, shipment.scheduledDate);
    shipment.bookingReceipt ||= nextCode("BKG", shipment.id, shipment.scheduledDate);
    shipment.supplier = String(shipment.supplier || "Supplier to assign");
    shipment.vendorCode = String(shipment.vendorCode || "TRIAL");
    shipment.truckPlate = String(shipment.truckPlate || "TO BE ASSIGNED");
    shipment.driverName = String(shipment.driverName || "To be assigned");
    shipment.driverPhone = String(shipment.driverPhone || "");
    shipment.items = Array.isArray(shipment.items) && shipment.items.length ? shipment.items.map((item) => makeItem(item.id || nextItemId++, item)) : [makeItem(nextItemId++, {})];
    shipment.materialWeightKg = Number(shipment.materialWeightKg || 0);
    shipment.palletsScanned = Number(shipment.palletsScanned || 0);
    shipment.palletsTotal = Number(shipment.palletsTotal ?? shipment.items.reduce((sum, item) => sum + item.palletCount, 0));
    shipment.timeSlot = scheduleLabel(shipment.scheduledTime, shipment.scheduledEndTime);
    shipment.shift = "Flexible date";
  }
  let nextRdsId = nextId(state.rdsRequests);
  for (const rds of state.rdsRequests) {
    rds.id ||= nextRdsId++;
    rds.requestedDate = validDate(rds.requestedDate) ? rds.requestedDate : localDate(1);
    rds.requestedTime = validTime(rds.requestedTime) ? rds.requestedTime : "12:00";
    rds.rdsNumber ||= nextCode("RDS", rds.id, rds.requestedDate);
    rds.dppNumber ||= nextCode("DPP", rds.id, rds.requestedDate);
    rds.supplier = String(rds.supplier || "Supplier to assign");
    rds.status = ["PENDING", "CONFIRMED", "SCHEDULED"].includes(rds.status) ? rds.status : "PENDING";
    rds.items = Array.isArray(rds.items) && rds.items.length ? rds.items.map((item) => makeItem(item.id || nextItemId++, item)) : [makeItem(nextItemId++, {})];
    rds.availabilitySlotId ||= matchingAvailability(state, rds.requestedDate, rds.requestedTime, null)?.id || null;
  }
  syncAvailableDates(state);
});

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

app.set("trust proxy", 1);
app.use(helmet({ crossOriginResourcePolicy: false }));
app.use(cors({ origin: APP_ORIGIN.split(",").map((value) => value.trim()), credentials: false }));
app.use(express.json({ limit: "2mb" }));

const asyncRoute = (handler) => (request, response, next) => Promise.resolve(handler(request, response, next)).catch(next);
const signToken = (user) => jwt.sign({ id: user.id, role: user.role, supplierId: user.supplierId, name: user.name }, JWT_SECRET, { expiresIn: "12h" });
const auth = (request, response, next) => {
  const token = request.headers.authorization?.replace(/^Bearer\s+/i, "");
  if (!token) return response.status(401).json({ message: "Authentication required" });
  try { request.user = jwt.verify(token, JWT_SECRET); next(); } catch { response.status(401).json({ message: "Session expired" }); }
};
const allow = (...roles) => (request, response, next) => roles.includes(request.user.role) ? next() : response.status(403).json({ message: "This action is not available for your role" });

app.get("/api/health", (_request, response) => response.json({ status: "ok", storage: "json" }));

app.post("/api/auth/login", asyncRoute(async (request, response) => {
  const state = await store.read();
  const user = state.users.find((row) => row.username.toLowerCase() === String(request.body?.username || "").toLowerCase());
  if (!user || !await bcrypt.compare(String(request.body?.password || ""), user.passwordHash)) return response.status(401).json({ message: "Incorrect username or password" });
  response.json({ token: signToken(user), user: publicUser(user) });
}));

app.get("/api/bootstrap", auth, asyncRoute(async (_request, response) => {
  const state = await store.read();
  response.json({
    shipments: [...state.shipments].sort((a, b) => `${a.scheduledDate}${a.scheduledTime}`.localeCompare(`${b.scheduledDate}${b.scheduledTime}`)),
    rdsRequests: state.rdsRequests,
    materials: state.materials,
    users: state.users.map(publicUser),
    audit: state.audit,
    importBatches: state.importBatches,
    settings: { ...state.settings, dockCount: 2 },
  });
}));

app.post("/api/rds", auth, allow("admin", "planner"), asyncRoute(async (request, response) => {
  const result = await store.update((state) => {
    const supplier = ensureSupplier(state, request.body?.supplier);
    const id = nextId(state.rdsRequests);
    const requestedDate = validDate(request.body?.requestedDate) ? request.body.requestedDate : state.settings.availableDates[0] || localDate(1);
    const requestedTime = validTime(String(request.body?.requestedTime || "").slice(0, 5)) ? String(request.body.requestedTime).slice(0, 5) : "";
    const selectedById = state.settings.availableSlots.find((slot) => slot.id === Number(request.body?.availabilitySlotId));
    const selectedSlot = selectedById?.date === requestedDate && requestedTime >= selectedById.startTime && requestedTime < selectedById.endTime ? selectedById : matchingAvailability(state, requestedDate, requestedTime, null);
    if (!selectedSlot || !requestedTime) return { unavailable: true };
    const itemId = Math.max(0, ...state.shipments.flatMap((shipment) => shipment.items).map((item) => item.id), ...state.rdsRequests.flatMap((rds) => rds.items || []).map((item) => item.id)) + 1;
    const rds = {
      id,
      rdsNumber: nextCode("RDS", id, requestedDate),
      dppNumber: String(request.body?.dppNumber || nextCode("DPP", id, requestedDate)),
      supplier: supplier.name,
      supplierId: supplier.id,
      requestedDate,
      requestedTime,
      availabilitySlotId: selectedSlot.id,
      status: "PENDING",
      notes: String(request.body?.notes || ""),
      items: [makeItem(itemId, request.body || {})],
    };
    state.rdsRequests.push(rds);
    addAudit(state, request.user, "RDS_CREATED", `${rds.rdsNumber} created for ${supplier.name} at ${requestedDate} ${requestedTime}`);
    return { id, rdsNumber: rds.rdsNumber };
  });
  if (result.unavailable) return response.status(400).json({ message: "Choose a booking time inside an available calendar window" });
  response.status(201).json(result);
}));

app.patch("/api/rds/:id/confirm", auth, allow("admin", "planner", "supplier"), asyncRoute(async (request, response) => {
  const result = await store.update((state) => {
    const rds = state.rdsRequests.find((row) => row.id === Number(request.params.id));
    if (!rds) return null;
    rds.status = "CONFIRMED";
    addAudit(state, request.user, "RDS_CONFIRMED", `${rds.rdsNumber} confirmed`);
    return { ok: true };
  });
  if (!result) return response.status(404).json({ message: "Delivery request not found" });
  response.json(result);
}));

app.post("/api/shipments", auth, allow("admin", "planner", "supplier"), asyncRoute(async (request, response) => {
  const scheduledDate = String(request.body?.scheduledDate || "");
  const scheduledTime = String(request.body?.scheduledTime || "").slice(0, 5);
  const scheduledEndTime = String(request.body?.scheduledEndTime || "").slice(0, 5) || null;
  if (!validDate(scheduledDate) || !validTime(scheduledTime) || (scheduledEndTime && !validTime(scheduledEndTime))) return response.status(400).json({ message: "Choose an available date and valid exact arrival time" });
  const result = await store.update((state) => {
    const rds = state.rdsRequests.find((row) => row.id === Number(request.body?.rdsId));
    if (!rds) return null;
    if (!matchingAvailability(state, scheduledDate, scheduledTime, scheduledEndTime)) return { unavailable: true };
    const concurrentBookingsAtTime = state.shipments.filter((row) => row.scheduledDate === scheduledDate && row.scheduledTime === scheduledTime && row.status !== "REJECTED" && row.bookingStatus !== "REJECTED").length;
    if (concurrentBookingsAtTime >= 2) return { full: true };
    const id = nextId(state.shipments);
    let itemId = Math.max(0, ...state.shipments.flatMap((shipment) => shipment.items).map((item) => item.id), ...state.rdsRequests.flatMap((row) => row.items || []).map((item) => item.id)) + 1;
    const items = (rds.items || []).map((item) => ({ ...item, id: itemId++ }));
    const shipmentNumber = nextCode("SHP", id, scheduledDate);
    const shipment = {
      id,
      shipmentNumber,
      bookingReceipt: nextCode("BKG", id, scheduledDate),
      supplier: rds.supplier,
      vendorCode: state.suppliers.find((row) => row.id === rds.supplierId)?.vendorCode || "TRIAL",
      scheduledDate,
      scheduledTime,
      scheduledEndTime,
      expectedDurationMinutes: scheduledEndTime ? durationMinutes(scheduledTime, scheduledEndTime) : null,
      timeSlot: scheduleLabel(scheduledTime, scheduledEndTime),
      shift: "Flexible date",
      bookingStatus: "PENDING_APPROVAL",
      status: "PLANNED",
      truckPlate: String(request.body?.truckPlate || "TO BE ASSIGNED"),
      driverName: String(request.body?.driverName || "To be assigned"),
      driverPhone: String(request.body?.driverPhone || ""),
      materialWeightKg: Number(request.body?.materialWeightKg || 0),
      dock: null,
      arrivalTime: null,
      startedAt: null,
      completedAt: null,
      rejectionReason: null,
      importBatchId: null,
      importSource: null,
      items,
      palletsScanned: 0,
      palletsTotal: items.reduce((sum, item) => sum + Number(item.palletCount || 0), 0),
      palletIds: [],
    };
    state.shipments.push(shipment);
    rds.status = "SCHEDULED";
    addAudit(state, request.user, "BOOKING_REQUESTED", `${shipmentNumber} requested ${scheduledDate} at ${scheduledTime}; awaiting planner approval`, shipmentNumber);
    return { id, shipmentNumber, bookingReceipt: shipment.bookingReceipt, itemIds: items.map((item) => item.id), concurrentBookingsAtTime };
  });
  if (!result) return response.status(404).json({ message: "Delivery request not found" });
  if (result.unavailable) return response.status(400).json({ message: "Choose a time inside one of the planner's available windows" });
  if (result.full) return response.status(409).json({ message: "Both docks are already reserved at that timestamp" });
  response.status(201).json(result);
}));

app.patch("/api/shipments/:id/booking-approval", auth, allow("admin", "planner"), asyncRoute(async (request, response) => {
  const decision = String(request.body?.decision || "").toUpperCase();
  if (!["APPROVE", "REJECT"].includes(decision)) return response.status(400).json({ message: "Choose approve or reject" });
  const result = await store.update((state) => {
    const shipment = state.shipments.find((row) => row.id === Number(request.params.id));
    if (!shipment) return null;
    if (decision === "APPROVE") {
      shipment.bookingStatus = "APPROVED";
      shipment.status = "PLANNED";
      shipment.rejectionReason = null;
      addAudit(state, request.user, "BOOKING_APPROVED", `${shipment.shipmentNumber} was approved for ${shipment.scheduledDate} at ${shipment.scheduledTime}`, shipment.shipmentNumber);
    } else {
      shipment.bookingStatus = "REJECTED";
      shipment.status = "REJECTED";
      shipment.rejectionReason = String(request.body?.reason || "Booking request rejected by planner");
      addAudit(state, request.user, "BOOKING_REJECTED", `${shipment.shipmentNumber} booking request was rejected`, shipment.shipmentNumber);
    }
    return { ok: true, bookingStatus: shipment.bookingStatus };
  });
  if (!result) return response.status(404).json({ message: "Shipment not found" });
  response.json(result);
}));

app.post("/api/availability", auth, allow("admin", "planner"), asyncRoute(async (request, response) => {
  const date = String(request.body?.date || "");
  const startTime = String(request.body?.startTime || "").slice(0, 5);
  const endTime = String(request.body?.endTime || "").slice(0, 5);
  if (!validDate(date) || !validTime(startTime) || !validTime(endTime) || toMinutes(endTime) <= toMinutes(startTime)) return response.status(400).json({ message: "Choose a valid date and an end time later than the start time" });
  const result = await store.update((state) => {
    state.settings.availableSlots ||= [];
    const duplicate = state.settings.availableSlots.find((slot) => slot.date === date && slot.startTime === startTime && slot.endTime === endTime);
    if (duplicate) return { duplicate: true, id: duplicate.id };
    const slot = { id: nextId(state.settings.availableSlots), date, startTime, endTime, label: String(request.body?.label || "Open receiving window").trim() || "Open receiving window" };
    state.settings.availableSlots.push(slot);
    state.settings.availableSlots.sort((a, b) => `${a.date}${a.startTime}`.localeCompare(`${b.date}${b.startTime}`));
    syncAvailableDates(state);
    addAudit(state, request.user, "AVAILABILITY_ADDED", `${date} from ${startTime} to ${endTime} opened for booking`);
    return { id: slot.id };
  });
  if (result.duplicate) return response.status(409).json({ message: "That exact availability window already exists" });
  response.status(201).json(result);
}));

app.patch("/api/availability/:id", auth, allow("admin", "planner"), asyncRoute(async (request, response) => {
  const date = String(request.body?.date || "");
  const startTime = String(request.body?.startTime || "").slice(0, 5);
  const endTime = String(request.body?.endTime || "").slice(0, 5);
  if (!validDate(date) || !validTime(startTime) || !validTime(endTime) || toMinutes(endTime) <= toMinutes(startTime)) return response.status(400).json({ message: "Choose a valid date and an end time later than the start time" });
  const result = await store.update((state) => {
    const slot = state.settings.availableSlots.find((row) => row.id === Number(request.params.id));
    if (!slot) return null;
    const duplicate = state.settings.availableSlots.find((row) => row.id !== slot.id && row.date === date && row.startTime === startTime && row.endTime === endTime);
    if (duplicate) return { duplicate: true };
    const previous = `${slot.date} ${slot.startTime}–${slot.endTime}`;
    slot.date = date;
    slot.startTime = startTime;
    slot.endTime = endTime;
    slot.label = String(request.body?.label || "Open receiving window").trim() || "Open receiving window";
    state.settings.availableSlots.sort((a, b) => `${a.date}${a.startTime}`.localeCompare(`${b.date}${b.startTime}`));
    syncAvailableDates(state);
    addAudit(state, request.user, "AVAILABILITY_UPDATED", `${previous} moved to ${date} ${startTime}–${endTime}`);
    return { ok: true, id: slot.id };
  });
  if (!result) return response.status(404).json({ message: "Availability window not found" });
  if (result.duplicate) return response.status(409).json({ message: "That exact availability window already exists" });
  response.json(result);
}));

app.delete("/api/availability/:id", auth, allow("admin", "planner"), asyncRoute(async (request, response) => {
  const result = await store.update((state) => {
    const index = (state.settings.availableSlots || []).findIndex((slot) => slot.id === Number(request.params.id));
    if (index < 0) return null;
    const [slot] = state.settings.availableSlots.splice(index, 1);
    syncAvailableDates(state);
    addAudit(state, request.user, "AVAILABILITY_REMOVED", `${slot.date} from ${slot.startTime} to ${slot.endTime} was closed`);
    return { ok: true };
  });
  if (!result) return response.status(404).json({ message: "Availability window not found" });
  response.json(result);
}));

app.patch("/api/shipments/:id/status", auth, asyncRoute(async (request, response) => {
  const roleTransitions = { driver: ["IN_TRANSIT", "ARRIVED"], security: ["VERIFIED", "PARKING", "AT_DOCK", "REJECTED"], warehouse: ["UNLOADING", "RECEIVED"], admin: ["PLANNED","IN_TRANSIT","ARRIVED","VERIFIED","PARKING","AT_DOCK","UNLOADING","RECEIVED","REJECTED"] };
  if (!(roleTransitions[request.user.role] || []).includes(request.body?.status)) return response.status(403).json({ message: "This status change is not available for your role" });
  const result = await store.update((state) => {
    const shipment = state.shipments.find((row) => row.id === Number(request.params.id));
    if (!shipment) return null;
    if (shipment.bookingStatus !== "APPROVED") return { approvalRequired: true };
    if (request.user.role === "driver" && shipment.driverName.toLowerCase() !== request.user.name.toLowerCase()) return { forbidden: true };
    let status = request.body.status;
    if (request.body.palletId) {
      shipment.palletIds ||= [];
      if (!shipment.palletIds.includes(request.body.palletId)) shipment.palletIds.push(request.body.palletId);
      shipment.palletsScanned = shipment.palletIds.length;
      status = shipment.palletsTotal > 0 && shipment.palletsScanned >= shipment.palletsTotal ? "RECEIVED" : "UNLOADING";
    }
    shipment.status = status;
    if (request.body.dock !== undefined) shipment.dock = request.body.dock || null;
    if (status === "IN_TRANSIT") shipment.startedAt = new Date().toISOString();
    if (status === "ARRIVED") shipment.arrivalTime = new Date().toISOString();
    if (status === "RECEIVED") shipment.completedAt = new Date().toISOString();
    if (status === "REJECTED") shipment.rejectionReason = String(request.body.rejectionReason || "Rejected during trial");
    addAudit(state, request.user, status, request.body.palletId ? `Pallet ${request.body.palletId} scanned` : `${shipment.shipmentNumber} moved to ${status.replaceAll("_", " ").toLowerCase()}`, shipment.shipmentNumber);
    return { ok: true, status };
  });
  if (!result) return response.status(404).json({ message: "Shipment not found" });
  if (result.forbidden) return response.status(403).json({ message: "This shipment is assigned to another driver" });
  if (result.approvalRequired) return response.status(409).json({ message: "This booking must be approved before operations can begin" });
  response.json(result);
}));

app.post("/api/imports/excel/preview", auth, allow("admin", "planner"), excelUpload.single("file"), asyncRoute(async (request, response) => {
  if (!request.file) return response.status(400).json({ message: "Choose an .xlsx or .xlsm workbook up to 10 MB" });
  const state = await store.read();
  const fallbackDate = state.settings.availableDates[0] || localDate(1);
  const preview = await parseDeliveryWorkbook(request.file.buffer, request.file.originalname, { fallbackDate });
  const previewToken = randomUUID();
  const expiresAt = Date.now() + 30 * 60 * 1000;
  for (const [key, cached] of importPreviews) if (cached.expiresAt < Date.now()) importPreviews.delete(key);
  importPreviews.set(previewToken, { preview, userId: request.user.id, expiresAt });
  response.json({ ...preview, previewToken });
}));

app.post("/api/imports/excel/commit", auth, allow("admin", "planner"), asyncRoute(async (request, response) => {
  const token = String(request.body?.previewToken || "");
  const cached = importPreviews.get(token);
  if (!cached || cached.userId !== request.user.id || cached.expiresAt < Date.now()) return response.status(410).json({ message: "The import preview expired. Upload the workbook again." });
  const readyRows = cached.preview.rows.filter((row) => row.status === "ready");
  if (!readyRows.length) return response.status(400).json({ message: "No nonblank rows were found to import" });
  const result = await store.update((state) => {
    const groups = new Map();
    for (const row of readyRows) {
      const key = row.placeholderFields?.length ? `${row.sheet}|${row.sourceRow}` : `${row.supplier.toLowerCase()}|${row.deliveryDate}|${row.deliveryTime}|${row.endTime || ""}|${row.site.toLowerCase()}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(row);
    }
    const batchId = nextId(state.importBatches);
    let shipmentId = nextId(state.shipments);
    let itemId = Math.max(0, ...state.shipments.flatMap((shipment) => shipment.items).map((item) => item.id), ...state.rdsRequests.flatMap((rds) => rds.items || []).map((item) => item.id)) + 1;
    for (const rows of groups.values()) {
      const first = rows[0];
      const supplier = ensureSupplier(state, first.supplier);
      ensureAvailabilityForTime(state, first.deliveryDate, first.deliveryTime);
      const items = rows.map((row) => {
        if (!state.materials.some((material) => material.code === row.materialCode)) state.materials.push({ id: nextId(state.materials), code: row.materialCode, name: row.materialName, type: row.materialType || "RM", uom: row.uom, shelfLifeDays: 0, unitsPerPallet: 0, storageZone: "To review" });
        return makeItem(itemId++, {
          poNumber: row.poNumber,
          materialCode: row.materialCode,
          materialName: row.materialName,
          quantity: row.quantity,
          uom: row.uom,
          palletCount: 0,
          sourceSheet: row.sheet,
          sourceRow: row.sourceRow,
          sourceFile: cached.preview.fileName,
          deliverySite: row.site,
          deliveryWeek: row.week,
          poBalance: row.poBalance,
          poQuantity: row.poQuantity,
          stillToBeDelivered: row.stillToBeDelivered,
          remarks: row.remarks,
        });
      });
      const rdsId = nextId(state.rdsRequests);
      const rds = { id: rdsId, rdsNumber: `IMP-RDS-${batchId}-${rdsId}`, dppNumber: `IMP-DPP-${batchId}-${rdsId}`, supplier: supplier.name, supplierId: supplier.id, requestedDate: first.deliveryDate, requestedTime: first.deliveryTime, availabilitySlotId: matchingAvailability(state, first.deliveryDate, first.deliveryTime, null)?.id || null, status: "SCHEDULED", notes: `Imported from ${cached.preview.fileName}`, items };
      state.rdsRequests.push(rds);
      const currentShipmentId = shipmentId++;
      const shipmentNumber = nextCode("SHP", currentShipmentId, first.deliveryDate);
      state.shipments.push({
        id: currentShipmentId,
        shipmentNumber,
        bookingReceipt: nextCode("BKG", currentShipmentId, first.deliveryDate),
        supplier: supplier.name,
        vendorCode: supplier.vendorCode,
        scheduledDate: first.deliveryDate,
        scheduledTime: first.deliveryTime,
        scheduledEndTime: first.endTime || null,
        expectedDurationMinutes: first.endTime ? durationMinutes(first.deliveryTime, first.endTime) : null,
        timeSlot: scheduleLabel(first.deliveryTime, first.endTime),
        shift: "Flexible date",
        bookingStatus: "APPROVED",
        status: "PLANNED",
        truckPlate: "TO BE ASSIGNED",
        driverName: "To be assigned",
        driverPhone: "",
        materialWeightKg: rows.reduce((sum, row) => sum + (row.uom === "KG" ? row.quantity : row.uom === "MT" ? row.quantity * 1000 : 0), 0),
        dock: null,
        arrivalTime: null,
        startedAt: null,
        completedAt: null,
        rejectionReason: null,
        importBatchId: batchId,
        importSource: cached.preview.fileName,
        items,
        palletsScanned: 0,
        palletsTotal: 0,
        palletIds: [],
      });
      addAudit(state, request.user, "EXCEL_IMPORTED", `${shipmentNumber} created from ${cached.preview.fileName}`, shipmentNumber);
    }
    syncAvailableDates(state);
    const batch = { id: batchId, fileName: cached.preview.fileName, status: "IMPORTED", totalRows: cached.preview.summary.totalRows, importedRows: readyRows.length, skippedRows: 0, deliveryCount: groups.size, createdAt: new Date().toISOString(), completedAt: new Date().toISOString() };
    state.importBatches.unshift(batch);
    addAudit(state, request.user, "EXCEL_IMPORT_COMPLETED", `${groups.size} deliveries and ${readyRows.length} rows imported from ${cached.preview.fileName}`);
    return { batchId, importedRows: readyRows.length, skippedRows: 0, deliveryCount: groups.size };
  });
  importPreviews.delete(token);
  response.status(201).json(result);
}));

app.post("/api/materials", auth, allow("admin"), asyncRoute(async (request, response) => {
  const result = await store.update((state) => {
    const id = nextId(state.materials);
    state.materials.push({ id, code: String(request.body?.code || `MAT-${id}`), name: String(request.body?.name || "Material to review"), type: String(request.body?.type || "RM"), uom: String(request.body?.uom || "N/A"), shelfLifeDays: Number(request.body?.shelfLifeDays || 0), unitsPerPallet: Number(request.body?.unitsPerPallet || 0), storageZone: String(request.body?.storageZone || "") });
    return { id };
  });
  response.status(201).json(result);
}));

app.post("/api/users", auth, allow("admin"), asyncRoute(async (request, response) => {
  const roles = ["admin", "planner", "supplier", "driver", "security", "warehouse"];
  if (!String(request.body?.name || "").trim() || !String(request.body?.username || "").trim() || String(request.body?.password || "").length < 8 || !roles.includes(request.body?.role)) return response.status(400).json({ message: "Name, username, valid role, and an 8-character password are required" });
  const passwordHash = await bcrypt.hash(String(request.body.password), 10);
  const result = await store.update((state) => {
    if (state.users.some((user) => user.username.toLowerCase() === request.body.username.toLowerCase())) return { duplicate: true };
    const id = nextId(state.users);
    state.users.push({ id, name: String(request.body.name).trim(), username: String(request.body.username).trim().toLowerCase(), passwordHash, role: request.body.role, supplierId: request.body.role === "supplier" ? Number(request.body.supplierId || 0) || null : null });
    return { id };
  });
  if (result.duplicate) return response.status(409).json({ message: "That username already exists" });
  response.status(201).json(result);
}));

app.patch("/api/settings", auth, allow("admin", "planner"), asyncRoute(async (request, response) => {
  const result = await store.update((state) => {
    const availableSlots = Array.isArray(request.body?.availableSlots) ? request.body.availableSlots.filter((slot) => validDate(slot.date) && validTime(slot.startTime) && validTime(slot.endTime) && toMinutes(slot.endTime) > toMinutes(slot.startTime)).map((slot, index) => ({ id: Number(slot.id) || index + 1, date: slot.date, startTime: slot.startTime, endTime: slot.endTime, label: String(slot.label || "Open receiving window") })) : state.settings.availableSlots;
    state.settings = {
      ...state.settings,
      flexibleScheduling: true,
      dockCount: 2,
      graceMinutes: Number(request.body?.graceMinutes ?? state.settings.graceMinutes),
      siteName: String(request.body?.siteName || state.settings.siteName),
      availableSlots,
    };
    syncAvailableDates(state);
    addAudit(state, request.user, "SCHEDULE_SETTINGS", "Scheduling rules were updated");
    return { ok: true };
  });
  response.json(result);
}));

app.post("/api/shipment-items/:id/documents", auth, allow("admin", "supplier"), upload.single("file"), asyncRoute(async (request, response) => {
  if (!request.file) return response.status(400).json({ message: "Choose a PDF or image up to 15 MB" });
  const documentType = String(request.body?.documentType || "").toUpperCase();
  if (!["DN", "COA"].includes(documentType)) return response.status(400).json({ message: "Document type must be DN or COA" });
  const result = await store.update((state) => {
    const item = state.shipments.flatMap((shipment) => shipment.items).find((row) => row.id === Number(request.params.id));
    if (!item) return null;
    item[documentType === "DN" ? "dnFileName" : "coaFileName"] = request.file.originalname;
    return { id: item.id, fileName: request.file.originalname };
  });
  if (!result) return response.status(404).json({ message: "Shipment item not found" });
  response.status(201).json(result);
}));

app.get("/api/shipments/:id/qr.svg", asyncRoute(async (request, response) => {
  const state = await store.read();
  const shipment = state.shipments.find((row) => row.id === Number(request.params.id));
  if (!shipment) return response.status(404).end();
  response.type("image/svg+xml").send(await QRCode.toString(`${APP_ORIGIN}/?shipment=${encodeURIComponent(shipment.shipmentNumber)}`, { type: "svg", margin: 1, width: 240, color: { dark: "#0b1e38", light: "#ffffff" } }));
}));

app.use((error, _request, response, _next) => {
  void _next;
  console.error(error);
  if (error.code === "LIMIT_FILE_SIZE") return response.status(413).json({ message: "File exceeds the upload limit" });
  response.status(500).json({ message: error.message || "The trial server could not complete this request" });
});

app.listen(PORT, "0.0.0.0", () => console.log(`DockFlow trial API listening on ${PORT} with JSON storage`));
