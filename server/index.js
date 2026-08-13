import bcrypt from "bcryptjs";
import cors from "cors";
import express from "express";
import helmet from "helmet";
import jwt from "jsonwebtoken";
import multer from "multer";
import PDFDocument from "pdfkit";
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
const slotContains = (slot, date, startTime, endTime = null) => slot?.date === date && startTime >= slot.startTime && startTime < slot.endTime && (!endTime || endTime <= slot.endTime);
const matchingAvailability = (state, date, startTime, endTime) => (state.settings.availableSlots || []).find((slot) => slotContains(slot, date, startTime, endTime));
const availabilityForShipment = (state, shipment) => {
  const selected = (state.settings.availableSlots || []).find((slot) => slot.id === Number(shipment.availabilitySlotId));
  return slotContains(selected, shipment.scheduledDate, shipment.scheduledTime, null) ? selected : matchingAvailability(state, shipment.scheduledDate, shipment.scheduledTime, null);
};
const scanShipmentNumber = (rawValue) => {
  let value = String(rawValue || "").trim();
  try {
    const url = new URL(value);
    value = url.searchParams.get("shipment") || url.pathname.split("/").filter(Boolean).pop() || value;
  } catch {
    const queryValue = value.match(/[?&]shipment=([^&]+)/i)?.[1];
    if (queryValue) value = queryValue;
  }
  try { value = decodeURIComponent(value); } catch {}
  return value.split("/").filter(Boolean).pop()?.trim().toUpperCase() || "";
};
const SCAN_STAGES = {
  TRIP: { status: "IN_TRANSIT", label: "Trip", roles: ["admin", "planner", "supplier"], from: ["BOOKED"] },
  GATE: { status: null, label: "Gate", roles: ["admin", "planner", "security"], from: ["IN_TRANSIT", "RECEIVED"] },
  UNLOADING: { status: "UNLOADING", label: "Unloading", roles: ["admin", "planner", "warehouse"], from: ["GATE_IN"] },
  RECEIVED: { status: "RECEIVED", label: "Received", roles: ["admin", "planner", "warehouse"], from: ["UNLOADING"] },
};
const syncAvailableDates = (state) => {
  state.settings.availableDates = [...new Set((state.settings.availableSlots || []).map((slot) => slot.date))].sort();
};
const ensureAvailabilityForTime = (state, date, time) => {
  state.settings.availableSlots ||= [];
  const existing = matchingAvailability(state, date, time, null);
  if (existing) return existing;
  const startMinutes = Math.max(0, toMinutes(time) - 30);
  const endMinutes = Math.min(1439, toMinutes(time) + 90);
  const slot = { id: nextId(state.settings.availableSlots), date, startTime: toTime(startMinutes), endTime: toTime(endMinutes), label: "Imported delivery window" };
  state.settings.availableSlots.push(slot);
  syncAvailableDates(state);
  return slot;
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
const canAccessShipment = (user, shipment) => user.role !== "supplier" || Number(user.supplierId) === Number(shipment.supplierId);
const ensureSupplier = (state, name) => {
  const supplierName = String(name || "").trim() || "Supplier to assign";
  let supplier = state.suppliers.find((row) => row.name.toLowerCase() === supplierName.toLowerCase());
  if (!supplier) {
    supplier = { id: nextId(state.suppliers), vendorCode: `TRIAL-${String(nextId(state.suppliers)).padStart(3, "0")}`, name: supplierName, productPresets: [] };
    state.suppliers.push(supplier);
  }
  return supplier;
};
const makeItem = (id, data) => ({
  id,
  presetId: Number(data.presetId) || null,
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
      { id: 1, vendorCode: "TRIAL-001", name: "Trial Ingredients Supplier", productPresets: [{ id: 1, name: "Eggs", uom: "KG", defaultAmount: 300 }, { id: 2, name: "Mayonnaise", uom: "KG", defaultAmount: 500 }] },
      { id: 2, vendorCode: "TRIAL-002", name: "Trial Packaging Supplier", productPresets: [{ id: 3, name: "Delta Cap 470/700/940 ML", uom: "PC", defaultAmount: 18480 }] },
      { id: 3, vendorCode: "TRIAL-003", name: "Trial Starch Supplier", productPresets: [{ id: 4, name: "Corn Starch", uom: "KG", defaultAmount: 600 }] },
    ],
    materials,
    shipments,
    rdsRequests: [
      { id: 1, rdsNumber: "RDS-TRIAL-001", dppNumber: "DPP-TRIAL-001", supplier: "Trial Packaging Supplier", supplierId: 2, requestedDate: dates[2], requestedTime: "15:00", availabilitySlotId: 6, status: "PENDING", notes: "Placeholder request for testing", items: [makeItem(7, { poNumber: "450000201", materialCode: materials[2].code, materialName: materials[2].name, quantity: 12000, uom: "PC", palletCount: 2 })] },
      { id: 2, rdsNumber: "RDS-TRIAL-002", dppNumber: "DPP-TRIAL-002", supplier: "Trial Ingredients Supplier", supplierId: 1, requestedDate: dates[3], requestedTime: "16:00", availabilitySlotId: 8, status: "CONFIRMED", notes: "Ready to schedule in the selected availability window", items: [makeItem(8, { poNumber: "450000202", materialCode: materials[1].code, materialName: materials[1].name, quantity: 500, uom: "KG", palletCount: 1 })] },
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
  state.version = 6;
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
  let nextPresetId = Math.max(0, ...state.suppliers.flatMap((supplier) => supplier.productPresets || []).map((preset) => Number(preset.id) || 0)) + 1;
  for (const supplier of state.suppliers) {
    supplier.id ||= nextSupplierId++;
    supplier.name = String(supplier.name || "Supplier to assign");
    supplier.vendorCode = String(supplier.vendorCode || `TRIAL-${String(supplier.id).padStart(3, "0")}`);
    supplier.productPresets = Array.isArray(supplier.productPresets) ? supplier.productPresets.map((preset) => ({ id: Number(preset.id) || nextPresetId++, name: String(preset.name || "Product to configure"), uom: String(preset.uom || "KG"), defaultAmount: Number(preset.defaultAmount || 0) })) : [];
    if (!supplier.productPresets.length) {
      const matchingMaterials = state.shipments.filter((shipment) => shipment.supplier === supplier.name).flatMap((shipment) => shipment.items || []);
      const seen = new Set();
      supplier.productPresets = matchingMaterials.filter((item) => item.materialName && !seen.has(item.materialName.toLowerCase()) && seen.add(item.materialName.toLowerCase())).slice(0, 8).map((item) => ({ id: nextPresetId++, name: item.materialName, uom: item.uom || "KG", defaultAmount: Number(item.quantity || 0) }));
    }
  }
  let nextMaterialId = nextId(state.materials);
  for (const material of state.materials) { material.id ||= nextMaterialId++; material.code = String(material.code || `UNSPECIFIED-${material.id}`); material.name = String(material.name || "Material to review"); material.type = String(material.type || "RM"); material.uom = String(material.uom || "N/A"); material.shelfLifeDays = Number(material.shelfLifeDays || 0); material.unitsPerPallet = Number(material.unitsPerPallet || 0); material.storageZone = String(material.storageZone || "To review"); }
  let nextShipmentId = nextId(state.shipments);
  let nextItemId = Math.max(0, ...state.shipments.flatMap((shipment) => shipment.items || []).map((item) => Number(item.id) || 0), ...state.rdsRequests.flatMap((rds) => rds.items || []).map((item) => Number(item.id) || 0)) + 1;
  for (const shipment of state.shipments) {
    shipment.id ||= nextShipmentId++;
    shipment.scheduledDate = validDate(shipment.scheduledDate) ? shipment.scheduledDate : localDate();
    shipment.scheduledTime = validTime(shipment.scheduledTime) ? shipment.scheduledTime : "12:00";
    shipment.scheduledEndTime = validTime(shipment.scheduledEndTime) ? shipment.scheduledEndTime : null;
    shipment.availabilitySlotId = availabilityForShipment(state, shipment)?.id || null;
    const legacyStatus = shipment.status;
    const statusMigration = { PLANNED: "BOOKED", ARRIVED: "GATE_IN", VERIFIED: "GATE_IN", PARKING: "GATE_IN", AT_DOCK: "UNLOADING" };
    shipment.status = statusMigration[legacyStatus] || (["BOOKED", "IN_TRANSIT", "GATE_IN", "UNLOADING", "RECEIVED", "GATE_OUT", "REJECTED"].includes(legacyStatus) ? legacyStatus : "BOOKED");
    shipment.bookingStatus ||= shipment.status === "REJECTED" ? "REJECTED" : "APPROVED";
    shipment.shipmentNumber ||= nextCode("SHP", shipment.id, shipment.scheduledDate);
    shipment.bookingReceipt ||= nextCode("BKG", shipment.id, shipment.scheduledDate);
    shipment.supplier = String(shipment.supplier || "Supplier to assign");
    shipment.vendorCode = String(shipment.vendorCode || "TRIAL");
    shipment.supplierId = Number(shipment.supplierId) || state.suppliers.find((supplier) => supplier.vendorCode === shipment.vendorCode || supplier.name === shipment.supplier)?.id || null;
    shipment.dppNumber = String(shipment.dppNumber || `DPP-${String(shipment.id).padStart(5, "0")}`);
    shipment.truckPlate = String(shipment.truckPlate || "TO BE ASSIGNED");
    shipment.driverName = String(shipment.driverName || "To be assigned");
    shipment.driverPhone = String(shipment.driverPhone || "");
    shipment.items = Array.isArray(shipment.items) && shipment.items.length ? shipment.items.map((item) => makeItem(item.id || nextItemId++, item)) : [makeItem(nextItemId++, {})];
    shipment.materialWeightKg = Number(shipment.materialWeightKg || 0);
    shipment.palletsScanned = Number(shipment.palletsScanned || 0);
    shipment.palletsTotal = Number(shipment.palletsTotal ?? shipment.items.reduce((sum, item) => sum + item.palletCount, 0));
    shipment.timeSlot = scheduleLabel(shipment.scheduledTime, shipment.scheduledEndTime);
    shipment.shift = "Flexible date";
    shipment.tripAt ||= legacyStatus !== "PLANNED" && legacyStatus !== "BOOKED" ? shipment.startedAt || null : null;
    shipment.gateInAt ||= ["ARRIVED", "VERIFIED", "PARKING", "AT_DOCK", "UNLOADING", "RECEIVED", "GATE_IN", "GATE_OUT"].includes(legacyStatus) ? shipment.arrivalTime || shipment.startedAt || null : null;
    shipment.unloadingAt ||= ["AT_DOCK", "UNLOADING", "RECEIVED", "GATE_OUT"].includes(legacyStatus) ? shipment.startedAt || shipment.arrivalTime || null : null;
    shipment.receivedAt ||= ["RECEIVED", "GATE_OUT"].includes(legacyStatus) ? shipment.completedAt || null : null;
    shipment.gateOutAt ||= legacyStatus === "RECEIVED" && shipment.completedAt ? shipment.completedAt : null;
    if (legacyStatus === "RECEIVED" && shipment.completedAt) shipment.status = "GATE_OUT";
    shipment.lastProcessAt ||= shipment.gateOutAt || shipment.receivedAt || shipment.unloadingAt || shipment.gateInAt || shipment.tripAt || null;
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
    const rdsSlot = state.settings.availableSlots.find((slot) => slot.id === Number(rds.availabilitySlotId) && slotContains(slot, rds.requestedDate, rds.requestedTime, null)) || matchingAvailability(state, rds.requestedDate, rds.requestedTime, null);
    rds.availabilitySlotId = rdsSlot?.id || null;
    rds.requestedEndTime = rdsSlot?.endTime || (validTime(rds.requestedEndTime) ? rds.requestedEndTime : undefined);
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
  const supplierOnly = _request.user.role === "supplier";
  const shipments = supplierOnly ? state.shipments.filter((shipment) => Number(shipment.supplierId) === Number(_request.user.supplierId)) : state.shipments;
  const shipmentNumbers = new Set(shipments.map((shipment) => shipment.shipmentNumber));
  response.json({
    shipments: [...shipments].sort((a, b) => `${a.scheduledDate}${a.scheduledTime}`.localeCompare(`${b.scheduledDate}${b.scheduledTime}`)),
    rdsRequests: supplierOnly ? [] : state.rdsRequests,
    materials: supplierOnly ? [] : state.materials,
    suppliers: supplierOnly ? state.suppliers.filter((supplier) => Number(supplier.id) === Number(_request.user.supplierId)) : state.suppliers,
    users: _request.user.role === "admin" ? state.users.map(publicUser) : [],
    audit: supplierOnly ? state.audit.filter((entry) => !entry.shipmentNumber || shipmentNumbers.has(entry.shipmentNumber)) : state.audit,
    importBatches: supplierOnly ? [] : state.importBatches,
    settings: { ...state.settings, dockCount: 2 },
  });
}));

app.post("/api/rds", auth, allow("admin", "planner", "supplier"), asyncRoute(async (request, response) => {
  const result = await store.update((state) => {
    const supplierId = request.user.role === "supplier" ? Number(request.user.supplierId) : Number(request.body?.supplierId);
    const supplier = state.suppliers.find((row) => row.id === supplierId);
    if (!supplier) return { supplierRequired: true };
    const scheduledDate = String(request.body?.scheduledDate || request.body?.requestedDate || "");
    const scheduledTime = String(request.body?.scheduledTime || request.body?.requestedTime || "").slice(0, 5);
    const scheduledEndTime = String(request.body?.scheduledEndTime || request.body?.requestedEndTime || "").slice(0, 5);
    if (!validDate(scheduledDate) || !validTime(scheduledTime) || !validTime(scheduledEndTime) || toMinutes(scheduledEndTime) <= toMinutes(scheduledTime)) return { invalidSchedule: true };
    const dateWindows = state.settings.availableSlots.filter((slot) => slot.date === scheduledDate);
    const selectedSlot = matchingAvailability(state, scheduledDate, scheduledTime, scheduledEndTime);
    if (dateWindows.length && !selectedSlot) return { unavailable: true };
    const dppNumber = String(request.body?.dppNumber || "").trim();
    const truckPlate = String(request.body?.truckPlate || "").trim().toUpperCase();
    const driverName = String(request.body?.driverName || "").trim();
    const driverPhone = String(request.body?.driverPhone || "").trim();
    if (!dppNumber || !truckPlate || !driverName || !driverPhone) return { missingDetails: true };
    const duplicate = state.shipments.find((shipment) => shipment.bookingStatus !== "REJECTED" && Number(shipment.supplierId) === supplier.id && shipment.dppNumber.toLowerCase() === dppNumber.toLowerCase() && shipment.scheduledDate === scheduledDate && shipment.scheduledTime === scheduledTime && shipment.scheduledEndTime === scheduledEndTime && shipment.truckPlate === truckPlate);
    if (duplicate) return { duplicate: true, shipmentNumber: duplicate.shipmentNumber };
    const selections = Array.isArray(request.body?.products) ? request.body.products : [];
    const validSelections = selections.map((selection) => {
      const preset = supplier.productPresets.find((item) => item.id === Number(selection.presetId));
      const amount = Number(selection.amount);
      return preset && amount > 0 ? { preset, amount } : null;
    }).filter(Boolean);
    if (!validSelections.length) return { productsRequired: true };
    let itemId = Math.max(0, ...state.shipments.flatMap((shipment) => shipment.items || []).map((item) => Number(item.id) || 0)) + 1;
    const items = validSelections.map(({ preset, amount }) => makeItem(itemId++, { presetId: preset.id, materialCode: `PRESET-${preset.id}`, materialName: preset.name, quantity: amount, uom: preset.uom, palletCount: 0 }));
    const id = nextId(state.shipments);
    const shipmentNumber = nextCode("SHP", id, scheduledDate);
    const shipment = {
      id, shipmentNumber, bookingReceipt: nextCode("BKG", id, scheduledDate), dppNumber,
      supplier: supplier.name, supplierId: supplier.id, vendorCode: supplier.vendorCode,
      scheduledDate, scheduledTime, scheduledEndTime, availabilitySlotId: selectedSlot?.id || null,
      expectedDurationMinutes: durationMinutes(scheduledTime, scheduledEndTime), timeSlot: scheduleLabel(scheduledTime, scheduledEndTime), shift: "Flexible date",
      bookingStatus: "PENDING_APPROVAL", status: "BOOKED", truckPlate, driverName, driverPhone,
      materialWeightKg: items.reduce((sum, item) => sum + (["KG", "MT"].includes(item.uom) ? item.quantity * (item.uom === "MT" ? 1000 : 1) : 0), 0),
      dock: null, arrivalTime: null, startedAt: null, completedAt: null, lastProcessAt: null,
      tripAt: null, gateInAt: null, unloadingAt: null, receivedAt: null, gateOutAt: null,
      rejectionReason: null, importBatchId: null, importSource: null, items, palletsScanned: 0, palletsTotal: 0, palletIds: [],
      requestedByUserId: request.user.id, requestedAt: new Date().toISOString(),
    };
    state.shipments.push(shipment);
    addAudit(state, request.user, "BOOKING_REQUESTED", `${shipmentNumber} requested by ${supplier.name} for ${scheduledDate} ${scheduledTime}-${scheduledEndTime}`, shipmentNumber);
    return { id, shipmentNumber, bookingReceipt: shipment.bookingReceipt };
  });
  if (result.supplierRequired) return response.status(400).json({ message: "This account is not linked to a supplier" });
  if (result.invalidSchedule) return response.status(400).json({ message: "Choose a valid date, start time, and later end time" });
  if (result.unavailable) return response.status(400).json({ message: "Choose a time inside one of the open receiving windows" });
  if (result.missingDetails) return response.status(400).json({ message: "DPP number, truck plate, driver name, and phone number are required" });
  if (result.productsRequired) return response.status(400).json({ message: "Select at least one preset delivery product and enter its amount" });
  if (result.duplicate) return response.status(409).json({ message: `${result.shipmentNumber} already contains this same request. It was not submitted twice.` });
  response.status(201).json(result);
}));

app.post("/api/shipments", auth, allow("admin", "planner", "supplier"), asyncRoute(async (request, response) => {
  const result = await store.update((state) => {
    const rds = state.rdsRequests.find((row) => row.id === Number(request.body?.rdsId));
    if (!rds) return null;
    const selectedById = state.settings.availableSlots.find((slot) => slot.id === Number(request.body?.availabilitySlotId || rds.availabilitySlotId));
    const requestedDate = String(request.body?.scheduledDate || "");
    const requestedTime = String(request.body?.scheduledTime || "").slice(0, 5);
    const selectedSlot = slotContains(selectedById, requestedDate, requestedTime, null) ? selectedById : matchingAvailability(state, requestedDate, requestedTime, null);
    if (!selectedSlot) return { unavailable: true };
    const scheduledDate = selectedSlot.date;
    const scheduledTime = selectedSlot.startTime;
    const scheduledEndTime = selectedSlot.endTime;
    const id = nextId(state.shipments);
    let itemId = Math.max(0, ...state.shipments.flatMap((shipment) => shipment.items).map((item) => item.id), ...state.rdsRequests.flatMap((row) => row.items || []).map((item) => item.id)) + 1;
    const items = (rds.items || []).map((item) => ({ ...item, id: itemId++ }));
    const shipmentNumber = nextCode("SHP", id, scheduledDate);
    const shipment = {
      id,
      shipmentNumber,
      bookingReceipt: nextCode("BKG", id, scheduledDate),
      supplier: rds.supplier,
      supplierId: rds.supplierId,
      dppNumber: rds.dppNumber,
      vendorCode: state.suppliers.find((row) => row.id === rds.supplierId)?.vendorCode || "TRIAL",
      scheduledDate,
      scheduledTime,
      scheduledEndTime,
      availabilitySlotId: selectedSlot.id,
      expectedDurationMinutes: scheduledEndTime ? durationMinutes(scheduledTime, scheduledEndTime) : null,
      timeSlot: scheduleLabel(scheduledTime, scheduledEndTime),
      shift: "Flexible date",
      bookingStatus: "PENDING_APPROVAL",
      status: "BOOKED",
      truckPlate: String(request.body?.truckPlate || "TO BE ASSIGNED"),
      driverName: String(request.body?.driverName || "To be assigned"),
      driverPhone: String(request.body?.driverPhone || ""),
      materialWeightKg: Number(request.body?.materialWeightKg || 0),
      dock: null,
      arrivalTime: null,
      startedAt: null,
      completedAt: null,
      lastProcessAt: null,
      tripAt: null,
      gateInAt: null,
      unloadingAt: null,
      receivedAt: null,
      gateOutAt: null,
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
    addAudit(state, request.user, "BOOKING_REQUESTED", `${shipmentNumber} requested ${scheduledDate} ${scheduledTime}-${scheduledEndTime}; awaiting planner approval`, shipmentNumber);
    return { id, shipmentNumber, bookingReceipt: shipment.bookingReceipt, itemIds: items.map((item) => item.id) };
  });
  if (!result) return response.status(404).json({ message: "Delivery request not found" });
  if (result.unavailable) return response.status(400).json({ message: "Choose one of the planner's available booking windows" });
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
      shipment.status = "BOOKED";
      shipment.rejectionReason = null;
      addAudit(state, request.user, "BOOKING_APPROVED", `${shipment.shipmentNumber} was approved for ${shipment.scheduledDate} at ${shipment.scheduledTime}`, shipment.shipmentNumber);
    } else {
      const reason = String(request.body?.reason || "").trim();
      if (!reason) return { reasonRequired: true };
      shipment.bookingStatus = "REJECTED";
      shipment.status = "REJECTED";
      shipment.rejectionReason = reason;
      addAudit(state, request.user, "BOOKING_REJECTED", `${shipment.shipmentNumber} rejected: ${reason}`, shipment.shipmentNumber);
    }
    return { ok: true, bookingStatus: shipment.bookingStatus };
  });
  if (!result) return response.status(404).json({ message: "Shipment not found" });
  if (result.reasonRequired) return response.status(400).json({ message: "Enter a reason before denying this booking" });
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

app.post("/api/shipments/scan-stage", auth, asyncRoute(async (request, response) => {
  const stage = String(request.body?.stage || "").toUpperCase();
  const configuration = SCAN_STAGES[stage];
  if (!configuration) return response.status(400).json({ message: "Choose Trip, Gate, Unloading, or Received before scanning" });
  if (!configuration.roles.includes(request.user.role)) return response.status(403).json({ message: `Your role cannot record the ${configuration.label} scan` });
  const shipmentNumber = scanShipmentNumber(request.body?.scanValue);
  if (!shipmentNumber) return response.status(400).json({ message: "The QR code does not contain a shipment number" });
  const result = await store.update((state) => {
    const shipment = state.shipments.find((row) => row.shipmentNumber.toUpperCase() === shipmentNumber || String(row.id) === shipmentNumber);
    if (!shipment) return null;
    if (!canAccessShipment(request.user, shipment)) return { forbidden: true };
    if (shipment.bookingStatus !== "APPROVED") return { approvalRequired: true };
    const targetStatus = stage === "GATE" ? (shipment.status === "RECEIVED" || shipment.status === "GATE_OUT" ? "GATE_OUT" : "GATE_IN") : configuration.status;
    const alreadyRecorded = shipment.status === targetStatus;
    if (!alreadyRecorded && !configuration.from.includes(shipment.status)) return { wrongStage: true, currentStatus: shipment.status };
    shipment.status = targetStatus;
    const scannedAt = new Date().toISOString();
    shipment.lastProcessAt = scannedAt;
    if (stage === "TRIP") { shipment.tripAt ||= scannedAt; shipment.startedAt ||= scannedAt; }
    if (stage === "GATE" && targetStatus === "GATE_IN") { shipment.gateInAt ||= scannedAt; shipment.arrivalTime ||= scannedAt; }
    if (stage === "UNLOADING") shipment.unloadingAt ||= scannedAt;
    if (stage === "RECEIVED") shipment.receivedAt ||= scannedAt;
    if (stage === "GATE" && targetStatus === "GATE_OUT") { shipment.gateOutAt ||= scannedAt; shipment.completedAt ||= scannedAt; }
    const stageLabel = stage === "GATE" ? (targetStatus === "GATE_OUT" ? "Gate out" : "Gate in") : configuration.label;
    if (!alreadyRecorded) addAudit(state, request.user, `QR_${targetStatus}`, `${shipment.shipmentNumber} scanned at ${stageLabel}`, shipment.shipmentNumber);
    return { shipment, alreadyRecorded, stageLabel };
  });
  if (!result) return response.status(404).json({ message: "Shipment not found in this QR code" });
  if (result.approvalRequired) return response.status(409).json({ message: "This booking must be approved before it can be scanned" });
  if (result.forbidden) return response.status(403).json({ message: "This supplier account cannot access that shipment" });
  if (result.wrongStage) return response.status(409).json({ message: `This delivery is currently ${String(result.currentStatus).replaceAll("_", " ").toLowerCase()}. Complete the earlier scan stage first.` });
  response.json({ ...result, message: result.alreadyRecorded ? `${result.stageLabel} was already recorded for ${result.shipment.shipmentNumber}` : `${result.shipment.shipmentNumber} updated to ${result.stageLabel}` });
}));

app.patch("/api/shipments/:id/status", auth, asyncRoute(async (request, response) => {
  const roleTransitions = { supplier: ["IN_TRANSIT"], security: ["GATE_IN", "GATE_OUT"], warehouse: ["UNLOADING", "RECEIVED"], planner: ["BOOKED", "IN_TRANSIT", "GATE_IN", "UNLOADING", "RECEIVED", "GATE_OUT", "REJECTED"], admin: ["BOOKED", "IN_TRANSIT", "GATE_IN", "UNLOADING", "RECEIVED", "GATE_OUT", "REJECTED"] };
  if (!(roleTransitions[request.user.role] || []).includes(request.body?.status)) return response.status(403).json({ message: "This status change is not available for your role" });
  const result = await store.update((state) => {
    const shipment = state.shipments.find((row) => row.id === Number(request.params.id));
    if (!shipment) return null;
    if (!canAccessShipment(request.user, shipment)) return { forbidden: true };
    if (shipment.bookingStatus !== "APPROVED") return { approvalRequired: true };
    let status = request.body.status;
    if (request.body.palletId) {
      shipment.palletIds ||= [];
      if (!shipment.palletIds.includes(request.body.palletId)) shipment.palletIds.push(request.body.palletId);
      shipment.palletsScanned = shipment.palletIds.length;
      status = shipment.palletsTotal > 0 && shipment.palletsScanned >= shipment.palletsTotal ? "RECEIVED" : "UNLOADING";
    }
    shipment.status = status;
    if (request.body.dock !== undefined) shipment.dock = request.body.dock || null;
    const changedAt = new Date().toISOString();
    if (status === "IN_TRANSIT") { shipment.tripAt ||= changedAt; shipment.startedAt ||= changedAt; }
    if (status === "GATE_IN") { shipment.gateInAt ||= changedAt; shipment.arrivalTime ||= changedAt; }
    if (status === "UNLOADING") shipment.unloadingAt ||= changedAt;
    if (status === "RECEIVED") shipment.receivedAt ||= changedAt;
    if (status === "GATE_OUT") { shipment.gateOutAt ||= changedAt; shipment.completedAt ||= changedAt; }
    shipment.lastProcessAt = changedAt;
    if (status === "REJECTED") shipment.rejectionReason = String(request.body.rejectionReason || "Rejected during trial");
    addAudit(state, request.user, status, request.body.palletId ? `Pallet ${request.body.palletId} scanned` : `${shipment.shipmentNumber} moved to ${status.replaceAll("_", " ").toLowerCase()}`, shipment.shipmentNumber);
    return { ok: true, status };
  });
  if (!result) return response.status(404).json({ message: "Shipment not found" });
  if (result.forbidden) return response.status(403).json({ message: "This account cannot update that shipment" });
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
      const availabilitySlot = ensureAvailabilityForTime(state, first.deliveryDate, first.deliveryTime);
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
      const rds = { id: rdsId, rdsNumber: `IMP-RDS-${batchId}-${rdsId}`, dppNumber: `IMP-DPP-${batchId}-${rdsId}`, supplier: supplier.name, supplierId: supplier.id, requestedDate: first.deliveryDate, requestedTime: first.deliveryTime, requestedEndTime: availabilitySlot.endTime, availabilitySlotId: availabilitySlot.id, status: "SCHEDULED", notes: `Imported from ${cached.preview.fileName}`, items };
      state.rdsRequests.push(rds);
      const currentShipmentId = shipmentId++;
      const shipmentNumber = nextCode("SHP", currentShipmentId, first.deliveryDate);
      const bookingStatus = "PENDING_APPROVAL";
      state.shipments.push({
        id: currentShipmentId,
        shipmentNumber,
        bookingReceipt: nextCode("BKG", currentShipmentId, first.deliveryDate),
        supplier: supplier.name,
        supplierId: supplier.id,
        dppNumber: rds.dppNumber,
        vendorCode: supplier.vendorCode,
        scheduledDate: first.deliveryDate,
        scheduledTime: first.deliveryTime,
        scheduledEndTime: first.endTime || null,
        availabilitySlotId: availabilitySlot.id,
        expectedDurationMinutes: first.endTime ? durationMinutes(first.deliveryTime, first.endTime) : null,
        timeSlot: scheduleLabel(first.deliveryTime, first.endTime),
        shift: "Flexible date",
        bookingStatus,
        status: "BOOKED",
        truckPlate: "TO BE ASSIGNED",
        driverName: "To be assigned",
        driverPhone: "",
        materialWeightKg: rows.reduce((sum, row) => sum + (row.uom === "KG" ? row.quantity : row.uom === "MT" ? row.quantity * 1000 : 0), 0),
        dock: null,
        arrivalTime: null,
        startedAt: null,
        completedAt: null,
        lastProcessAt: null,
        tripAt: null,
        gateInAt: null,
        unloadingAt: null,
        receivedAt: null,
        gateOutAt: null,
        rejectionReason: null,
        importBatchId: batchId,
        importSource: cached.preview.fileName,
        items,
        palletsScanned: 0,
        palletsTotal: 0,
        palletIds: [],
      });
      addAudit(state, request.user, "EXCEL_IMPORTED", `${shipmentNumber} created from ${cached.preview.fileName}; waiting for Management approval`, shipmentNumber);
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
    let supplierId = null;
    if (request.body.role === "supplier") {
      const existing = state.suppliers.find((supplier) => supplier.id === Number(request.body.supplierId));
      const supplier = existing || ensureSupplier(state, request.body.supplierName || request.body.name);
      supplier.productPresets ||= [];
      supplierId = supplier.id;
    }
    const id = nextId(state.users);
    state.users.push({ id, name: String(request.body.name).trim(), username: String(request.body.username).trim().toLowerCase(), passwordHash, role: request.body.role, supplierId });
    addAudit(state, request.user, "ACCOUNT_CREATED", `${request.body.role === "supplier" ? "Supplier" : request.body.role} account @${String(request.body.username).trim().toLowerCase()} created`);
    return { id, supplierId };
  });
  if (result.duplicate) return response.status(409).json({ message: "That username already exists" });
  response.status(201).json(result);
}));

app.patch("/api/suppliers/:id/presets", auth, allow("admin"), asyncRoute(async (request, response) => {
  const result = await store.update((state) => {
    const supplier = state.suppliers.find((row) => row.id === Number(request.params.id));
    if (!supplier) return null;
    const presets = Array.isArray(request.body?.presets) ? request.body.presets : [];
    let presetId = Math.max(0, ...state.suppliers.flatMap((row) => row.productPresets || []).map((preset) => Number(preset.id) || 0)) + 1;
    supplier.productPresets = presets.map((preset) => ({
      id: Number(preset.id) || presetId++,
      name: String(preset.name || "").trim(),
      uom: String(preset.uom || "KG").trim().toUpperCase(),
      defaultAmount: Math.max(0, Number(preset.defaultAmount || 0)),
    })).filter((preset) => preset.name);
    addAudit(state, request.user, "SUPPLIER_PRESETS_UPDATED", `${supplier.name} now has ${supplier.productPresets.length} preset delivery product${supplier.productPresets.length === 1 ? "" : "s"}`);
    return { ok: true, presets: supplier.productPresets };
  });
  if (!result) return response.status(404).json({ message: "Supplier not found" });
  response.json(result);
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
    const shipment = state.shipments.find((row) => row.items.some((item) => item.id === Number(request.params.id)));
    if (!shipment) return null;
    if (!canAccessShipment(request.user, shipment)) return { forbidden: true };
    const item = shipment.items.find((row) => row.id === Number(request.params.id));
    item[documentType === "DN" ? "dnFileName" : "coaFileName"] = request.file.originalname;
    return { id: item.id, fileName: request.file.originalname };
  });
  if (!result) return response.status(404).json({ message: "Shipment item not found" });
  if (result.forbidden) return response.status(403).json({ message: "This supplier account cannot access that shipment" });
  response.status(201).json(result);
}));

app.get("/api/shipments/:id/booking.pdf", auth, asyncRoute(async (request, response) => {
  const state = await store.read();
  const shipment = state.shipments.find((row) => row.id === Number(request.params.id));
  if (!shipment) return response.status(404).json({ message: "Shipment not found" });
  if (!canAccessShipment(request.user, shipment)) return response.status(403).json({ message: "This account cannot download that booking" });
  const qr = await QRCode.toBuffer(`${APP_ORIGIN}/?shipment=${encodeURIComponent(shipment.shipmentNumber)}`, { margin: 1, width: 260, color: { dark: "#0b1e38", light: "#ffffff" } });
  response.setHeader("Content-Type", "application/pdf");
  response.setHeader("Content-Disposition", `attachment; filename="${shipment.bookingReceipt}.pdf"`);
  const document = new PDFDocument({ size: "A4", margins: { top: 38, right: 42, bottom: 38, left: 42 }, info: { Title: `${shipment.bookingReceipt} booking receipt`, Author: "DockFlow" } });
  document.pipe(response);
  document.fillColor("#0b1e38").fontSize(23).font("Helvetica-Bold").text("DockFlow", 42, 38);
  document.fontSize(9).font("Helvetica").fillColor("#607089").text("DELIVERY BOOKING RECEIPT", 42, 68);
  document.image(qr, 445, 36, { width: 105 });
  document.roundedRect(42, 96, 508, 74, 8).fill("#f1f6ff");
  document.fillColor("#0b1e38").font("Helvetica-Bold").fontSize(15).text(shipment.truckPlate, 58, 112);
  document.font("Helvetica").fontSize(10).fillColor("#44556f").text(`${shipment.supplier} · ${shipment.driverName}`, 58, 137);
  document.font("Helvetica-Bold").fillColor("#1d65f5").text(shipment.bookingStatus === "APPROVED" ? "APPROVED" : shipment.bookingStatus === "REJECTED" ? "REJECTED" : "PENDING APPROVAL", 395, 122, { width: 135, align: "right" });
  const details = [
    ["Booking", shipment.bookingReceipt], ["Shipment", shipment.shipmentNumber], ["DPP number", shipment.dppNumber || "—"],
    ["Delivery date", shipment.scheduledDate], ["Scheduled time", `${shipment.scheduledTime}–${shipment.scheduledEndTime || shipment.scheduledTime}`], ["Driver phone", shipment.driverPhone || "—"],
  ];
  details.forEach(([label, value], index) => {
    const column = index % 3;
    const row = Math.floor(index / 3);
    const x = 42 + column * 169;
    const y = 194 + row * 50;
    document.font("Helvetica").fontSize(8).fillColor("#7b8799").text(label.toUpperCase(), x, y);
    document.font("Helvetica-Bold").fontSize(10).fillColor("#17263d").text(String(value), x, y + 14, { width: 155 });
  });
  let y = 305;
  document.font("Helvetica-Bold").fontSize(12).fillColor("#17263d").text("Delivery products", 42, y);
  y += 24;
  document.roundedRect(42, y, 508, 24, 4).fill("#0b1e38");
  document.fillColor("#ffffff").fontSize(8).text("PRODUCT", 54, y + 8).text("AMOUNT", 385, y + 8).text("UOM", 490, y + 8);
  y += 24;
  shipment.items.forEach((item, index) => {
    const height = 27;
    if (y + height > 760) { document.addPage(); y = 48; }
    if (index % 2 === 0) document.rect(42, y, 508, height).fill("#f7f9fc");
    document.fillColor("#17263d").font("Helvetica-Bold").fontSize(9).text(item.materialName, 54, y + 9, { width: 310 });
    document.font("Helvetica").text(Number(item.quantity || 0).toLocaleString("en-PH"), 385, y + 9, { width: 82 }).text(item.uom || "—", 490, y + 9, { width: 45 });
    y += height;
  });
  y += 18;
  if (shipment.rejectionReason) document.fillColor("#b42318").font("Helvetica-Bold").fontSize(9).text(`Rejection reason: ${shipment.rejectionReason}`, 42, y, { width: 508 });
  document.font("Helvetica").fontSize(8).fillColor("#7b8799").text("Times are recorded in Asia/Manila (GMT+8). Present this QR at every process station.", 42, 790, { width: 508, align: "center" });
  document.end();
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
