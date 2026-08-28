export type Role = "admin" | "planner" | "production" | "supplier" | "driver" | "security" | "warehouse";

export type ShipmentStatus =
  | "PROPOSED"
  | "BOOKED"
  | "IN_TRANSIT"
  | "GATE_IN"
  | "UNLOADING"
  | "RECEIVED"
  | "GATE_OUT"
  | "REJECTED";

export type BookingStatus = "PENDING_SUPPLIER" | "SUPPLIER_CONFIRMED" | "SUPPLIER_ALTERNATIVE" | "APPROVED" | "REJECTED";
export type ScanStage = "TRIP" | "GATE" | "UNLOADING" | "RECEIVED";

export interface AvailabilitySlot {
  id: number;
  date: string;
  startTime: string;
  endTime: string;
  label?: string;
}

export type AvailabilityInput = Omit<AvailabilitySlot, "id"> & { id?: number };

export interface SessionUser {
  id: number;
  name: string;
  username: string;
  role: Role;
  supplierId?: number | null;
  email?: string;
  emailVerifiedAt?: string | null;
}

export interface ShipmentItem {
  id: number;
  presetId?: number | null;
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
  sourceSheet?: string | null;
  sourceRow?: number | null;
  sourceFile?: string | null;
  deliverySite?: string | null;
  deliveryWeek?: string | null;
  poBalance?: number | null;
  poQuantity?: number | null;
  stillToBeDelivered?: number | null;
  remarks?: string | null;
  supplierApprovedAt?: string | null;
  assignedTruckPlate?: string | null;
}

export interface ConfirmedTruckLoad {
  id: number;
  deliveryCode: string;
  truckPlate: string;
  driverName: string;
  driverPhone: string;
  itemIds: number[];
  confirmedAt: string;
}

export interface Shipment {
  id: number;
  shipmentNumber: string;
  bookingReceipt: string;
  supplier: string;
  supplierId?: number | null;
  dppNumber?: string;
  deliveryCode?: string | null;
  vendorCode: string;
  scheduledDate: string;
  scheduledTime: string;
  scheduledEndTime?: string | null;
  availabilitySlotId?: number | null;
  expectedDurationMinutes?: number | null;
  timeSlot: string;
  shift: string;
  bookingStatus?: BookingStatus;
  status: ShipmentStatus;
  truckPlate: string;
  driverName: string;
  driverPhone: string;
  materialWeightKg: number;
  dock?: string | null;
  arrivalTime?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  lastProcessAt?: string | null;
  tripAt?: string | null;
  gateInAt?: string | null;
  unloadingAt?: string | null;
  receivedAt?: string | null;
  gateOutAt?: string | null;
  estimatedArrivalAt?: string | null;
  estimatedTravelMinutes?: number | null;
  estimatedTravelDistanceKm?: number | null;
  rejectionReason?: string | null;
  supplierResponse?: "ACCEPTED" | "ALTERNATIVE_PROPOSED" | null;
  supplierResponseReason?: string | null;
  supplierRespondedAt?: string | null;
  alternativeDate?: string | null;
  alternativeTime?: string | null;
  alternativeEndTime?: string | null;
  loadConfirmedAt?: string | null;
  finalDecisionAt?: string | null;
  finalDecisionBy?: string | null;
  sdsProposalId?: number | null;
  importBatchId?: number | null;
  importSource?: string | null;
  supplierAccountLinked?: boolean;
  confirmedTruckLoads?: ConfirmedTruckLoad[];
  sdsImportIdentity?: string | null;
  sdsImportFingerprint?: string | null;
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
  requestedTime?: string;
  requestedEndTime?: string;
  availabilitySlotId?: number | null;
  status: "PENDING" | "CONFIRMED" | "SCHEDULED";
  notes?: string;
}

export interface SupplierPreset {
  id: number;
  materialCode: string;
  name?: string;
  uom: string;
  defaultAmount: number;
}

export interface SupplierAccount {
  id: number;
  vendorCode: string;
  name: string;
  productPresets: SupplierPreset[];
  originAddress?: string;
  originCoordinates?: { lat: number; lon: number } | null;
  routeDistanceKm?: number | null;
  routeDurationMinutes?: number | null;
  routeCalculatedAt?: string | null;
  routeProvider?: string | null;
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
  suppliers: SupplierAccount[];
  users: SessionUser[];
  audit: AuditEntry[];
  importBatches: {
    id: number;
    fileName: string;
    status: string;
    totalRows: number;
    importedRows: number;
    skippedRows: number;
    deliveryCount: number;
    createdAt: string;
    completedAt?: string | null;
    notificationStatus?: string;
    notificationsSent?: number;
    notificationsFailed?: number;
  }[];
  settings: {
    flexibleScheduling: boolean;
    slotMinutes?: number;
    dockCount: number;
    graceMinutes: number;
    siteName: string;
    siteAddress?: string;
    siteCoordinates?: { lat: number; lon: number } | null;
    emailNotifications?: { senderEmail: string; configured: boolean; configuredAt?: string | null };
    availableDates: string[];
    availableSlots: AvailabilitySlot[];
  };
}
