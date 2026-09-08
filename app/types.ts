export type Role = "admin" | "planner" | "production" | "supplier" | "driver" | "security" | "warehouse" | "qa" | "ecosystem" | "sap";
export type WorkArea = "DRESSINGS" | "SAVOURY" | "ECOSYSTEM";

export type ShipmentStatus =
  | "PROPOSED"
  | "BOOKED"
  | "IN_TRANSIT"
  | "GATE_IN"
  | "UNLOADING"
  | "RECEIVED"
  | "GATE_OUT"
  | "REJECTED";

export type BookingStatus = "PENDING_SUPPLIER" | "PENDING_COMPANY" | "SUPPLIER_CONFIRMED" | "SUPPLIER_ALTERNATIVE" | "APPROVED" | "REJECTED";
export type ScanStage = "LOOKUP" | "GATE" | "UNLOADING" | "RECEIVED";

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
  workArea?: WorkArea | null;
  email?: string;
  emailVerifiedAt?: string | null;
  mustChangePassword?: boolean;
  onboardingRequired?: boolean;
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

export interface ShipmentScanRecord {
  stage: string;
  status: ShipmentStatus;
  scannedAt: string;
  userId: number;
  actor: string;
  role: Role;
}

export interface QuantityAllocation { itemId: number; materialCode?: string; uom?: string; quantity: number; date: string; time: string }
export interface ReceiptInput { outcome: "FULL" | "NOT_IN_FULL" | "NOT_OTIF"; reason?: string; items: { itemId: number; acceptedQuantity: number; reason?: string; date?: string; time?: string }[] }
export interface Shipment {
  helper1Name?: string;
  helper2Name?: string;
  poNumber?: string;
  drNumber?: string;
  destinationEcosystemId?: number | null;
  replacementForId?: number;
  replacementIds?: number[];
  quantityAllocations?: QuantityAllocation[];
  proposedTrucks?: {truckPlate:string;driverName:string;driverPhone:string;helper1Name?:string;helper2Name?:string;poNumber:string;drNumber:string;itemIds:number[]}[];
  changeReason?: string;
  receipt?: { outcome: "FULL" | "NOT_IN_FULL" | "NOT_OTIF"; reason?: string; inFull: boolean; onTime: boolean | null; otif: boolean | null; items: { itemId: number; materialCode: string; uom: string; acceptedQuantity: number; remainingQuantity: number; date?: string; time?: string; reason?: string }[] };
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
  scanHistory?: ShipmentScanRecord[];
  estimatedArrivalAt?: string | null;
  estimatedTravelMinutes?: number | null;
  estimatedTravelDistanceKm?: number | null;
  estimatedTrafficDelayMinutes?: number | null;
  etaTrafficAware?: boolean;
  etaTrafficModel?: "LIVE" | "TIME_OF_DAY" | "NONE";
  etaProvider?: string | null;
  rejectionReason?: string | null;
  supplierResponse?: "ACCEPTED" | "ALTERNATIVE_PROPOSED" | null;
  supplierResponseReason?: string | null;
  supplierRespondedAt?: string | null;
  alternativeDate?: string | null;
  alternativeTime?: string | null;
  alternativeEndTime?: string | null;
  companyDecision?: "APPROVED" | "REJECTED" | null;
  companyDecisionReason?: string | null;
  companyDecisionAt?: string | null;
  companyDecisionBy?: string | null;
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
  routeStaticDurationMinutes?: number | null;
  routeTrafficDelayMinutes?: number | null;
  routeTrafficAware?: boolean;
  routeTrafficModel?: "LIVE" | "TIME_OF_DAY" | "NONE";
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

export interface AppNotification {
  id: number;
  type: "INFO" | "SUCCESS" | "WARNING" | "ERROR";
  title: string;
  message: string;
  shipmentId?: number | null;
  shipmentNumber?: string | null;
  createdAt: string;
  readAt?: string | null;
  requiresAction?: boolean;
  resolvedAt?: string | null;
}

export interface AppData {
  currentUser?: SessionUser;
  shipments: Shipment[];
  rdsRequests: RdsRequest[];
  materials: Material[];
  suppliers: SupplierAccount[];
  users: SessionUser[];
  audit: AuditEntry[];
  notifications: AppNotification[];
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
    siteAddressConfigured?: boolean;
    siteCoordinates?: { lat: number; lon: number } | null;
    emailNotifications?: { senderEmail: string; configured: boolean; configuredAt?: string | null };
    availableDates: string[];
    availableSlots: AvailabilitySlot[];
  };
}
