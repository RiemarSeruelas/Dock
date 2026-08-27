import bcrypt from "bcryptjs";
import cors from "cors";
import ExcelJS from "exceljs";
import express from "express";
import { rateLimit } from "express-rate-limit";
import helmet from "helmet";
import jwt from "jsonwebtoken";
import multer from "multer";
import PDFDocument from "pdfkit";
import QRCode from "qrcode";
import { createHash, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { parseDeliveryWorkbook } from "./excel-import.js";
import { database, hashToken } from "./db.js";
import { JsonStore } from "./json-store.js";
import { emailNotifications } from "./mailer.js";

const PORT = Number(process.env.API_PORT || 3001);
const JWT_SECRET = process.env.JWT_SECRET || "change-this-secret-before-production";
const ACCESS_TOKEN_SECRET = process.env.ACCESS_TOKEN_SECRET || JWT_SECRET;
const REFRESH_TOKEN_SECRET = process.env.REFRESH_TOKEN_SECRET || `${JWT_SECRET}-refresh`;
const ACCESS_TOKEN_TTL = process.env.ACCESS_TOKEN_TTL || "15m";
const REFRESH_TOKEN_DAYS = Math.max(1, Number(process.env.REFRESH_TOKEN_DAYS || 7));
const REFRESH_COOKIE = process.env.REFRESH_COOKIE_NAME || "dockflow_refresh";
const COOKIE_SECURE = String(process.env.COOKIE_SECURE || "false").toLowerCase() === "true";
const UPLOAD_DIR = resolve(process.env.UPLOAD_DIR || "./uploads");
const DATA_FILE = resolve(process.env.DATA_FILE || "./data/trial-data.json");
const APP_ORIGIN = process.env.APP_ORIGIN || "http://localhost:5059";
const ALLOWED_ORIGINS = [...new Set(`${APP_ORIGIN},${process.env.CORS_ORIGINS || ""}`.split(",").map((value) => value.trim()).filter(Boolean))];
const TIME_ZONE = process.env.TZ || "Asia/Manila";
const GEOCODING_API_URL = process.env.GEOCODING_API_URL || "https://nominatim.openstreetmap.org/search";
const ROUTING_API_URL = process.env.ROUTING_API_URL || "https://router.project-osrm.org/route/v1/driving";
const ETA_USER_AGENT = process.env.ETA_USER_AGENT || "DockFlow/0.1 (configure ETA_USER_AGENT with an administrator contact)";
const ETA_API_TIMEOUT_MS = Math.max(1000, Number(process.env.ETA_API_TIMEOUT_MS || 10000));
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
const issueDeliveryCode = (state, date) => {
  state.settings.deliveryCodeSequence = Number(state.settings.deliveryCodeSequence || 0) + 1;
  return nextCode("DLV", state.settings.deliveryCodeSequence, date);
};
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
const planningRoles = ["admin", "planner", "production"];
const validCoordinates = (value) => value && Number.isFinite(Number(value.lat)) && Number.isFinite(Number(value.lon));
const geocodeAddress = async (address) => {
  const url = new URL(GEOCODING_API_URL);
  url.searchParams.set("q", address);
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("limit", "1");
  const response = await fetch(url, { headers: { "User-Agent": ETA_USER_AGENT, Accept: "application/json" }, signal: AbortSignal.timeout(ETA_API_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`Address provider returned ${response.status}`);
  const matches = await response.json();
  const match = Array.isArray(matches) ? matches[0] : null;
  if (!match || !Number.isFinite(Number(match.lat)) || !Number.isFinite(Number(match.lon))) throw new Error("The address could not be located. Add a city, province, or postal code and try again.");
  return { lat: Number(match.lat), lon: Number(match.lon), displayName: String(match.display_name || address) };
};
const calculateRoute = async (origin, destination) => {
  const base = ROUTING_API_URL.replace(/\/$/, "");
  const url = new URL(`${base}/${origin.lon},${origin.lat};${destination.lon},${destination.lat}`);
  url.searchParams.set("overview", "false");
  url.searchParams.set("steps", "false");
  const response = await fetch(url, { headers: { "User-Agent": ETA_USER_AGENT, Accept: "application/json" }, signal: AbortSignal.timeout(ETA_API_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`Routing provider returned ${response.status}`);
  const result = await response.json();
  const route = result?.routes?.[0];
  if (!route || !Number.isFinite(Number(route.distance)) || !Number.isFinite(Number(route.duration))) throw new Error("No drivable route was found between these addresses.");
  return { distanceKm: Math.round(Number(route.distance) / 100) / 10, durationMinutes: Math.max(1, Math.round(Number(route.duration) / 60)) };
};
const applyShipmentEta = (state, shipment, tripAt) => {
  const supplier = state.suppliers.find((row) => Number(row.id) === Number(shipment.supplierId));
  const travelMinutes = Number(supplier?.routeDurationMinutes || 0);
  shipment.estimatedTravelMinutes = travelMinutes || null;
  shipment.estimatedTravelDistanceKm = Number(supplier?.routeDistanceKm || 0) || null;
  shipment.estimatedArrivalAt = travelMinutes ? new Date(Date.parse(tripAt) + travelMinutes * 60000).toISOString() : null;
};
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
  TRIP: { status: "IN_TRANSIT", label: "Trip", roles: ["admin", "supplier"], from: ["BOOKED"] },
  GATE: { status: null, label: "Gate", roles: ["admin", "security"], from: ["IN_TRANSIT", "RECEIVED"] },
  UNLOADING: { status: "UNLOADING", label: "Unloading", roles: ["admin", "warehouse"], from: ["GATE_IN"] },
  RECEIVED: { status: "RECEIVED", label: "Received", roles: ["admin", "warehouse"], from: ["UNLOADING"] },
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
const publicUser = (user) => ({ id: user.id, name: user.name, username: user.username, email: user.email || "", role: user.role, supplierId: user.supplierId ?? null });
const canAccessShipment = (user, shipment) => user.role !== "supplier" || Number(user.supplierId) === Number(shipment.supplierId);
const supplierHasAccount = (state, supplierId) => state.users.some((user) => user.role === "supplier" && Number(user.supplierId) === Number(supplierId));
const supplierSafeShipment = (shipment) => ({
  ...shipment,
  dppNumber: undefined,
  items: (shipment.items || []).map((item) => ({
    id: item.id,
    materialCode: item.materialCode,
    quantity: item.quantity,
    uom: item.uom,
    palletCount: item.palletCount,
    deliverySite: item.deliverySite || null,
    deliveryWeek: item.deliveryWeek || null,
    supplierApprovedAt: item.supplierApprovedAt || null,
    assignedTruckPlate: item.assignedTruckPlate || null,
  })),
});
const ensureSupplier = (state, name) => {
  const supplierName = String(name || "").trim() || "Supplier to assign";
  let supplier = state.suppliers.find((row) => row.name.toLowerCase() === supplierName.toLowerCase());
  if (!supplier) {
    supplier = { id: nextId(state.suppliers), vendorCode: `TRIAL-${String(nextId(state.suppliers)).padStart(3, "0")}`, name: supplierName, productPresets: [], originAddress: "", originCoordinates: null, routeDistanceKm: null, routeDurationMinutes: null, routeCalculatedAt: null, routeProvider: null };
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
  supplierApprovedAt: data.supplierApprovedAt || null,
  assignedTruckPlate: data.assignedTruckPlate || null,
});

async function createInitialState() {
  const accountRows = [
    ["System Administrator", "admin", "admin123", "admin", null, "admin@dockflow.local"],
    ["Supplier User", "supplier", "supplier123", "supplier", 1, "supplier@dockflow.local"],
    ["Planner User", "planner", "planner123", "planner", null, "planner@dockflow.local"],
    ["Production User", "production", "production123", "production", null, "production@dockflow.local"],
    ["Driver User", "driver", "driver123", "driver", null, "driver@dockflow.local"],
    ["Security User", "security", "security123", "security", null, "security@dockflow.local"],
    ["Warehouse User", "warehouse", "warehouse123", "warehouse", null, "warehouse@dockflow.local"],
  ];
  const users = await Promise.all(accountRows.map(async (row, index) => ({
    id: index + 1,
    name: row[0],
    username: row[1],
    passwordHash: await bcrypt.hash(row[2], 10),
    role: row[3],
    supplierId: row[4],
    email: row[5],
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
    settings: { flexibleScheduling: true, dockCount: 2, graceMinutes: 30, siteName: "Cavite Foods Receiving · Trial", siteAddress: "", siteCoordinates: null, availableDates: dates, availableSlots: defaultAvailabilityForDates(dates) },
    users,
    suppliers: [
      { id: 1, vendorCode: "TRIAL-001", name: "Trial Ingredients Supplier", productPresets: [{ id: 1, materialCode: "65013575", uom: "KG", defaultAmount: 300 }, { id: 2, materialCode: "65013507", uom: "KG", defaultAmount: 500 }] },
      { id: 2, vendorCode: "TRIAL-002", name: "Trial Packaging Supplier", productPresets: [{ id: 3, materialCode: "65013743", uom: "PC", defaultAmount: 18480 }] },
      { id: 3, vendorCode: "TRIAL-003", name: "Trial Starch Supplier", productPresets: [{ id: 4, materialCode: "65013333", uom: "KG", defaultAmount: 600 }] },
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
  state.version = 9;
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
    if (user.username === "management") user.username = "planner";
    if (user.name === "Management Administrator") user.name = "Planner User";
    if (user.username === "planner") user.role = "planner";
    user.role = ["admin", "planner", "production", "supplier", "driver", "security", "warehouse"].includes(user.role) ? user.role : "admin";
    user.email = String(user.email || `${user.username}@dockflow.local`).trim().toLowerCase();
    if (!user.passwordHash && user.password) user.passwordHash = await bcrypt.hash(String(user.password), 10);
    if (!user.passwordHash) user.passwordHash = await bcrypt.hash(`${user.username}123`, 10);
    delete user.password;
  }
  if (!state.users.some((user) => user.role === "production")) state.users.push({ id: nextId(state.users), name: "Production User", username: "production", email: "production@dockflow.local", passwordHash: await bcrypt.hash("production123", 10), role: "production", supplierId: null });
  state.settings.dockCount = 2;
  state.settings.flexibleScheduling = true;
  state.settings.graceMinutes = Number(state.settings.graceMinutes ?? 30);
  state.settings.deliveryCodeSequence = Number(state.settings.deliveryCodeSequence || Math.max(0, ...state.shipments.map((shipment) => Number(String(shipment.deliveryCode || "").split("-").at(-1)) || 0)));
  state.settings.siteName = String(state.settings.siteName || "Cavite Foods Receiving · Trial");
  state.settings.siteAddress = String(state.settings.siteAddress || "");
  state.settings.siteCoordinates = validCoordinates(state.settings.siteCoordinates) ? { lat: Number(state.settings.siteCoordinates.lat), lon: Number(state.settings.siteCoordinates.lon) } : null;
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
    supplier.originAddress = String(supplier.originAddress || "");
    supplier.originCoordinates = validCoordinates(supplier.originCoordinates) ? { lat: Number(supplier.originCoordinates.lat), lon: Number(supplier.originCoordinates.lon) } : null;
    supplier.routeDistanceKm = Number(supplier.routeDistanceKm || 0) || null;
    supplier.routeDurationMinutes = Number(supplier.routeDurationMinutes || 0) || null;
    supplier.routeCalculatedAt = supplier.routeCalculatedAt || null;
    supplier.routeProvider = supplier.routeProvider || null;
    supplier.productPresets = Array.isArray(supplier.productPresets) ? supplier.productPresets.map((preset) => ({ id: Number(preset.id) || nextPresetId++, materialCode: String(preset.materialCode || preset.name || `CODE-${nextPresetId}`).trim().toUpperCase(), uom: String(preset.uom || "KG"), defaultAmount: Number(preset.defaultAmount || 0) })) : [];
    if (!supplier.productPresets.length) {
      const matchingMaterials = state.shipments.filter((shipment) => shipment.supplier === supplier.name).flatMap((shipment) => shipment.items || []);
      const seen = new Set();
      supplier.productPresets = matchingMaterials.filter((item) => item.materialCode && !seen.has(item.materialCode.toLowerCase()) && seen.add(item.materialCode.toLowerCase())).slice(0, 8).map((item) => ({ id: nextPresetId++, materialCode: item.materialCode, uom: item.uom || "KG", defaultAmount: Number(item.quantity || 0) }));
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
    if (shipment.bookingStatus === "PENDING_APPROVAL") shipment.bookingStatus = "PENDING_SUPPLIER";
    shipment.bookingStatus ||= shipment.status === "REJECTED" ? "REJECTED" : "APPROVED";
    shipment.shipmentNumber ||= nextCode("SHP", shipment.id, shipment.scheduledDate);
    shipment.bookingReceipt ||= nextCode("BKG", shipment.id, shipment.scheduledDate);
    shipment.supplier = String(shipment.supplier || "Supplier to assign");
    shipment.vendorCode = String(shipment.vendorCode || "TRIAL");
    shipment.supplierId = Number(shipment.supplierId) || state.suppliers.find((supplier) => supplier.vendorCode === shipment.vendorCode || supplier.name === shipment.supplier)?.id || null;
    delete shipment.dppNumber;
    shipment.deliveryCode = shipment.deliveryCode || (shipment.bookingStatus === "APPROVED" ? nextCode("DLV", shipment.id, shipment.scheduledDate) : null);
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
    shipment.estimatedTravelMinutes = Number(shipment.estimatedTravelMinutes || 0) || null;
    shipment.estimatedTravelDistanceKm = Number(shipment.estimatedTravelDistanceKm || 0) || null;
    shipment.estimatedArrivalAt ||= null;
    shipment.supplierResponse ||= shipment.bookingStatus === "SUPPLIER_ALTERNATIVE" ? "ALTERNATIVE_PROPOSED" : shipment.bookingStatus === "SUPPLIER_CONFIRMED" || shipment.bookingStatus === "APPROVED" ? "ACCEPTED" : null;
    shipment.supplierResponseReason ||= null;
    shipment.supplierRespondedAt ||= null;
    shipment.alternativeDate ||= null;
    shipment.alternativeTime ||= null;
    shipment.alternativeEndTime ||= null;
    shipment.loadConfirmedAt ||= null;
    shipment.finalDecisionAt ||= null;
    shipment.finalDecisionBy ||= null;
    shipment.sdsProposalId = Number(shipment.sdsProposalId) || shipment.id;
    shipment.confirmedTruckLoads = Array.isArray(shipment.confirmedTruckLoads) ? shipment.confirmedTruckLoads : [];
    shipment.sdsImportIdentity ||= null;
    shipment.sdsImportFingerprint ||= null;
    if (shipment.tripAt && !shipment.estimatedArrivalAt) applyShipmentEta(state, shipment, shipment.tripAt);
    if (legacyStatus === "RECEIVED" && shipment.completedAt) shipment.status = "GATE_OUT";
    shipment.lastProcessAt ||= shipment.gateOutAt || shipment.receivedAt || shipment.unloadingAt || shipment.gateInAt || shipment.tripAt || null;
  }
  state.rdsRequests = [];
  syncAvailableDates(state);
});
const activeAccountRoles = new Map((await store.read()).users.map((user) => [Number(user.id), user.role]));
const initialDatabaseStatus = await database.initialize();

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
  limits: { fileSize: 25 * 1024 * 1024, files: 1 },
  fileFilter: (_request, file, callback) => callback(null, [".xlsx", ".xlsm", ".xls", ".xlsb", ".xltx", ".xltm", ".ods", ".csv", ".tsv"].includes(extname(file.originalname).toLowerCase())),
});

const requestIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
app.use((request, response, next) => {
  const incomingId = String(request.headers["x-request-id"] || "");
  request.id = requestIdPattern.test(incomingId) ? incomingId : randomUUID();
  response.setHeader("X-Request-ID", request.id);
  const started = process.hrtime.bigint();
  const originalJson = response.json.bind(response);
  response.json = (body) => {
    if (response.statusCode >= 400 && body?.message) request.apiErrorMessage = String(body.message).slice(0, 500);
    const responseBody = response.statusCode >= 400 && body && typeof body === "object" && !Array.isArray(body) ? { ...body, requestId: body.requestId || request.id } : body;
    return originalJson(responseBody);
  };
  response.on("finish", () => {
    if (request.path === "/api/health" && String(process.env.LOG_HEALTH_REQUESTS || "false").toLowerCase() !== "true") return;
    const durationMs = Math.max(0, Math.round(Number(process.hrtime.bigint() - started) / 1e6));
    const anonymousFingerprint = createHash("sha256").update(`${request.ip || "unknown"}|${request.get("user-agent") || "unknown"}`).digest("hex").slice(0, 20);
    const sessionKey = request.sessionId ? `session:${request.sessionId}` : `anonymous:${anonymousFingerprint}:${localDate()}`;
    void database.logApiRequest({ requestId: request.id, sessionKey, method: request.method, route: request.path, statusCode: response.statusCode, durationMs, userId: request.user?.id, userRole: request.user?.role, ipAddress: request.ip, userAgent: request.get("user-agent"), errorMessage: request.apiErrorMessage }).catch((error) => console.error(`[database] API activity summary failed: ${error.message}`));
  });
  next();
});

app.set("trust proxy", 1);
app.use(helmet({ crossOriginResourcePolicy: false }));
app.use(cors({
  origin(origin, callback) {
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
    const error = new Error("This origin is not allowed to call DockFlow");
    error.status = 403;
    callback(error);
  },
  credentials: true,
  methods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Authorization", "Content-Type", "X-Request-ID"],
  exposedHeaders: ["X-Request-ID", "RateLimit", "RateLimit-Policy"],
}));
app.use(express.json({ limit: "2mb" }));

const asyncRoute = (handler) => (request, response, next) => Promise.resolve(handler(request, response, next)).catch(next);
const rateLimitHandler = (request, response) => response.status(429).json({ message: "Too many API requests. Please wait and try again.", requestId: request.id });
const apiLimiter = rateLimit({ windowMs: Number(process.env.API_RATE_LIMIT_WINDOW_MS || 60000), limit: Number(process.env.API_RATE_LIMIT_MAX || 300), standardHeaders: "draft-8", legacyHeaders: false, handler: rateLimitHandler });
const loginLimiter = rateLimit({ windowMs: Number(process.env.LOGIN_RATE_LIMIT_WINDOW_MS || 15 * 60000), limit: Number(process.env.LOGIN_RATE_LIMIT_MAX || 10), standardHeaders: "draft-8", legacyHeaders: false, skipSuccessfulRequests: true, handler: rateLimitHandler });
const refreshLimiter = rateLimit({ windowMs: Number(process.env.REFRESH_RATE_LIMIT_WINDOW_MS || 15 * 60000), limit: Number(process.env.REFRESH_RATE_LIMIT_MAX || 30), standardHeaders: "draft-8", legacyHeaders: false, handler: rateLimitHandler });
app.use("/api", apiLimiter);

const parseCookies = (request) => Object.fromEntries(String(request.headers.cookie || "").split(";").map((item) => item.trim()).filter(Boolean).map((item) => { const index = item.indexOf("="); return [decodeURIComponent(index >= 0 ? item.slice(0, index) : item), decodeURIComponent(index >= 0 ? item.slice(index + 1) : "")]; }));
const refreshCookieOptions = { httpOnly: true, sameSite: "strict", secure: COOKIE_SECURE, path: "/api/auth", maxAge: REFRESH_TOKEN_DAYS * 86400000 };
const signAccessToken = (user, sessionId) => jwt.sign({ id: user.id, role: user.role, supplierId: user.supplierId, name: user.name, sid: sessionId, type: "access" }, ACCESS_TOKEN_SECRET, { expiresIn: ACCESS_TOKEN_TTL, jwtid: randomUUID() });
const issueSession = async (user, request, response, existingSessionId = null) => {
  const sessionId = existingSessionId || randomUUID();
  const tokenId = randomUUID();
  const refreshToken = jwt.sign({ id: user.id, role: user.role, supplierId: user.supplierId, sid: sessionId, type: "refresh" }, REFRESH_TOKEN_SECRET, { expiresIn: `${REFRESH_TOKEN_DAYS}d`, jwtid: tokenId });
  await database.saveRefreshToken({ tokenId, tokenHash: hashToken(refreshToken), userId: user.id, expiresAt: new Date(Date.now() + REFRESH_TOKEN_DAYS * 86400000).toISOString(), ipAddress: request.ip, userAgent: request.get("user-agent") });
  response.cookie(REFRESH_COOKIE, refreshToken, refreshCookieOptions);
  request.sessionId = sessionId;
  const accessToken = signAccessToken(user, sessionId);
  return { token: accessToken, accessToken, accessTokenExpiresIn: ACCESS_TOKEN_TTL, user: publicUser(user) };
};
const auth = (request, response, next) => {
  const token = request.headers.authorization?.replace(/^Bearer\s+/i, "");
  if (!token) return response.status(401).json({ message: "Authentication required" });
  try {
    const payload = jwt.verify(token, ACCESS_TOKEN_SECRET);
    if (payload.type !== "access") throw new Error("Wrong token type");
    if (activeAccountRoles.get(Number(payload.id)) !== payload.role) throw new Error("Account no longer exists or its role changed");
    request.user = payload;
    request.sessionId = payload.sid || payload.jti;
    next();
  } catch { response.status(401).json({ message: "Session expired" }); }
};
const allow = (...roles) => (request, response, next) => roles.includes(request.user.role) ? next() : response.status(403).json({ message: "This action is not available for your role" });

app.get("/api/health", asyncRoute(async (_request, response) => response.json({ status: "ok", primaryStorage: "json", database: database.enabled ? await database.health() : initialDatabaseStatus })));

app.post("/api/auth/login", loginLimiter, asyncRoute(async (request, response) => {
  const state = await store.read();
  const user = state.users.find((row) => row.username.toLowerCase() === String(request.body?.username || "").toLowerCase());
  if (!user || !await bcrypt.compare(String(request.body?.password || ""), user.passwordHash)) return response.status(401).json({ message: "Incorrect username or password" });
  request.user = publicUser(user);
  response.json(await issueSession(user, request, response));
}));

app.post("/api/auth/refresh", refreshLimiter, asyncRoute(async (request, response) => {
  const refreshToken = parseCookies(request)[REFRESH_COOKIE];
  if (!refreshToken) return response.status(401).json({ message: "Refresh token is missing" });
  try {
    const payload = jwt.verify(refreshToken, REFRESH_TOKEN_SECRET);
    if (payload.type !== "refresh" || !payload.jti || !await database.findRefreshToken(payload.jti, hashToken(refreshToken))) throw new Error("Refresh token is invalid");
    const state = await store.read();
    const user = state.users.find((row) => Number(row.id) === Number(payload.id));
    if (!user) throw new Error("Account no longer exists");
    request.user = publicUser(user);
    await database.revokeRefreshToken(payload.jti);
    response.json(await issueSession(user, request, response, payload.sid || null));
  } catch {
    response.clearCookie(REFRESH_COOKIE, { ...refreshCookieOptions, maxAge: undefined });
    response.status(401).json({ message: "Refresh token expired or was revoked" });
  }
}));

app.post("/api/auth/logout", asyncRoute(async (request, response) => {
  const refreshToken = parseCookies(request)[REFRESH_COOKIE];
  if (refreshToken) {
    const payload = jwt.decode(refreshToken);
    if (payload?.jti) { request.user = payload; request.sessionId = payload.sid || payload.jti; await database.revokeRefreshToken(payload.jti); }
  }
  response.clearCookie(REFRESH_COOKIE, { ...refreshCookieOptions, maxAge: undefined });
  response.json({ ok: true });
}));

app.get("/api/bootstrap", auth, asyncRoute(async (_request, response) => {
  const state = await store.read();
  const supplierOnly = _request.user.role === "supplier";
  const shipments = supplierOnly ? state.shipments.filter((shipment) => Number(shipment.supplierId) === Number(_request.user.supplierId)) : state.shipments;
  const shipmentNumbers = new Set(shipments.map((shipment) => shipment.shipmentNumber));
  response.json({
    shipments: shipments.map((shipment) => {
      const linked = supplierHasAccount(state, shipment.supplierId);
      return supplierOnly ? { ...supplierSafeShipment(shipment), supplierAccountLinked: linked } : { ...shipment, supplierAccountLinked: linked };
    }).sort((a, b) => `${a.scheduledDate}${a.scheduledTime}`.localeCompare(`${b.scheduledDate}${b.scheduledTime}`)),
    rdsRequests: supplierOnly ? [] : state.rdsRequests,
    materials: supplierOnly ? [] : state.materials,
    suppliers: supplierOnly ? state.suppliers.filter((supplier) => Number(supplier.id) === Number(_request.user.supplierId)) : state.suppliers,
    users: _request.user.role === "admin" ? state.users.map(publicUser) : [],
    audit: supplierOnly ? state.audit.filter((entry) => !entry.shipmentNumber || shipmentNumbers.has(entry.shipmentNumber)) : state.audit,
    importBatches: supplierOnly ? [] : state.importBatches,
    settings: { ...state.settings, dockCount: 2 },
  });
}));

app.get("/api/admin/database", auth, allow("admin"), asyncRoute(async (_request, response) => {
  response.json({ database: await database.health(), trialRecords: await database.listTrialRecords() });
}));

app.post("/api/admin/database/trials", auth, allow("admin"), asyncRoute(async (request, response) => {
  const trialKey = String(request.body?.trialKey || "").trim();
  const status = String(request.body?.status || "ACTIVE").trim().toUpperCase();
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{1,119}$/.test(trialKey)) return response.status(400).json({ message: "Trial key must be 2–120 letters, numbers, hyphens, or underscores" });
  if (!["ACTIVE", "PASSED", "FAILED", "ARCHIVED"].includes(status)) return response.status(400).json({ message: "Trial status must be ACTIVE, PASSED, FAILED, or ARCHIVED" });
  response.status(201).json(await database.upsertTrialRecord({ trialKey, status, payload: request.body?.payload, notes: String(request.body?.notes || "").trim() }));
}));

app.all("/api/rds", auth, (_request, response) => response.status(410).json({ message: "Manual delivery requests were replaced by the SDS supplier-confirmation workflow" }));
app.post("/api/shipments", auth, (_request, response) => response.status(410).json({ message: "Deliveries are created from an imported SDS, not from a manual request" }));

app.patch("/api/shipments/:id/supplier-response", auth, allow("supplier"), asyncRoute(async (request, response) => {
  const decision = String(request.body?.decision || "").toUpperCase();
  const reason = String(request.body?.reason || "").trim();
  const alternativeDate = String(request.body?.alternativeDate || "");
  const alternativeTime = String(request.body?.alternativeTime || "").slice(0, 5);
  const alternativeEndTime = String(request.body?.alternativeEndTime || "").slice(0, 5);
  const trucks = Array.isArray(request.body?.trucks) ? request.body.trucks : [];
  if (!["ACCEPT", "PROPOSE_ALTERNATIVE"].includes(decision)) return response.status(400).json({ message: "Accept the proposed time or propose one alternative" });
  if (!request.body?.loadConfirmed) return response.status(400).json({ message: "Confirm that the material load is correctly divided between the trucks" });
  if (decision === "PROPOSE_ALTERNATIVE" && (!reason || !validDate(alternativeDate) || !validTime(alternativeTime) || !validTime(alternativeEndTime) || toMinutes(alternativeEndTime) <= toMinutes(alternativeTime))) return response.status(400).json({ message: "A reason, alternative date, start time, and later end time are required" });
  if (!trucks.length) return response.status(400).json({ message: "Add a truck plate and select at least one material code" });
  const normalizedTrucks = trucks.map((truck) => ({
    truckPlate: String(truck?.truckPlate || "").trim().toUpperCase(),
    driverName: String(truck?.driverName || "").trim() || "To be assigned",
    driverPhone: String(truck?.driverPhone || "").trim(),
    itemIds: [...new Set((Array.isArray(truck?.itemIds) ? truck.itemIds : []).map(Number).filter(Number.isFinite))],
  }));
  if (normalizedTrucks.some((truck) => !truck.truckPlate || !truck.itemIds.length)) return response.status(400).json({ message: "Every truck needs a plate number and at least one material code" });
  if (new Set(normalizedTrucks.map((truck) => truck.truckPlate)).size !== normalizedTrucks.length) return response.status(400).json({ message: "Each truck plate must be unique" });
  if (normalizedTrucks.some((truck) => truck.driverPhone && !/^\d{7,15}$/.test(truck.driverPhone))) return response.status(400).json({ message: "Driver phone numbers must contain 7–15 digits only" });
  const result = await store.update((state) => {
    const proposal = state.shipments.find((shipment) => shipment.id === Number(request.params.id));
    if (!proposal) return null;
    if (!canAccessShipment(request.user, proposal)) return { forbidden: true };
    if (proposal.bookingStatus !== "PENDING_SUPPLIER") return { alreadyResponded: true };
    const expectedIds = new Set(proposal.items.map((item) => Number(item.id)));
    const existingLoads = Array.isArray(proposal.confirmedTruckLoads) ? proposal.confirmedTruckLoads : [];
    const alreadyAssignedIds = new Set(existingLoads.flatMap((truck) => truck.itemIds).map(Number));
    const assignedIds = normalizedTrucks.flatMap((truck) => truck.itemIds);
    if (new Set(assignedIds).size !== assignedIds.length || assignedIds.some((id) => !expectedIds.has(id) || alreadyAssignedIds.has(id))) return { invalidAssignment: true };
    if (normalizedTrucks.some((truck) => existingLoads.some((saved) => saved.truckPlate === truck.truckPlate))) return { duplicatePlate: true };
    const respondedAt = new Date().toISOString();
    const proposalId = proposal.id;
    if (!existingLoads.length) {
      proposal.supplierResponse = decision === "ACCEPT" ? "ACCEPTED" : "ALTERNATIVE_PROPOSED";
      proposal.supplierResponseReason = decision === "PROPOSE_ALTERNATIVE" ? reason : null;
      proposal.supplierRespondedAt = respondedAt;
      proposal.alternativeDate = decision === "PROPOSE_ALTERNATIVE" ? alternativeDate : null;
      proposal.alternativeTime = decision === "PROPOSE_ALTERNATIVE" ? alternativeTime : null;
      proposal.alternativeEndTime = decision === "PROPOSE_ALTERNATIVE" ? alternativeEndTime : null;
    }
    const newLoads = normalizedTrucks.map((truck, index) => ({ id: existingLoads.length + index + 1, deliveryCode: issueDeliveryCode(state, proposal.scheduledDate), ...truck, confirmedAt: respondedAt }));
    proposal.confirmedTruckLoads = [...existingLoads, ...newLoads];
    for (const load of newLoads) for (const item of proposal.items.filter((row) => load.itemIds.includes(Number(row.id)))) {
      item.supplierApprovedAt = respondedAt;
      item.assignedTruckPlate = load.truckPlate;
    }
    proposal.loadConfirmedAt = respondedAt;
    const allLoads = proposal.confirmedTruckLoads;
    const remainingItemIds = proposal.items.map((item) => Number(item.id)).filter((id) => !allLoads.some((load) => load.itemIds.includes(id)));
    for (const load of newLoads) addAudit(state, request.user, "SDS_TRUCK_CONFIRMED", `${load.deliveryCode} reserved for ${load.truckPlate} with ${load.itemIds.length} material code(s)`, proposal.shipmentNumber);
    if (remainingItemIds.length) return { partial: true, confirmedLoads: allLoads, remainingMaterialCount: remainingItemIds.length, bookingStatus: proposal.bookingStatus };

    const baseItems = proposal.items.map((item) => ({ ...item }));
    const deliveries = [];
    allLoads.forEach((load, index) => {
      const delivery = index === 0 ? proposal : { ...proposal, id: nextId(state.shipments), items: [], palletIds: [] };
      delivery.items = baseItems.filter((item) => load.itemIds.includes(Number(item.id))).map((item) => ({ ...item }));
      delivery.shipmentNumber = nextCode("SHP", delivery.id, proposal.scheduledDate);
      delivery.bookingReceipt = nextCode("BKG", delivery.id, proposal.scheduledDate);
      delivery.deliveryCode = load.deliveryCode;
      delivery.truckPlate = load.truckPlate;
      delivery.driverName = load.driverName;
      delivery.driverPhone = load.driverPhone;
      delivery.sdsProposalId = proposalId;
      delivery.supplierResponse = proposal.supplierResponse;
      delivery.supplierResponseReason = proposal.supplierResponseReason;
      delivery.supplierRespondedAt = proposal.supplierRespondedAt;
      delivery.loadConfirmedAt = load.confirmedAt;
      delivery.alternativeDate = proposal.alternativeDate;
      delivery.alternativeTime = proposal.alternativeTime;
      delivery.alternativeEndTime = proposal.alternativeEndTime;
      delivery.bookingStatus = proposal.supplierResponse === "ALTERNATIVE_PROPOSED" ? "SUPPLIER_ALTERNATIVE" : "SUPPLIER_CONFIRMED";
      delivery.status = "BOOKED";
      delivery.confirmedTruckLoads = [];
      delivery.materialWeightKg = delivery.items.reduce((sum, item) => sum + (item.uom === "KG" ? item.quantity : item.uom === "MT" ? item.quantity * 1000 : 0), 0);
      delivery.palletsTotal = delivery.items.reduce((sum, item) => sum + Number(item.palletCount || 0), 0);
      if (index > 0) state.shipments.push(delivery);
      deliveries.push({ id: delivery.id, shipmentNumber: delivery.shipmentNumber, deliveryCode: delivery.deliveryCode, truckPlate: delivery.truckPlate });
    });
    return { partial: false, deliveries, remainingMaterialCount: 0, bookingStatus: proposal.bookingStatus };
  });
  if (!result) return response.status(404).json({ message: "SDS proposal not found" });
  if (result.forbidden) return response.status(403).json({ message: "This SDS proposal belongs to another supplier" });
  if (result.alreadyResponded) return response.status(409).json({ message: "This SDS proposal already has a supplier response" });
  if (result.invalidAssignment) return response.status(400).json({ message: "Select unconfirmed material codes only; a material can belong to one truck" });
  if (result.duplicatePlate) return response.status(409).json({ message: "That truck plate is already confirmed for this SDS proposal" });
  response.json(result);
}));

app.patch("/api/shipments/:id/final-decision", auth, allow(...planningRoles), asyncRoute(async (request, response) => {
  const decision = String(request.body?.decision || "").toUpperCase();
  const reason = String(request.body?.reason || "").trim();
  if (!["APPROVE", "REJECT"].includes(decision)) return response.status(400).json({ message: "Choose approve or reject" });
  if (decision === "REJECT" && !reason) return response.status(400).json({ message: "Enter the final rejection reason" });
  const result = await store.update((state) => {
    const selected = state.shipments.find((shipment) => shipment.id === Number(request.params.id));
    if (!selected) return null;
    const proposalId = Number(selected.sdsProposalId || selected.id);
    const group = state.shipments.filter((shipment) => Number(shipment.sdsProposalId || shipment.id) === proposalId);
    if (!group.every((shipment) => ["SUPPLIER_CONFIRMED", "SUPPLIER_ALTERNATIVE"].includes(shipment.bookingStatus))) return { notReady: true };
    const decidedAt = new Date().toISOString();
    for (const shipment of group) {
      if (decision === "APPROVE" && shipment.bookingStatus === "SUPPLIER_ALTERNATIVE") {
        shipment.scheduledDate = shipment.alternativeDate;
        shipment.scheduledTime = shipment.alternativeTime;
        shipment.scheduledEndTime = shipment.alternativeEndTime;
        shipment.timeSlot = scheduleLabel(shipment.scheduledTime, shipment.scheduledEndTime);
        shipment.expectedDurationMinutes = durationMinutes(shipment.scheduledTime, shipment.scheduledEndTime);
      }
      shipment.bookingStatus = decision === "APPROVE" ? "APPROVED" : "REJECTED";
      shipment.status = decision === "APPROVE" ? "BOOKED" : "REJECTED";
      shipment.rejectionReason = decision === "REJECT" ? reason : null;
      shipment.finalDecisionAt = decidedAt;
      shipment.finalDecisionBy = request.user.name;
      addAudit(state, request.user, decision === "APPROVE" ? "SDS_FINAL_APPROVAL" : "SDS_FINAL_REJECTION", `${shipment.deliveryCode} ${decision === "APPROVE" ? "approved" : `rejected: ${reason}`}`, shipment.shipmentNumber);
    }
    return { ok: true, bookingStatus: group[0].bookingStatus, deliveryCount: group.length };
  });
  if (!result) return response.status(404).json({ message: "Delivery proposal not found" });
  if (result.notReady) return response.status(409).json({ message: "The supplier must confirm the truck load and proposed or alternative time first" });
  response.json(result);
}));

app.patch("/api/shipments/:id/schedule", auth, allow(...planningRoles), asyncRoute(async (request, response) => {
  const scheduledDate = String(request.body?.scheduledDate || "");
  const scheduledTime = String(request.body?.scheduledTime || "").slice(0, 5);
  const scheduledEndTime = String(request.body?.scheduledEndTime || "").slice(0, 5);
  if (!validDate(scheduledDate) || !validTime(scheduledTime) || !validTime(scheduledEndTime) || toMinutes(scheduledEndTime) <= toMinutes(scheduledTime)) return response.status(400).json({ message: "Choose a valid date and an end time later than the start time" });
  const result = await store.update((state) => {
    const shipment = state.shipments.find((row) => row.id === Number(request.params.id));
    if (!shipment) return null;
    if (shipment.status !== "BOOKED") return { locked: true };
    const previous = `${shipment.scheduledDate} ${shipment.scheduledTime}–${shipment.scheduledEndTime || shipment.scheduledTime}`;
    shipment.scheduledDate = scheduledDate;
    shipment.scheduledTime = scheduledTime;
    shipment.scheduledEndTime = scheduledEndTime;
    shipment.expectedDurationMinutes = durationMinutes(scheduledTime, scheduledEndTime);
    shipment.timeSlot = scheduleLabel(scheduledTime, scheduledEndTime);
    shipment.availabilitySlotId = matchingAvailability(state, scheduledDate, scheduledTime, scheduledEndTime)?.id || null;
    addAudit(state, request.user, "BOOKING_RESCHEDULED", `${shipment.shipmentNumber} moved from ${previous} to ${scheduledDate} ${scheduledTime}–${scheduledEndTime}`, shipment.shipmentNumber);
    return { ok: true, shipment };
  });
  if (!result) return response.status(404).json({ message: "Shipment not found" });
  if (result.locked) return response.status(409).json({ message: "Only bookings that have not started their trip can be dragged to another time" });
  response.json(result);
}));

app.post("/api/availability", auth, allow(...planningRoles), asyncRoute(async (request, response) => {
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

app.patch("/api/availability/:id", auth, allow(...planningRoles), asyncRoute(async (request, response) => {
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

app.delete("/api/availability/:id", auth, allow(...planningRoles), asyncRoute(async (request, response) => {
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
    if (stage === "TRIP") { shipment.tripAt ||= scannedAt; shipment.startedAt ||= scannedAt; applyShipmentEta(state, shipment, shipment.tripAt); }
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
  const roleTransitions = { supplier: ["IN_TRANSIT"], security: ["GATE_IN", "GATE_OUT"], warehouse: ["UNLOADING", "RECEIVED"], admin: ["BOOKED", "IN_TRANSIT", "GATE_IN", "UNLOADING", "RECEIVED", "GATE_OUT", "REJECTED"] };
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
    if (status === "IN_TRANSIT") { shipment.tripAt ||= changedAt; shipment.startedAt ||= changedAt; applyShipmentEta(state, shipment, shipment.tripAt); }
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

app.post("/api/imports/excel/preview", auth, allow(...planningRoles), excelUpload.single("file"), asyncRoute(async (request, response) => {
  if (!request.file) return response.status(400).json({ message: "Choose an Excel, OpenDocument, CSV, or TSV file up to 25 MB" });
  const state = await store.read();
  const fallbackDate = state.settings.availableDates[0] || localDate(1);
  const preview = await parseDeliveryWorkbook(request.file.buffer, request.file.originalname, { fallbackDate });
  const accountBySupplier = new Map(state.suppliers.map((supplier) => [supplier.name.trim().toLowerCase(), supplierHasAccount(state, supplier.id)]));
  const missingSupplierAccounts = [...new Set(preview.rows.filter((row) => !accountBySupplier.get(row.supplier.trim().toLowerCase())).map((row) => row.supplier))].sort();
  preview.rows = preview.rows.map((row) => ({ ...row, supplierAccountLinked: Boolean(accountBySupplier.get(row.supplier.trim().toLowerCase())) }));
  preview.missingSupplierAccounts = missingSupplierAccounts;
  preview.summary.missingSupplierAccounts = missingSupplierAccounts.length;
  const previewToken = randomUUID();
  const expiresAt = Date.now() + 30 * 60 * 1000;
  for (const [key, cached] of importPreviews) if (cached.expiresAt < Date.now()) importPreviews.delete(key);
  importPreviews.set(previewToken, { preview, userId: request.user.id, expiresAt });
  response.json({ ...preview, previewToken });
}));

const importHash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const importGroupIdentity = (rows) => importHash({
  supplier: rows[0].supplier.trim().toLowerCase(),
  site: rows[0].site.trim().toLowerCase(),
  week: String(rows[0].week || "").trim().toLowerCase(),
  materialCodes: rows.map((row) => row.materialCode.trim().toUpperCase()).sort(),
});
const importGroupFingerprint = (rows) => importHash(rows.map((row) => ({
  week: String(row.week || "").trim(),
  site: row.site.trim().toLowerCase(),
  supplier: row.supplier.trim().toLowerCase(),
  materialCode: row.materialCode.trim().toUpperCase(),
  uom: row.uom.trim().toUpperCase(),
  quantity: Number(row.quantity || 0),
  date: row.deliveryDate,
  time: row.deliveryTime,
  endTime: row.endTime || null,
})).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))));

app.post("/api/imports/excel/commit", auth, allow(...planningRoles), asyncRoute(async (request, response) => {
  const token = String(request.body?.previewToken || "");
  const cached = importPreviews.get(token);
  if (!cached || cached.userId !== request.user.id || cached.expiresAt < Date.now()) return response.status(410).json({ message: "The import preview expired. Upload the workbook again." });
  const readyRows = cached.preview.rows.filter((row) => row.status === "ready");
  if (!readyRows.length) return response.status(400).json({ message: "No nonblank rows were found to import" });
  if (cached.preview.missingSupplierAccounts?.length) return response.status(409).json({ message: `Create and link a supplier account before importing: ${cached.preview.missingSupplierAccounts.join(", ")}` });
  const result = await store.update((state) => {
    const groups = new Map();
    for (const row of readyRows) {
      const key = row.placeholderFields?.length ? `${row.sheet}|${row.sourceRow}` : `${row.supplier.toLowerCase()}|${row.deliveryDate}|${row.deliveryTime}|${row.endTime || ""}|${row.site.toLowerCase()}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(row);
    }
    const supplierByName = new Map(state.suppliers.map((supplier) => [supplier.name.trim().toLowerCase(), supplier]));
    const missingAccounts = [...new Set([...groups.values()].filter((rows) => {
      const supplier = supplierByName.get(rows[0].supplier.trim().toLowerCase());
      return !supplier || !supplierHasAccount(state, supplier.id);
    }).map((rows) => rows[0].supplier))];
    if (missingAccounts.length) return { missingAccounts };

    const batchId = nextId(state.importBatches);
    let shipmentId = nextId(state.shipments);
    let itemId = Math.max(0, ...state.shipments.flatMap((shipment) => shipment.items || []).map((item) => Number(item.id) || 0)) + 1;
    let createdProposals = 0, updatedProposals = 0, unchangedProposals = 0, importedRows = 0, unchangedRows = 0;
    const notifiedSupplierIds = new Set();

    const buildItems = (rows, previousItems = []) => {
      const reusedIds = new Set();
      return rows.map((row) => {
      const previous = previousItems.find((item) => item.materialCode === row.materialCode && !reusedIds.has(item.id));
      if (previous) reusedIds.add(previous.id);
      if (!state.materials.some((material) => material.code === row.materialCode)) state.materials.push({ id: nextId(state.materials), code: row.materialCode, name: row.materialName, type: row.materialType || "RM", uom: row.uom, shelfLifeDays: 0, unitsPerPallet: 0, storageZone: "To review" });
      return makeItem(previous?.id || itemId++, {
        poNumber: row.poNumber,
        materialCode: row.materialCode,
        materialName: row.materialName,
        quantity: row.quantity,
        uom: row.uom,
        palletCount: 0,
        deliverySite: row.site,
        deliveryWeek: row.week,
        poBalance: row.poBalance,
        poQuantity: row.poQuantity,
        stillToBeDelivered: row.stillToBeDelivered,
        remarks: row.remarks,
      });
    });
    };

    for (const rows of groups.values()) {
      const first = rows[0];
      const supplier = supplierByName.get(first.supplier.trim().toLowerCase());
      const identity = importGroupIdentity(rows);
      const fingerprint = importGroupFingerprint(rows);
      const exact = state.shipments.find((shipment) => shipment.sdsImportFingerprint === fingerprint);
      if (exact) { unchangedProposals += 1; unchangedRows += rows.length; continue; }
      const editableMatches = state.shipments.filter((shipment) => shipment.sdsImportIdentity === identity && shipment.bookingStatus === "PENDING_SUPPLIER" && Number(shipment.sdsProposalId || shipment.id) === Number(shipment.id) && !(shipment.confirmedTruckLoads || []).length);
      const existing = editableMatches.length === 1 ? editableMatches[0] : null;
      const availabilitySlot = ensureAvailabilityForTime(state, first.deliveryDate, first.deliveryTime);
      const items = buildItems(rows, existing?.items || []);
      supplier.productPresets ||= [];
      for (const row of rows) {
        const preset = supplier.productPresets.find((item) => item.materialCode.toUpperCase() === row.materialCode.toUpperCase());
        if (preset) { preset.uom = row.uom; preset.defaultAmount = row.quantity; }
        else supplier.productPresets.push({ id: Math.max(0, ...state.suppliers.flatMap((item) => item.productPresets || []).map((item) => Number(item.id) || 0)) + 1, materialCode: row.materialCode, uom: row.uom, defaultAmount: row.quantity });
      }

      if (existing) {
        existing.scheduledDate = first.deliveryDate;
        existing.scheduledTime = first.deliveryTime;
        existing.scheduledEndTime = first.endTime || null;
        existing.availabilitySlotId = availabilitySlot.id;
        existing.expectedDurationMinutes = first.endTime ? durationMinutes(first.deliveryTime, first.endTime) : null;
        existing.timeSlot = scheduleLabel(first.deliveryTime, first.endTime);
        existing.items = items;
        existing.materialWeightKg = rows.reduce((sum, row) => sum + (row.uom === "KG" ? row.quantity : row.uom === "MT" ? row.quantity * 1000 : 0), 0);
        existing.importBatchId = batchId;
        existing.sdsImportFingerprint = fingerprint;
        existing.confirmedTruckLoads = [];
        updatedProposals += 1;
        importedRows += rows.length;
        notifiedSupplierIds.add(supplier.id);
        addAudit(state, request.user, "SDS_UPDATED", `${existing.shipmentNumber} updated after spreadsheet comparison`, existing.shipmentNumber);
        continue;
      }

      const currentShipmentId = shipmentId++;
      const shipmentNumber = nextCode("SHP", currentShipmentId, first.deliveryDate);
      state.shipments.push({
        id: currentShipmentId, shipmentNumber, bookingReceipt: nextCode("BKG", currentShipmentId, first.deliveryDate), supplier: supplier.name, supplierId: supplier.id,
        deliveryCode: null, vendorCode: supplier.vendorCode, scheduledDate: first.deliveryDate, scheduledTime: first.deliveryTime, scheduledEndTime: first.endTime || null,
        availabilitySlotId: availabilitySlot.id, expectedDurationMinutes: first.endTime ? durationMinutes(first.deliveryTime, first.endTime) : null,
        timeSlot: scheduleLabel(first.deliveryTime, first.endTime), shift: "Flexible date", bookingStatus: "PENDING_SUPPLIER", status: "BOOKED",
        truckPlate: "TO BE ASSIGNED", driverName: "To be assigned", driverPhone: "", materialWeightKg: rows.reduce((sum, row) => sum + (row.uom === "KG" ? row.quantity : row.uom === "MT" ? row.quantity * 1000 : 0), 0),
        dock: null, arrivalTime: null, startedAt: null, completedAt: null, lastProcessAt: null, tripAt: null, gateInAt: null, unloadingAt: null, receivedAt: null, gateOutAt: null,
        rejectionReason: null, supplierResponse: null, supplierResponseReason: null, supplierRespondedAt: null, alternativeDate: null, alternativeTime: null, alternativeEndTime: null,
        loadConfirmedAt: null, finalDecisionAt: null, finalDecisionBy: null, sdsProposalId: currentShipmentId, importBatchId: batchId, importSource: null,
        sdsImportIdentity: identity, sdsImportFingerprint: fingerprint, confirmedTruckLoads: [], items, palletsScanned: 0, palletsTotal: 0, palletIds: [],
      });
      createdProposals += 1;
      importedRows += rows.length;
      notifiedSupplierIds.add(supplier.id);
      addAudit(state, request.user, "SDS_IMPORTED", `${shipmentNumber} created and linked to ${supplier.name}`, shipmentNumber);
    }
    syncAvailableDates(state);
    const deliveryCount = createdProposals + updatedProposals;
    const batch = { id: batchId, fileName: cached.preview.fileName, status: deliveryCount ? "IMPORTED" : "UNCHANGED", totalRows: cached.preview.summary.totalRows, importedRows, unchangedRows, skippedRows: 0, deliveryCount, createdProposals, updatedProposals, unchangedProposals, createdAt: new Date().toISOString(), completedAt: new Date().toISOString(), notificationStatus: "PENDING", notificationsSent: 0, notificationsFailed: 0 };
    state.importBatches.unshift(batch);
    addAudit(state, request.user, "SDS_IMPORT_COMPLETED", `${createdProposals} created, ${updatedProposals} updated, ${unchangedProposals} unchanged after spreadsheet comparison`);
    const recipients = state.users.filter((user) => user.role === "supplier" && notifiedSupplierIds.has(Number(user.supplierId))).map((user) => user.email).filter(Boolean);
    return { batchId, importedRows, unchangedRows, skippedRows: 0, deliveryCount, createdProposals, updatedProposals, unchangedProposals, recipients };
  });
  if (result.missingAccounts) return response.status(409).json({ message: `Create and link a supplier account before importing: ${result.missingAccounts.join(", ")}` });
  importPreviews.delete(token);
  let notification;
  try { notification = await emailNotifications.sendNewSds({ recipients: result.recipients, fileName: cached.preview.fileName, proposalCount: result.deliveryCount }); }
  catch (error) { notification = { status: "FAILED", sent: 0, failed: result.recipients.length }; console.error(`[email] SDS notification failed: ${error.message}`); }
  await store.update((state) => {
    const batch = state.importBatches.find((row) => row.id === result.batchId);
    if (batch) { batch.notificationStatus = notification.status; batch.notificationsSent = notification.sent; batch.notificationsFailed = notification.failed; }
  });
  const { recipients: _recipients, ...publicResult } = result;
  void _recipients;
  response.status(201).json({ ...publicResult, notification });
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
  const roles = ["admin", "planner", "production", "supplier", "driver", "security", "warehouse"];
  const email = String(request.body?.email || "").trim().toLowerCase();
  if (!String(request.body?.name || "").trim() || !String(request.body?.username || "").trim() || String(request.body?.password || "").length < 8 || !roles.includes(request.body?.role) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return response.status(400).json({ message: "Name, username, email, valid role, and an 8-character password are required" });
  const passwordHash = await bcrypt.hash(String(request.body.password), 10);
  const result = await store.update((state) => {
    if (state.users.some((user) => user.username.toLowerCase() === request.body.username.toLowerCase())) return { duplicate: true };
    let supplierId = null;
    if (request.body.role === "supplier") {
      const existing = state.suppliers.find((supplier) => supplier.id === Number(request.body.supplierId));
      const supplier = existing || ensureSupplier(state, request.body.supplierName || request.body.name);
      if (state.users.some((user) => user.role === "supplier" && Number(user.supplierId) === Number(supplier.id))) return { supplierAlreadyLinked: true };
      supplier.productPresets ||= [];
      supplierId = supplier.id;
    }
    const id = nextId(state.users);
    state.users.push({ id, name: String(request.body.name).trim(), username: String(request.body.username).trim().toLowerCase(), email, passwordHash, role: request.body.role, supplierId });
    addAudit(state, request.user, "ACCOUNT_CREATED", `${request.body.role === "supplier" ? "Supplier" : request.body.role} account @${String(request.body.username).trim().toLowerCase()} created`);
    return { id, supplierId };
  });
  if (result.duplicate) return response.status(409).json({ message: "That username already exists" });
  if (result.supplierAlreadyLinked) return response.status(409).json({ message: "That supplier already has an active supplier account" });
  activeAccountRoles.set(Number(result.id), request.body.role);
  response.status(201).json(result);
}));

app.delete("/api/users/:id", auth, allow("admin"), asyncRoute(async (request, response) => {
  const password = String(request.body?.adminPassword || "");
  if (!password) return response.status(400).json({ message: "Enter your administrator password to delete this account" });
  const state = await store.read();
  const currentAdmin = state.users.find((user) => Number(user.id) === Number(request.user.id));
  if (!currentAdmin || !await bcrypt.compare(password, currentAdmin.passwordHash)) return response.status(401).json({ message: "Administrator password is incorrect" });
  const targetId = Number(request.params.id);
  if (targetId === Number(request.user.id)) return response.status(409).json({ message: "You cannot delete the account you are currently using" });
  const result = await store.update((draft) => {
    const index = draft.users.findIndex((user) => Number(user.id) === targetId);
    if (index < 0) return null;
    const target = draft.users[index];
    if (target.role === "admin" && draft.users.filter((user) => user.role === "admin").length <= 1) return { finalAdmin: true };
    draft.users.splice(index, 1);
    addAudit(draft, request.user, "ACCOUNT_DELETED", `Account @${target.username} was deleted; supplier and delivery records were retained`);
    return { ok: true, deletedUserId: target.id, retainedSupplierId: target.supplierId || null };
  });
  if (!result) return response.status(404).json({ message: "Account not found" });
  if (result.finalAdmin) return response.status(409).json({ message: "The final administrator account cannot be deleted" });
  activeAccountRoles.delete(targetId);
  await database.revokeUserRefreshTokens(targetId);
  response.json(result);
}));

app.patch("/api/settings/site-address", auth, allow("admin"), asyncRoute(async (request, response) => {
  const address = String(request.body?.siteAddress || "").trim();
  if (address.length < 6) return response.status(400).json({ message: "Enter the complete receiving-site address" });
  let coordinates;
  try { coordinates = await geocodeAddress(address); }
  catch (error) { return response.status(502).json({ message: `ETA address lookup failed: ${error.message}` }); }
  const result = await store.update((state) => {
    state.settings.siteAddress = address;
    state.settings.siteCoordinates = { lat: coordinates.lat, lon: coordinates.lon };
    for (const supplier of state.suppliers) {
      supplier.routeDistanceKm = null;
      supplier.routeDurationMinutes = null;
      supplier.routeCalculatedAt = null;
      supplier.routeProvider = null;
    }
    addAudit(state, request.user, "RECEIVING_ADDRESS_UPDATED", `Receiving-site address updated to ${coordinates.displayName}`);
    return { ok: true, siteAddress: address, siteCoordinates: state.settings.siteCoordinates, matchedAddress: coordinates.displayName };
  });
  response.json(result);
}));

app.patch("/api/suppliers/:id/route", auth, allow("admin"), asyncRoute(async (request, response) => {
  const originAddress = String(request.body?.originAddress || "").trim();
  if (originAddress.length < 6) return response.status(400).json({ message: "Enter the supplier's complete dispatch address" });
  const state = await store.read();
  const supplier = state.suppliers.find((row) => Number(row.id) === Number(request.params.id));
  if (!supplier) return response.status(404).json({ message: "Supplier not found" });
  if (!state.settings.siteAddress) return response.status(409).json({ message: "Save the receiving-site address first" });
  try {
    const [origin, destination] = await Promise.all([
      geocodeAddress(originAddress),
      validCoordinates(state.settings.siteCoordinates) ? Promise.resolve({ ...state.settings.siteCoordinates, displayName: state.settings.siteAddress }) : geocodeAddress(state.settings.siteAddress),
    ]);
    const route = await calculateRoute(origin, destination);
    const result = await store.update((draft) => {
      const currentSupplier = draft.suppliers.find((row) => Number(row.id) === Number(request.params.id));
      if (!currentSupplier) return null;
      currentSupplier.originAddress = originAddress;
      currentSupplier.originCoordinates = { lat: origin.lat, lon: origin.lon };
      currentSupplier.routeDistanceKm = route.distanceKm;
      currentSupplier.routeDurationMinutes = route.durationMinutes;
      currentSupplier.routeCalculatedAt = new Date().toISOString();
      currentSupplier.routeProvider = "OpenStreetMap / OSRM · no traffic";
      if (!validCoordinates(draft.settings.siteCoordinates)) draft.settings.siteCoordinates = { lat: destination.lat, lon: destination.lon };
      addAudit(draft, request.user, "SUPPLIER_ETA_UPDATED", `${currentSupplier.name} route estimated at ${route.distanceKm} km / ${route.durationMinutes} minutes without traffic`);
      return { ok: true, supplier: currentSupplier, matchedOrigin: origin.displayName, matchedDestination: destination.displayName };
    });
    response.json(result);
  } catch (error) {
    response.status(502).json({ message: `ETA calculation failed: ${error.message}` });
  }
}));

app.patch("/api/suppliers/:id/presets", auth, allow("admin"), asyncRoute(async (request, response) => {
  const result = await store.update((state) => {
    const supplier = state.suppliers.find((row) => row.id === Number(request.params.id));
    if (!supplier) return null;
    const presets = Array.isArray(request.body?.presets) ? request.body.presets : [];
    let presetId = Math.max(0, ...state.suppliers.flatMap((row) => row.productPresets || []).map((preset) => Number(preset.id) || 0)) + 1;
    supplier.productPresets = presets.map((preset) => ({
      id: Number(preset.id) || presetId++,
      materialCode: String(preset.materialCode || "").trim().toUpperCase(),
      uom: String(preset.uom || "KG").trim().toUpperCase(),
      defaultAmount: Math.max(0, Number(preset.defaultAmount || 0)),
    })).filter((preset) => preset.materialCode);
    addAudit(state, request.user, "SUPPLIER_PRESETS_UPDATED", `${supplier.name} now has ${supplier.productPresets.length} preset delivery product${supplier.productPresets.length === 1 ? "" : "s"}`);
    return { ok: true, presets: supplier.productPresets };
  });
  if (!result) return response.status(404).json({ message: "Supplier not found" });
  response.json(result);
}));

app.patch("/api/settings", auth, allow("admin"), asyncRoute(async (request, response) => {
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

app.get("/api/reports/export.xlsx", auth, allow("admin", "supplier"), asyncRoute(async (request, response) => {
  const state = await store.read();
  const requestedSupplierId = request.user.role === "supplier" ? Number(request.user.supplierId) : Number(request.query.supplierId || 0);
  const shipments = state.shipments.filter((shipment) => shipment.bookingStatus === "APPROVED" && shipment.status !== "REJECTED" && (!requestedSupplierId || Number(shipment.supplierId) === requestedSupplierId));
  const duration = (start, end) => start && end ? Math.max(0, Math.round((Date.parse(end) - Date.parse(start)) / 60000)) : null;
  const average = (values) => {
    const valid = values.filter((value) => Number.isFinite(value));
    return valid.length ? Math.round(valid.reduce((sum, value) => sum + value, 0) / valid.length) : 0;
  };
  const supplierGroups = new Map();
  for (const shipment of shipments) {
    const key = String(shipment.supplierId || shipment.supplier);
    if (!supplierGroups.has(key)) supplierGroups.set(key, { supplier: shipment.supplier, rows: [] });
    supplierGroups.get(key).rows.push(shipment);
  }
  const summaryRows = [...supplierGroups.values()].map(({ supplier, rows }) => ({
    supplier,
    approved: rows.length,
    complete: rows.filter((shipment) => shipment.status === "GATE_OUT").length,
    trip: average(rows.map((shipment) => duration(shipment.tripAt, shipment.gateInAt))),
    unload: average(rows.map((shipment) => duration(shipment.unloadingAt, shipment.receivedAt))),
    turnaround: average(rows.map((shipment) => duration(shipment.gateInAt, shipment.gateOutAt))),
  })).sort((a, b) => a.supplier.localeCompare(b.supplier));
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "DockFlow";
  workbook.created = new Date();
  workbook.calcProperties.fullCalcOnLoad = true;
  const navy = "0B1E38", blue = "246BFD", paleBlue = "EDF4FF", paleTeal = "EAF8F5", line = "D8E1ED", ink = "17263D", muted = "607089";
  const thinBorder = { top: { style: "thin", color: { argb: line } }, left: { style: "thin", color: { argb: line } }, bottom: { style: "thin", color: { argb: line } }, right: { style: "thin", color: { argb: line } } };
  const titleSheet = (sheet, title, subtitle, lastColumn) => {
    sheet.views = [{ state: "frozen", ySplit: 7, showGridLines: false }];
    sheet.mergeCells(`A1:${lastColumn}1`);
    sheet.getCell("A1").value = title;
    sheet.getCell("A1").font = { name: "Aptos Display", size: 20, bold: true, color: { argb: "FFFFFF" } };
    sheet.getCell("A1").fill = { type: "pattern", pattern: "solid", fgColor: { argb: navy } };
    sheet.getCell("A1").alignment = { vertical: "middle" };
    sheet.getRow(1).height = 34;
    sheet.mergeCells(`A2:${lastColumn}2`);
    sheet.getCell("A2").value = subtitle;
    sheet.getCell("A2").font = { name: "Aptos", size: 10, color: { argb: muted } };
    sheet.getRow(2).height = 22;
  };

  const summary = workbook.addWorksheet("Delivery Report", { pageSetup: { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0 } });
  summary.columns = [{ width: 30 }, { width: 20 }, { width: 20 }, { width: 21 }, { width: 18 }, { width: 23 }];
  const selectedSupplier = state.suppliers.find((supplier) => Number(supplier.id) === requestedSupplierId)?.name || "All suppliers";
  const generated = new Intl.DateTimeFormat("en-PH", { dateStyle: "medium", timeStyle: "short", timeZone: TIME_ZONE }).format(new Date());
  titleSheet(summary, "DockFlow Delivery Performance Report", `${selectedSupplier}  •  Generated ${generated}  •  Asia/Manila (GMT+8)`, "F");
  const completedCount = shipments.filter((shipment) => shipment.status === "GATE_OUT").length;
  const kpis = [["APPROVED DELIVERIES", shipments.length], ["GATE-OUT COMPLETE", completedCount], ["AVG UNLOADING", `${average(shipments.map((shipment) => duration(shipment.unloadingAt, shipment.receivedAt)))} min`]];
  kpis.forEach(([label, value], index) => {
    const start = index * 2 + 1;
    summary.mergeCells(4, start, 4, start + 1);
    const cell = summary.getCell(4, start);
    cell.value = `${label}\n${value}`;
    cell.font = { name: "Aptos", size: 10, bold: true, color: { argb: index === 1 ? "08766B" : blue } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: index === 1 ? paleTeal : paleBlue } };
    cell.alignment = { vertical: "middle", wrapText: true };
    cell.border = thinBorder;
  });
  summary.getRow(4).height = 42;
  const summaryHeader = summary.getRow(7);
  ["Supplier", "Approved deliveries", "Gate-out complete", "Trip to gate (min)", "Unload (min)", "Site turnaround (min)"].forEach((value, index) => { summaryHeader.getCell(index + 1).value = value; });
  summaryHeader.eachCell((cell) => { cell.font = { name: "Aptos", bold: true, color: { argb: "FFFFFF" } }; cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: blue } }; cell.alignment = { vertical: "middle" }; cell.border = thinBorder; });
  summaryHeader.height = 25;
  summaryRows.forEach((row, index) => {
    const output = summary.addRow([row.supplier, row.approved, row.complete, row.trip, row.unload, row.turnaround]);
    output.eachCell((cell) => { cell.font = { name: "Aptos", size: 10, color: { argb: ink } }; cell.border = thinBorder; if (index % 2) cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "F7F9FC" } }; });
    output.getCell(6).font = { name: "Aptos", size: 10, bold: true, color: { argb: row.turnaround && row.turnaround <= 180 ? "08766B" : "A25A28" } };
  });
  summary.autoFilter = { from: "A7", to: `F${Math.max(7, summary.rowCount)}` };

  const details = workbook.addWorksheet("Delivery Details", { pageSetup: { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0 } });
  details.columns = [18, 18, 26, 14, 12, 18, 18, 18, 18, 18, 14, 18, 18, 18, 18, 18, 18, 42].map((width) => ({ width }));
  titleSheet(details, "Approved Delivery Details", `${selectedSupplier}  •  ${shipments.length} approved delivery record${shipments.length === 1 ? "" : "s"}`, "R");
  const detailHeaders = ["Booking", "Shipment", "Supplier", "Date", "Time", "Truck plate", "Driver", "Phone", "Delivery code", "Current status", "ETA (min)", "Trip scan", "Gate in", "Unloading", "Received", "Gate out", "Site time (min)", "Material codes / quantities"];
  const detailHeader = details.getRow(7);
  detailHeaders.forEach((value, index) => { detailHeader.getCell(index + 1).value = value; });
  detailHeader.eachCell((cell) => { cell.font = { name: "Aptos", bold: true, color: { argb: "FFFFFF" } }; cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: navy } }; cell.border = thinBorder; cell.alignment = { vertical: "middle", wrapText: true }; });
  detailHeader.height = 28;
  shipments.sort((a, b) => `${a.scheduledDate}${a.scheduledTime}`.localeCompare(`${b.scheduledDate}${b.scheduledTime}`)).forEach((shipment, index) => {
    const output = details.addRow([
      shipment.bookingReceipt, shipment.shipmentNumber, shipment.supplier, shipment.scheduledDate, `${shipment.scheduledTime}–${shipment.scheduledEndTime || shipment.scheduledTime}`,
      shipment.truckPlate, shipment.driverName, shipment.driverPhone || "—", shipment.deliveryCode || "—", shipment.status.replaceAll("_", " "), shipment.estimatedTravelMinutes || "—",
      shipment.tripAt || "—", shipment.gateInAt || "—", shipment.unloadingAt || "—", shipment.receivedAt || "—", shipment.gateOutAt || "—", duration(shipment.gateInAt, shipment.gateOutAt) ?? "—",
      shipment.items.map((item) => `${item.materialCode}: ${Number(item.quantity || 0).toLocaleString("en-PH")} ${item.uom || ""}`.trim()).join(" | "),
    ]);
    output.eachCell((cell) => { cell.font = { name: "Aptos", size: 9, color: { argb: ink } }; cell.border = thinBorder; cell.alignment = { vertical: "top", wrapText: true }; if (index % 2) cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "F7F9FC" } }; });
    output.height = 28;
  });
  details.autoFilter = { from: "A7", to: `R${Math.max(7, details.rowCount)}` };

  const safeName = selectedSupplier.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "all-suppliers";
  response.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  response.setHeader("Content-Disposition", `attachment; filename="dockflow-report-${safeName}.xlsx"`);
  await workbook.xlsx.write(response);
  response.end();
}));

app.get("/api/shipments/:id/booking.pdf", auth, asyncRoute(async (request, response) => {
  const state = await store.read();
  const shipment = state.shipments.find((row) => row.id === Number(request.params.id));
  if (!shipment) return response.status(404).json({ message: "Shipment not found" });
  if (!canAccessShipment(request.user, shipment)) return response.status(403).json({ message: "This account cannot download that booking" });
  if (shipment.bookingStatus !== "APPROVED") return response.status(409).json({ message: "The booking PDF and QR code are created only after approval" });
  const qr = await QRCode.toBuffer(`${APP_ORIGIN}/?shipment=${encodeURIComponent(shipment.shipmentNumber)}`, { margin: 3, width: 320, color: { dark: "#0b1e38", light: "#ffffff" } });
  response.setHeader("Content-Type", "application/pdf");
  response.setHeader("Content-Disposition", `attachment; filename="${shipment.bookingReceipt}.pdf"`);
  const document = new PDFDocument({ size: "A4", margins: { top: 38, right: 42, bottom: 38, left: 42 }, info: { Title: `${shipment.bookingReceipt} booking receipt`, Author: "DockFlow" } });
  document.pipe(response);
  document.fillColor("#0b1e38").fontSize(23).font("Helvetica-Bold").text("DockFlow", 42, 38);
  document.fontSize(9).font("Helvetica").fillColor("#607089").text("DELIVERY BOOKING RECEIPT", 42, 68);
  document.roundedRect(424, 30, 126, 126, 10).fillAndStroke("#ffffff", "#d8e1ed");
  document.image(qr, 435, 41, { width: 104, height: 104 });
  document.roundedRect(42, 174, 508, 74, 8).fill("#f1f6ff");
  document.fillColor("#0b1e38").font("Helvetica-Bold").fontSize(15).text(shipment.truckPlate, 58, 190);
  document.font("Helvetica").fontSize(10).fillColor("#44556f").text(`${shipment.supplier} · ${shipment.driverName}`, 58, 215);
  document.font("Helvetica-Bold").fillColor("#1d65f5").text(shipment.bookingStatus === "APPROVED" ? "APPROVED" : shipment.bookingStatus === "REJECTED" ? "REJECTED" : "PENDING APPROVAL", 395, 200, { width: 135, align: "right" });
  const details = [
    ["Booking", shipment.bookingReceipt], ["Shipment", shipment.shipmentNumber], ["Delivery code", shipment.deliveryCode || "—"],
    ["Delivery date", shipment.scheduledDate], ["Scheduled time", `${shipment.scheduledTime}–${shipment.scheduledEndTime || shipment.scheduledTime}`], ["Driver phone", shipment.driverPhone || "—"],
  ];
  details.forEach(([label, value], index) => {
    const column = index % 3;
    const row = Math.floor(index / 3);
    const x = 42 + column * 169;
    const y = 272 + row * 50;
    document.font("Helvetica").fontSize(8).fillColor("#7b8799").text(label.toUpperCase(), x, y);
    document.font("Helvetica-Bold").fontSize(10).fillColor("#17263d").text(String(value), x, y + 14, { width: 155 });
  });
  let y = 383;
  document.font("Helvetica-Bold").fontSize(12).fillColor("#17263d").text("Delivery products", 42, y);
  y += 24;
  document.roundedRect(42, y, 508, 24, 4).fill("#0b1e38");
  document.fillColor("#ffffff").fontSize(8).text("MATERIAL CODE", 54, y + 8).text("AMOUNT", 385, y + 8).text("UOM", 490, y + 8);
  y += 24;
  shipment.items.forEach((item, index) => {
    const height = 27;
    if (y + height > 760) { document.addPage(); y = 48; }
    if (index % 2 === 0) document.rect(42, y, 508, height).fill("#f7f9fc");
    document.fillColor("#17263d").font("Helvetica-Bold").fontSize(9).text(item.materialCode, 54, y + 9, { width: 310 });
    document.font("Helvetica").text(Number(item.quantity || 0).toLocaleString("en-PH"), 385, y + 9, { width: 82 }).text(item.uom || "—", 490, y + 9, { width: 45 });
    y += height;
  });
  y += 18;
  if (shipment.rejectionReason) document.fillColor("#b42318").font("Helvetica-Bold").fontSize(9).text(`Rejection reason: ${shipment.rejectionReason}`, 42, y, { width: 508 });
  document.font("Helvetica").fontSize(8).fillColor("#7b8799").text("Times are recorded in Asia/Manila (GMT+8). Present this QR at every process station.", 42, 790, { width: 508, align: "center" });
  document.end();
}));

app.get("/api/shipments/:id/qr.svg", auth, asyncRoute(async (request, response) => {
  const state = await store.read();
  const shipment = state.shipments.find((row) => row.id === Number(request.params.id));
  if (!shipment) return response.status(404).end();
  if (!canAccessShipment(request.user, shipment)) return response.status(403).json({ message: "You cannot access another supplier's QR code" });
  if (shipment.bookingStatus !== "APPROVED") return response.status(409).json({ message: "The QR code is created only after Planner or Production gives final approval" });
  response.type("image/svg+xml").send(await QRCode.toString(`${APP_ORIGIN}/?shipment=${encodeURIComponent(shipment.shipmentNumber)}`, { type: "svg", margin: 1, width: 240, color: { dark: "#0b1e38", light: "#ffffff" } }));
}));

app.use((error, _request, response, _next) => {
  void _next;
  console.error(error);
  if (error.code === "LIMIT_FILE_SIZE") return response.status(413).json({ message: "File exceeds the upload limit" });
  response.status(Number(error.status) || 500).json({ message: error.message || "The server could not complete this request" });
});

app.listen(PORT, "0.0.0.0", () => console.log(`DockFlow API listening on ${PORT}; PostgreSQL ${database.enabled ? `enabled (${database.schema})` : "disabled"}`));
