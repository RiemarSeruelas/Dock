"use client";

import { ArrowLeft, ArrowRight, CalendarDays, Check, Clock3, FileSpreadsheet, History, Maximize2, Minimize2, Search, ShieldCheck, Truck, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { AvailabilityEditor } from "./availability-calendar";
import { localDate } from "./date-utils";
import type { AppData, AvailabilityInput, RdsRequest, SessionUser, Shipment, ShipmentStatus } from "./types";

const STATUS_META: Record<ShipmentStatus, { label: string; color: string }> = {
  PLANNED: { label: "Planned", color: "slate" },
  IN_TRANSIT: { label: "In transit", color: "blue" },
  ARRIVED: { label: "At gate", color: "amber" },
  VERIFIED: { label: "Verified", color: "teal" },
  PARKING: { label: "Parking", color: "violet" },
  AT_DOCK: { label: "At dock", color: "cyan" },
  UNLOADING: { label: "Unloading", color: "orange" },
  RECEIVED: { label: "Received", color: "green" },
  REJECTED: { label: "Rejected", color: "red" },
};

const formatDate = (date: string, short = false) => new Intl.DateTimeFormat("en-PH", short ? { month: "short", day: "numeric", year: "numeric" } : { weekday: "short", month: "short", day: "numeric" }).format(new Date(`${date}T12:00:00`));
const statusOrder: ShipmentStatus[] = ["PLANNED", "IN_TRANSIT", "ARRIVED", "VERIFIED", "PARKING", "AT_DOCK", "UNLOADING", "RECEIVED", "REJECTED"];
const journeySteps = ["Plan", "Trip", "Gate", "Dock", "Unload", "Received"];
const journeyPosition: Record<ShipmentStatus, number> = { PLANNED: 1, IN_TRANSIT: 2, ARRIVED: 3, VERIFIED: 3, PARKING: 3, AT_DOCK: 4, UNLOADING: 5, RECEIVED: 6, REJECTED: 0 };

function StatusPill({ status }: { status: ShipmentStatus }) {
  const meta = STATUS_META[status];
  return <span className={`status-pill status-${meta.color}`}><span />{meta.label}</span>;
}

export function FlexibleSchedulePage({ data, user, onOpenShipment, onSaveAvailability, onDeleteAvailability }: {
  data: AppData;
  user: SessionUser;
  onOpenShipment: (shipment: Shipment) => void;
  onSaveAvailability: (slot: AvailabilityInput) => Promise<void> | void;
  onDeleteAvailability: (id: number) => Promise<void> | void;
}) {
  const [date, setDate] = useState(data.settings.availableDates.find((item) => item >= localDate()) || localDate());
  const shipments = data.shipments.filter((shipment) => shipment.scheduledDate === date).sort((a, b) => a.scheduledTime.localeCompare(b.scheduledTime));
  const moveDay = (days: number) => {
    const next = new Date(`${date}T12:00:00`);
    next.setDate(next.getDate() + days);
    setDate(`${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, "0")}-${String(next.getDate()).padStart(2, "0")}`);
  };

  return <div className="page-stack">
    <section className="hero-row"><div><span className="eyebrow">Scheduling center</span><h1>Delivery schedule</h1><p>Create and move available time windows, then review arrivals for the selected date.</p></div><div className="date-stepper"><button onClick={() => moveDay(-1)} aria-label="Previous date"><ArrowLeft size={17} /></button><label><CalendarDays size={17} /><input type="date" value={date} onChange={(event) => setDate(event.target.value)} /></label><button onClick={() => moveDay(1)} aria-label="Next date"><ArrowRight size={17} /></button></div></section>
    {["admin", "planner"].includes(user.role) && <section className="panel schedule-availability-panel"><div className="panel-head"><div><span className="eyebrow">Time availability</span><h2>Set the booking calendar</h2><p>Drag an empty area to create a window or drag an existing window to move it. Nothing changes until you press Save.</p></div></div><AvailabilityEditor compact slots={data.settings.availableSlots} shipments={data.shipments} anchorDate={date} onAnchorDateChange={setDate} onSave={onSaveAvailability} onDelete={onDeleteAvailability} /></section>}
    <section className="panel schedule-board flexible-schedule-board">
      <div className="panel-head"><div><span className="eyebrow">{formatDate(date)}</span><h2>{shipments.length} planned arrival{shipments.length === 1 ? "" : "s"}</h2></div><span className="policy-chip"><Clock3 size={14} /> Two receiving docks</span></div>
      <div className="exact-time-list">{shipments.length ? shipments.map((shipment) => {
        const sameTime = shipments.filter((other) => other.scheduledTime === shipment.scheduledTime).length;
        return <button className="exact-time-row" key={shipment.id} onClick={() => onOpenShipment(shipment)}><span className="exact-time"><b>{shipment.scheduledTime}</b><small>{shipment.scheduledEndTime ? `until ${shipment.scheduledEndTime}` : "exact arrival"}</small></span><span className="exact-route"><span className="truck-tile"><Truck size={18} /></span><span><b>{shipment.supplier}</b><small>{shipment.shipmentNumber} · {shipment.items.length} material line{shipment.items.length === 1 ? "" : "s"}</small></span></span><span className="exact-assignment"><b>{shipment.truckPlate}</b><small>{shipment.driverName}</small></span><span className="exact-dock">{shipment.dock || "Dock pending"}{sameTime > 1 && <small>{sameTime} arrivals at this time</small>}</span>{shipment.bookingStatus === "PENDING_APPROVAL" ? <span className="approval-chip pending">Approval pending</span> : <StatusPill status={shipment.status} />}<ArrowRight size={17} /></button>;
      }) : <div className="feature-empty"><CalendarDays size={24} /><strong>No arrivals on this date</strong><span>Change the selected date or add deliveries through Management.</span></div>}</div>
    </section>
  </div>;
}

export function ManagementPage({ data, onImportExcel, onApproveBooking, onConfirmRds, onScheduleRds }: {
  data: AppData;
  onImportExcel: () => void;
  onApproveBooking: (shipment: Shipment, decision: "APPROVE" | "REJECT") => void;
  onConfirmRds: (rds: RdsRequest) => void;
  onScheduleRds: (rds: RdsRequest) => void;
}) {
  const pendingApprovals = data.shipments.filter((shipment) => shipment.bookingStatus === "PENDING_APPROVAL").sort((a, b) => `${a.scheduledDate}${a.scheduledTime}`.localeCompare(`${b.scheduledDate}${b.scheduledTime}`));
  const requests = data.rdsRequests.filter((request) => request.status !== "SCHEDULED");

  return <div className="page-stack management-page">
    <section className="hero-row"><div><span className="eyebrow">Planning control</span><h1>Management</h1><p>Import delivery files and decide which requested booking times are accepted.</p></div><button className="button primary" onClick={onImportExcel}><FileSpreadsheet size={17} /> Import Excel</button></section>
    <section className="management-metrics"><article><span className="settings-icon"><ShieldCheck size={19} /></span><div><small>Waiting for decision</small><b>{pendingApprovals.length}</b></div></article><article><span className="settings-icon"><Clock3 size={19} /></span><div><small>Open delivery requests</small><b>{requests.length}</b></div></article><article><span className="settings-icon"><FileSpreadsheet size={19} /></span><div><small>Imported workbooks</small><b>{data.importBatches.length}</b></div></article></section>
    <section className="management-grid">
      <article className="panel management-approvals"><div className="panel-head"><div><span className="eyebrow">Booking time requests</span><h2>Confirm or deny</h2></div><span className="count-chip warning">{pendingApprovals.length}</span></div><div className="management-approval-list">{pendingApprovals.map((shipment) => <article key={shipment.id}><span className="truck-tile"><Truck size={18} /></span><div><strong>{shipment.supplier}</strong><small>{shipment.shipmentNumber} · {shipment.truckPlate}</small></div><div><strong>{formatDate(shipment.scheduledDate, true)}</strong><small>{shipment.scheduledTime}{shipment.scheduledEndTime ? `–${shipment.scheduledEndTime}` : ""}</small></div><span className="approval-chip pending">Pending</span><div className="management-row-actions"><button className="button primary compact" onClick={() => onApproveBooking(shipment, "APPROVE")}><Check size={14} /> Confirm</button><button className="button secondary compact" onClick={() => onApproveBooking(shipment, "REJECT")}><X size={14} /> Deny</button></div></article>)}</div>{!pendingApprovals.length && <div className="feature-empty management-empty"><ShieldCheck size={24} /><strong>No booking decisions waiting</strong><span>New booking-time requests will appear here.</span></div>}</article>
      <aside className="panel management-requests"><div className="panel-head"><div><span className="eyebrow">RDS workflow</span><h2>Delivery requests</h2></div><span className="count-chip">{requests.length}</span></div><div className="rds-list">{requests.map((rds) => <article className="rds-card" key={rds.id}><div><span className={`request-status ${rds.status.toLowerCase()}`}>{rds.status}</span><small>{rds.rdsNumber}</small></div><h3>{rds.supplier}</h3><p>{rds.dppNumber}</p><div className="rds-meta"><span><CalendarDays size={14} /> {formatDate(rds.requestedDate, true)}</span><span><Clock3 size={14} /> {rds.requestedTime || "Time pending"}</span></div>{rds.status === "PENDING" && <button className="button primary compact" onClick={() => onConfirmRds(rds)}>Confirm request</button>}{rds.status === "CONFIRMED" && <button className="button primary compact" onClick={() => onScheduleRds(rds)}>Book delivery</button>}</article>)}</div>{!requests.length && <div className="approval-empty"><Check size={18} /><span>All RDS requests are scheduled.</span></div>}</aside>
    </section>
    <section className="panel import-history"><div className="panel-head"><div><span className="eyebrow">Excel activity</span><h2>Recent imports</h2></div></div><div className="table-wrap"><table><thead><tr><th>Workbook</th><th>Rows accepted</th><th>Deliveries</th><th>Imported at</th><th>Status</th></tr></thead><tbody>{data.importBatches.map((batch) => <tr key={batch.id}><td><b>{batch.fileName}</b></td><td>{batch.importedRows}</td><td>{batch.deliveryCount}</td><td>{new Intl.DateTimeFormat("en-PH", { dateStyle: "medium", timeStyle: "short" }).format(new Date(batch.completedAt || batch.createdAt))}</td><td><span className="score-chip good">{batch.status}</span></td></tr>)}</tbody></table></div>{!data.importBatches.length && <div className="approval-empty"><FileSpreadsheet size={18} /><span>No Excel workbook has been imported yet.</span></div>}</section>
    <section className="management-json-note"><b>Editable trial data</b><span>After the first Docker start, the complete JSON is available at <code>data/trial-data.json</code> in this project folder.</span></section>
  </div>;
}

export function MonitoringPage({ data, onOpenShipment }: { data: AppData; onOpenShipment: (shipment: Shipment) => void }) {
  const [fromDate, setFromDate] = useState(localDate());
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<ShipmentStatus | "ALL">("ALL");
  const [fullscreen, setFullscreen] = useState(false);
  const fullscreenRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const changed = () => { if (!document.fullscreenElement) setFullscreen(false); };
    document.addEventListener("fullscreenchange", changed);
    return () => document.removeEventListener("fullscreenchange", changed);
  }, []);
  const enterFullscreen = async () => { setFullscreen(true); await fullscreenRef.current?.requestFullscreen?.().catch(() => undefined); };
  const exitFullscreen = async () => { if (document.fullscreenElement) await document.exitFullscreen().catch(() => undefined); setFullscreen(false); };
  const upcoming = useMemo(() => data.shipments.filter((shipment) => !fromDate || shipment.scheduledDate >= fromDate).sort((a, b) => `${a.scheduledDate}${a.scheduledTime}`.localeCompare(`${b.scheduledDate}${b.scheduledTime}`)), [data.shipments, fromDate]);
  const rows = useMemo(() => upcoming.filter((shipment) => status === "ALL" || shipment.status === status).filter((shipment) => `${shipment.shipmentNumber} ${shipment.bookingReceipt} ${shipment.supplier} ${shipment.truckPlate} ${shipment.driverName} ${shipment.items.map((item) => `${item.poNumber} ${item.materialCode} ${item.materialName}`).join(" ")}`.toLowerCase().includes(query.toLowerCase())), [upcoming, query, status]);

  return <div ref={fullscreenRef} className={`page-stack monitoring-page ${fullscreen ? "tv-mode" : ""}`}>
    {!fullscreen && <section className="hero-row"><div><span className="eyebrow">Upcoming delivery board</span><h1>Delivery monitoring</h1><p>Every scheduled arrival in one compact, color-coded operational view.</p></div><div className="hero-actions"><span className="operation-live"><span className="live-dot" /> Live status</span><button className="icon-button fullscreen-trigger" onClick={enterFullscreen} aria-label="Open fullscreen monitoring" title="Fullscreen"><Maximize2 size={19} /></button></div></section>}
    {fullscreen && <button className="monitor-tv-exit" onClick={exitFullscreen} aria-label="Exit fullscreen" title="Exit fullscreen"><Minimize2 size={19} /></button>}
    {!fullscreen && <section className="monitor-status-strip">{statusOrder.map((item) => <button key={item} className={status === item ? "active" : ""} onClick={() => setStatus(status === item ? "ALL" : item)}><StatusPill status={item} /><b>{upcoming.filter((shipment) => shipment.status === item).length}</b></button>)}</section>}
    <section className="panel monitoring-panel">
      {!fullscreen && <div className="monitor-toolbar"><label className="search-box"><Search size={17} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search delivery, supplier, PO, material, truck or driver" /></label><div className="monitor-date-filter"><label><span>Starting date</span><input type="date" value={fromDate} onChange={(event) => setFromDate(event.target.value)} /></label><button onClick={() => { setFromDate(localDate()); setStatus("ALL"); setQuery(""); }}>Reset</button></div></div>}
      {!fullscreen && <div className="monitor-count"><b>{rows.length}</b> upcoming deliver{rows.length === 1 ? "y" : "ies"} shown from {formatDate(fromDate)}</div>}
      <div className="monitor-grid">{rows.map((shipment) => {
        const position = journeyPosition[shipment.status];
        const material = shipment.items[0];
        const load = shipment.materialWeightKg > 0 ? `${shipment.materialWeightKg.toLocaleString()} kg` : material ? `${material.quantity.toLocaleString()} ${material.uom}` : "—";
        return <button className={`monitor-delivery-card monitor-tone-${STATUS_META[shipment.status].color}`} key={shipment.id} onClick={() => !fullscreen && onOpenShipment(shipment)}><span className="monitor-card-head"><span><small>{formatDate(shipment.scheduledDate)}</small><b>{shipment.scheduledTime}{shipment.scheduledEndTime ? ` – ${shipment.scheduledEndTime}` : ""}</b></span>{shipment.bookingStatus === "PENDING_APPROVAL" ? <span className="approval-chip pending">Approval pending</span> : <StatusPill status={shipment.status} />}</span><span className="monitor-card-shipment"><span className="truck-tile"><Truck size={19} /></span><span><b>{shipment.truckPlate || "To be assigned"}</b><small>{shipment.supplier}</small></span><ArrowRight size={17} /></span><span className="monitor-card-facts"><span><small>Delivery</small><b>{shipment.shipmentNumber}</b></span><span><small>Driver</small><b>{shipment.driverName || "To be assigned"}</b></span><span><small>Dock</small><b>{shipment.dock || "Pending"}</b></span><span><small>Load</small><b>{load}</b></span></span><span className="monitor-card-material"><b>{material?.materialName || "Material details pending"}</b><small>{material ? `${material.materialCode} · ${shipment.items.length} line${shipment.items.length === 1 ? "" : "s"}${material.poNumber ? ` · PO ${material.poNumber}` : ""}` : shipment.importSource || "Manual delivery"}</small></span><span className={`monitor-progress ${shipment.status === "REJECTED" ? "rejected" : ""}`}>{journeySteps.map((step, index) => { const stepNumber = index + 1; return <span className={position > stepNumber ? "complete" : position === stepNumber ? "current" : ""} key={step}><i>{position > stepNumber ? "✓" : stepNumber}</i><small>{step}</small></span>; })}</span></button>;
      })}</div>
      {!rows.length && <div className="feature-empty"><CalendarDays size={24} /><strong>No upcoming deliveries</strong><span>Add deliveries through Management or create a delivery request.</span></div>}
    </section>
  </div>;
}

export function HistoryPage({ data, onOpenShipment }: { data: AppData; onOpenShipment: (shipment: Shipment) => void }) {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<ShipmentStatus | "ALL">("ALL");
  const history = useMemo(() => data.shipments.filter((shipment) => shipment.completedAt || ["RECEIVED", "REJECTED"].includes(shipment.status) || shipment.scheduledDate < localDate()).sort((a, b) => `${b.scheduledDate}${b.scheduledTime}`.localeCompare(`${a.scheduledDate}${a.scheduledTime}`)), [data.shipments]);
  const rows = history.filter((shipment) => status === "ALL" || shipment.status === status).filter((shipment) => `${shipment.shipmentNumber} ${shipment.supplier} ${shipment.truckPlate} ${shipment.driverName} ${shipment.items.map((item) => `${item.materialCode} ${item.materialName}`).join(" ")}`.toLowerCase().includes(query.toLowerCase()));
  const received = history.filter((shipment) => shipment.status === "RECEIVED").length;
  const rejected = history.filter((shipment) => shipment.status === "REJECTED").length;

  return <div className="page-stack history-page"><section className="hero-row"><div><span className="eyebrow">Delivery records</span><h1>History</h1><p>Completed, rejected, and previous-date deliveries remain available for review.</p></div><span className="count-chip">{history.length} records</span></section><section className="history-summary"><article><History size={19} /><div><small>Total records</small><b>{history.length}</b></div></article><article><Check size={19} /><div><small>Received</small><b>{received}</b></div></article><article><X size={19} /><div><small>Rejected</small><b>{rejected}</b></div></article></section><section className="panel history-panel"><div className="toolbar history-toolbar"><label className="search-box"><Search size={17} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search shipment, supplier, material, truck or driver" /></label><label className="history-status-filter">Outcome<select value={status} onChange={(event) => setStatus(event.target.value as ShipmentStatus | "ALL")}><option value="ALL">All records</option>{statusOrder.map((item) => <option value={item} key={item}>{STATUS_META[item].label}</option>)}</select></label></div><div className="table-wrap"><table><thead><tr><th>Date & time</th><th>Shipment</th><th>Supplier</th><th>Material</th><th>Truck & driver</th><th>Outcome</th><th>Dock</th><th /></tr></thead><tbody>{rows.map((shipment) => <tr key={shipment.id}><td><b>{formatDate(shipment.scheduledDate, true)}</b><small>{shipment.scheduledTime}</small></td><td><button className="table-link" onClick={() => onOpenShipment(shipment)}>{shipment.shipmentNumber}</button><small>{shipment.importSource || "Manual delivery"}</small></td><td>{shipment.supplier}</td><td><b>{shipment.items[0]?.materialName || "Material to review"}</b><small>{shipment.items.length} line{shipment.items.length === 1 ? "" : "s"}</small></td><td>{shipment.truckPlate}<small>{shipment.driverName}</small></td><td><StatusPill status={shipment.status} /></td><td>{shipment.dock || "—"}</td><td><button className="icon-button" onClick={() => onOpenShipment(shipment)}><ArrowRight size={16} /></button></td></tr>)}</tbody></table></div>{!rows.length && <div className="feature-empty"><History size={24} /><strong>No matching history</strong><span>Completed deliveries will appear here automatically.</span></div>}</section></div>;
}
