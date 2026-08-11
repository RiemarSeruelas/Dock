export type Role = "admin" | "planner" | "supplier" | "driver" | "security" | "warehouse";

export type ShipmentStatus =
  | "PLANNED"
  | "IN_TRANSIT"
  | "ARRIVED"
  | "VERIFIED"
  | "PARKING"
  | "AT_DOCK"
  | "UNLOADING"
  | "RECEIVED"
  | "REJECTED";

export interface SessionUser {
  id: number;
  name: string;
  username: string;
  role: Role;
  supplierId?: number | null;
}

export interface ShipmentItem {
  id: number;
  poNumber: string;
  materialCode: string;
  materialName: string;
  quantity: number;
  uom: string;
  palletCount: number;
  dnNumber?: string;
  batchNumber?: string;
  productionDate?: string;
  expiryDate?: string;
  dnFileName?: string;
  coaFileName?: string;
}

export interface Shipment {
  id: number;
  shipmentNumber: string;
  bookingReceipt: string;
  supplier: string;
  vendorCode: string;
  scheduledDate: string;
  timeSlot: string;
  shift: string;
  status: ShipmentStatus;
  truckPlate: string;
  driverName: string;
  driverPhone: string;
  materialWeightKg: number;
  dock?: string | null;
  arrivalTime?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  rejectionReason?: string | null;
  items: ShipmentItem[];
  palletsScanned: number;
  palletsTotal: number;
}

export interface RdsRequest {
  id: number;
  rdsNumber: string;
  dppNumber: string;
  supplier: string;
  requestedDate: string;
  arrivalShift: string;
  status: "PENDING" | "CONFIRMED" | "SCHEDULED";
  notes?: string;
}

export interface Material {
  id: number;
  code: string;
  name: string;
  type: string;
  uom: string;
  shelfLifeDays: number;
  unitsPerPallet: number;
  storageZone: string;
}

export interface AuditEntry {
  id: number;
  at: string;
  actor: string;
  action: string;
  shipmentNumber?: string;
  detail: string;
}

export interface AppData {
  shipments: Shipment[];
  rdsRequests: RdsRequest[];
  materials: Material[];
  users: SessionUser[];
  audit: AuditEntry[];
  settings: {
    slotMinutes: number;
    dockCount: number;
    graceMinutes: number;
    siteName: string;
  };
}
