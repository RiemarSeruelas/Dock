import type { AppData, Shipment, ShipmentStatus } from "./types";

const pad = (value: number) => String(value).padStart(2, "0");
export const localDate = (offset = 0) => {
  const date = new Date();
  date.setDate(date.getDate() + offset);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};

const item = (id: number, materialCode: string, materialName: string, qty: number, pallets: number) => ({
  id,
  poNumber: `45${String(16000000 + id * 173)}`,
  materialCode,
  materialName,
  quantity: qty,
  uom: "KG",
  palletCount: pallets,
  dnNumber: `DN-${202600 + id}`,
  batchNumber: `B26-${pad(id)}A`,
  productionDate: localDate(-5),
  expiryDate: localDate(180),
  dnFileName: id % 2 ? `delivery-note-${id}.pdf` : undefined,
  coaFileName: id % 3 ? `coa-${id}.pdf` : undefined,
});

const shipment = (
  id: number,
  timeSlot: string,
  status: ShipmentStatus,
  supplier: string,
  material: string,
  dock?: string,
  offset = 0,
): Shipment => ({
  id,
  shipmentNumber: `SHP-${localDate(offset).replaceAll("-", "")}-${pad(id)}`,
  bookingReceipt: `BKG-${String(903000 + id * 37)}`,
  supplier,
  vendorCode: `V${String(9000 + id)}`,
  scheduledDate: localDate(offset),
  timeSlot,
  shift: Number(timeSlot.slice(0, 2)) < 6 ? "Night" : Number(timeSlot.slice(0, 2)) < 14 ? "Morning" : "Afternoon",
  status,
  truckPlate: `N${id % 2 ? "AJ" : "BK"} ${String(1200 + id * 83)}`,
  driverName: ["Marco Reyes", "Joel Santos", "Alvin Cruz", "Ramon Dela Peña"][(id - 1) % 4],
  driverPhone: `09${String(170000000 + id * 1109)}`,
  materialWeightKg: 8000 + id * 850,
  dock,
  arrivalTime: ["ARRIVED", "VERIFIED", "PARKING", "AT_DOCK", "UNLOADING", "RECEIVED"].includes(status)
    ? `${localDate(offset)}T${timeSlot.slice(0, 5)}:00`
    : null,
  startedAt: status !== "PLANNED" ? `${localDate(offset)}T05:45:00` : null,
  completedAt: status === "RECEIVED" ? `${localDate(offset)}T10:21:00` : null,
  items: [item(id, `627${1700 + id * 11}`, material, 3200 + id * 420, 4 + (id % 4))],
  palletsScanned: status === "RECEIVED" ? 4 + (id % 4) : status === "UNLOADING" ? 2 : 0,
  palletsTotal: 4 + (id % 4),
});

export const demoData: AppData = {
  shipments: [
    shipment(1, "06:00 - 07:30", "UNLOADING", "Pacific Oils Inc.", "Refined soybean oil", "Dock 1"),
    shipment(2, "06:00 - 07:30", "AT_DOCK", "Cavite Packaging", "HDPE bottles 500 mL", "Dock 2"),
    shipment(3, "07:30 - 09:00", "VERIFIED", "Luzon Ingredients", "Modified starch"),
    shipment(4, "09:00 - 10:30", "ARRIVED", "Southline Trading", "Iodized salt"),
    shipment(5, "10:30 - 12:00", "IN_TRANSIT", "Pacific Oils Inc.", "Palm olein"),
    shipment(6, "12:00 - 13:30", "PLANNED", "Prime Cartons Corp.", "Printed carton cases"),
    shipment(7, "13:30 - 15:00", "PLANNED", "Cavite Packaging", "PET closures"),
    shipment(8, "15:00 - 16:30", "RECEIVED", "Luzon Ingredients", "Citric acid", "Dock 3", -1),
    shipment(9, "07:30 - 09:00", "PLANNED", "Prime Cartons Corp.", "Corrugated dividers", undefined, 1),
  ],
  rdsRequests: [
    { id: 1, rdsNumber: "RDS-260811-014", dppNumber: "DPP-2608-104", supplier: "Pacific Oils Inc.", requestedDate: localDate(2), arrivalShift: "Morning", status: "PENDING", notes: "Priority raw material" },
    { id: 2, rdsNumber: "RDS-260811-013", dppNumber: "DPP-2608-099", supplier: "Cavite Packaging", requestedDate: localDate(1), arrivalShift: "Afternoon", status: "CONFIRMED" },
    { id: 3, rdsNumber: "RDS-260810-038", dppNumber: "DPP-2608-093", supplier: "Luzon Ingredients", requestedDate: localDate(), arrivalShift: "Morning", status: "SCHEDULED" },
  ],
  materials: [
    { id: 1, code: "6271711", name: "Refined soybean oil", type: "ROH", uom: "KG", shelfLifeDays: 365, unitsPerPallet: 4, storageZone: "Zone A" },
    { id: 2, code: "6271722", name: "Modified starch", type: "ROH", uom: "KG", shelfLifeDays: 540, unitsPerPallet: 40, storageZone: "Zone B" },
    { id: 3, code: "6271733", name: "Iodized salt", type: "ROH", uom: "KG", shelfLifeDays: 720, unitsPerPallet: 50, storageZone: "Zone B" },
    { id: 4, code: "6271744", name: "HDPE bottles 500 mL", type: "PACK", uom: "PC", shelfLifeDays: 0, unitsPerPallet: 2400, storageZone: "Zone C" },
    { id: 5, code: "6271755", name: "Printed carton cases", type: "PACK", uom: "PC", shelfLifeDays: 0, unitsPerPallet: 800, storageZone: "Zone C" },
  ],
  users: [
    { id: 1, name: "System Administrator", username: "admin", role: "admin" },
    { id: 2, name: "Andrea Lim", username: "planner", role: "planner" },
    { id: 3, name: "Paolo Garcia", username: "supplier", role: "supplier", supplierId: 1 },
    { id: 4, name: "Marco Reyes", username: "driver", role: "driver" },
    { id: 5, name: "Ana Mendoza", username: "security", role: "security" },
    { id: 6, name: "Leo Villanueva", username: "warehouse", role: "warehouse" },
  ],
  audit: [
    { id: 1, at: new Date(Date.now() - 8 * 60000).toISOString(), actor: "Leo Villanueva", action: "PALLET_SCANNED", shipmentNumber: `SHP-${localDate().replaceAll("-", "")}-01`, detail: "Pallet 2 of 5 received" },
    { id: 2, at: new Date(Date.now() - 19 * 60000).toISOString(), actor: "Ana Mendoza", action: "DOCK_ASSIGNED", shipmentNumber: `SHP-${localDate().replaceAll("-", "")}-02`, detail: "Assigned to Dock 2" },
    { id: 3, at: new Date(Date.now() - 31 * 60000).toISOString(), actor: "Marco Reyes", action: "ARRIVED", shipmentNumber: `SHP-${localDate().replaceAll("-", "")}-04`, detail: "Driver arrival recorded with GPS" },
    { id: 4, at: new Date(Date.now() - 55 * 60000).toISOString(), actor: "Andrea Lim", action: "RDS_CREATED", detail: "RDS-260811-014 sent to supplier" },
  ],
  settings: { slotMinutes: 90, dockCount: 3, graceMinutes: 30, siteName: "Cavite Foods Receiving" },
};

export const demoPasswords: Record<string, string> = {
  admin: "admin123",
  planner: "planner123",
  supplier: "supplier123",
  driver: "driver123",
  security: "security123",
  warehouse: "warehouse123",
};
