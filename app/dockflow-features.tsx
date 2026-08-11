"use client";

import { ArrowLeft, ArrowRight, CalendarDays, Clock3, FileSpreadsheet, Filter, History, Search, Truck } from "lucide-react";
import { useMemo, useState } from "react";
import { localDate } from "./date-utils";
import type { AppData, RdsRequest, SessionUser, Shipment, ShipmentStatus } from "./types";

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

const formatDate = (date: string, short = false) => new Intl.DateTimeFormat("en-PH", short ? { month: "short", day: "numeric" } : { weekday: "short", month: "short", day: "numeric" }).format(new Date(`${date}T12:00:00`));
const statusOrder: ShipmentStatus[] = ["PLANNED", "IN_TRANSIT", "ARRIVED", "VERIFIED", "PARKING", "AT_DOCK", "UNLOADING", "RECEIVED", "REJECTED"];
const journeySteps = ["Plan", "Trip", "Gate", "Dock", "Unload", "Received"];
const journeyPosition: Record<ShipmentStatus, number> = {
  PLANNED: 1,
  IN_TRANSIT: 2,
  ARRIVED: 3,
  VERIFIED: 3,
  PARKING: 3,
  AT_DOCK: 4,
  UNLOADING: 5,
  RECEIVED: 6,
  REJECTED: 0,
};

function StatusPill({ status }: { status: ShipmentStatus }) {
  const meta = STATUS_META[status];
  return <span className={`status-pill status-${meta.color}`}><span />{meta.label}</span>;
}

export function FlexibleSchedulePage({ data, user, onConfirmRds, onScheduleRds, onOpenShipment, onImportExcel }: {
  data: AppData;
  user: SessionUser;
  onConfirmRds: (rds: RdsRequest) => void;
  onScheduleRds: (rds: RdsRequest) => void;
  onOpenShipment: (shipment: Shipment) => void;
  onImportExcel: () => void;
}) {
  const [date, setDate] = useState(localDate());
  const shipments = data.shipments.filter((shipment) => shipment.scheduledDate === date).sort((a, b) => a.scheduledTime.localeCompare(b.scheduledTime));
  const moveDay = (days: number) => {
    const next = new Date(`${date}T12:00:00`);
    next.setDate(next.getDate() + days);
    setDate(`${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, "0")}-${String(next.getDate()).padStart(2, "0")}`);
  };
  const pending = data.rdsRequests.filter((request) => request.status !== "SCHEDULED");

  return <div className="page-stack">
    <section className="hero-row">
      <div><span className="eyebrow">Flexible scheduling center</span><h1>Delivery schedule</h1><p>Use any exact arrival time. End time is optional and Excel times are kept as entered.</p></div>
      <div className="hero-actions">
        {["admin", "planner"].includes(user.role) && <button className="button primary" onClick={onImportExcel}><FileSpreadsheet size={17} /> Import Excel</button>}
        <div className="date-stepper"><button onClick={() => moveDay(-1)}><ArrowLeft size={17} /></button><label><CalendarDays size={17} /><input type="date" value={date} onChange={(event) => setDate(event.target.value)} /></label><button onClick={() => moveDay(1)}><ArrowRight size={17} /></button></div>
      </div>
    </section>
    <section className="schedule-layout flexible-schedule-layout">
      <article className="panel schedule-board flexible-schedule-board">
        <div className="panel-head"><div><span className="eyebrow">{formatDate(date)}</span><h2>{shipments.length} planned arrivals</h2></div><span className="policy-chip"><Clock3 size={14} /> No fixed slot length</span></div>
        <div className="exact-time-list">
          {shipments.length ? shipments.map((shipment) => {
            const sameTime = shipments.filter((other) => other.scheduledTime === shipment.scheduledTime).length;
            return <button className="exact-time-row" key={shipment.id} onClick={() => onOpenShipment(shipment)}>
              <span className="exact-time"><b>{shipment.scheduledTime}</b><small>{shipment.scheduledEndTime ? `until ${shipment.scheduledEndTime}` : "exact arrival"}</small></span>
              <span className="exact-route"><span className="truck-tile"><Truck size={18} /></span><span><b>{shipment.supplier}</b><small>{shipment.shipmentNumber} · {shipment.items.length} material line{shipment.items.length === 1 ? "" : "s"}</small></span></span>
              <span className="exact-assignment"><b>{shipment.truckPlate}</b><small>{shipment.driverName}</small></span>
              <span className="exact-dock">{shipment.dock || "Dock pending"}{sameTime > 1 && <small>{sameTime} arrivals at this time</small>}</span>
              <StatusPill status={shipment.status} />
              <ArrowRight size={17} />
            </button>;
          }) : <div className="feature-empty"><CalendarDays size={24} /><strong>No arrivals on this date</strong><span>Choose another date or import the delivery workbook.</span></div>}
        </div>
      </article>
      <aside className="panel request-queue">
        <div className="panel-head"><div><span className="eyebrow">RDS queue</span><h2>Needs action</h2></div><span className="count-chip">{pending.length}</span></div>
        <div className="rds-list">{pending.map((rds) => <article className="rds-card" key={rds.id}><div><span className={`request-status ${rds.status.toLowerCase()}`}>{rds.status}</span><small>{rds.rdsNumber}</small></div><h3>{rds.supplier}</h3><p>{rds.dppNumber} · {formatDate(rds.requestedDate, true)}</p><div className="rds-meta"><span><Clock3 size={14} /> Requested {rds.arrivalShift}</span></div>{rds.status === "PENDING" && ["supplier", "admin"].includes(user.role) && <button className="button primary compact" onClick={() => onConfirmRds(rds)}>Confirm RDS</button>}{rds.status === "CONFIRMED" && ["supplier", "admin", "planner"].includes(user.role) && <button className="button primary compact" onClick={() => onScheduleRds(rds)}><CalendarDays size={15} /> Set exact time</button>}</article>)}</div>
      </aside>
    </section>
  </div>;
}

export function MonitoringPage({ data, onOpenShipment }: { data: AppData; onOpenShipment: (shipment: Shipment) => void }) {
  const [fromDate, setFromDate] = useState(localDate());
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<ShipmentStatus | "ALL">("ALL");
  const upcoming = useMemo(() => data.shipments
    .filter((shipment) => !fromDate || shipment.scheduledDate >= fromDate)
    .sort((a, b) => `${a.scheduledDate}${a.scheduledTime}`.localeCompare(`${b.scheduledDate}${b.scheduledTime}`)), [data.shipments, fromDate]);
  const rows = useMemo(() => upcoming
    .filter((shipment) => status === "ALL" || shipment.status === status)
    .filter((shipment) => `${shipment.shipmentNumber} ${shipment.bookingReceipt} ${shipment.supplier} ${shipment.truckPlate} ${shipment.driverName} ${shipment.items.map(item => `${item.poNumber} ${item.materialCode} ${item.materialName}`).join(" ")}`.toLowerCase().includes(query.toLowerCase()))
    , [upcoming, query, status]);

  return <div className="page-stack monitoring-page">
    <section className="hero-row"><div><span className="eyebrow">Upcoming delivery board</span><h1>Delivery monitoring</h1><p>Every scheduled arrival in one compact, color-coded operational view.</p></div><span className="operation-live"><span className="live-dot" /> Live status</span></section>
    <section className="monitor-status-strip">
      {statusOrder.map((item) => <button key={item} className={status === item ? "active" : ""} onClick={() => setStatus(status === item ? "ALL" : item)}><StatusPill status={item} /><b>{upcoming.filter((shipment) => shipment.status === item).length}</b></button>)}
    </section>
    <section className="panel monitoring-panel">
      <div className="monitor-toolbar"><label className="search-box"><Search size={17} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search delivery, supplier, PO, material, truck or driver" /></label><label className="monitor-date"><CalendarDays size={16} /><span>From</span><input type="date" value={fromDate} onChange={(event) => setFromDate(event.target.value)} /></label><button className="button secondary compact" onClick={() => { setFromDate(localDate()); setStatus("ALL"); setQuery(""); }}><Filter size={15} /> From today</button></div>
      <div className="monitor-count"><b>{rows.length}</b> upcoming deliver{rows.length === 1 ? "y" : "ies"} shown from {formatDate(fromDate)}</div>
      <div className="monitor-grid">{rows.map((shipment) => {
        const position = journeyPosition[shipment.status];
        const material = shipment.items[0];
        const load = shipment.materialWeightKg > 0 ? `${shipment.materialWeightKg.toLocaleString()} kg` : material ? `${material.quantity.toLocaleString()} ${material.uom}` : "—";
        return <button className={`monitor-delivery-card monitor-tone-${STATUS_META[shipment.status].color}`} key={shipment.id} onClick={() => onOpenShipment(shipment)}>
          <span className="monitor-card-head"><span><small>{formatDate(shipment.scheduledDate)}</small><b>{shipment.scheduledTime}{shipment.scheduledEndTime ? ` – ${shipment.scheduledEndTime}` : ""}</b></span><StatusPill status={shipment.status} /></span>
          <span className="monitor-card-shipment"><span className="truck-tile"><Truck size={19} /></span><span><b>{shipment.truckPlate || "To be assigned"}</b><small>{shipment.supplier}</small></span><ArrowRight size={17} /></span>
          <span className="monitor-card-facts"><span><small>Delivery</small><b>{shipment.shipmentNumber}</b></span><span><small>Driver</small><b>{shipment.driverName || "To be assigned"}</b></span><span><small>Dock</small><b>{shipment.dock || "Pending"}</b></span><span><small>Load</small><b>{load}</b></span></span>
          <span className="monitor-card-material"><b>{material?.materialName || "Material details pending"}</b><small>{material ? `${material.materialCode} · ${shipment.items.length} line${shipment.items.length === 1 ? "" : "s"}${material.poNumber ? ` · PO ${material.poNumber}` : ""}` : shipment.importSource || "Manual delivery"}</small></span>
          <span className={`monitor-progress ${shipment.status === "REJECTED" ? "rejected" : ""}`}>{journeySteps.map((step, index) => { const stepNumber = index + 1; return <span className={position > stepNumber ? "complete" : position === stepNumber ? "current" : ""} key={step}><i>{position > stepNumber ? "✓" : stepNumber}</i><small>{step}</small></span>; })}</span>
        </button>;
      })}</div>
      {!rows.length && <div className="feature-empty"><CalendarDays size={24} /><strong>No upcoming deliveries</strong><span>Import a delivery workbook or create a schedule. Matching deliveries will appear here automatically.</span></div>}
    </section>
  </div>;
}

export function FlexibleBacklogPage({ data, onReschedule, onOpenShipment }: {
  data: AppData;
  onReschedule: (id: number, date: string, start: string, end: string) => void;
  onOpenShipment: (shipment: Shipment) => void;
}) {
  const [editing, setEditing] = useState<Shipment | null>(null);
  const [date, setDate] = useState(localDate(1));
  const [start, setStart] = useState("08:00");
  const [end, setEnd] = useState("");
  const backlog = data.shipments.filter((shipment) => shipment.status === "REJECTED" || (shipment.status === "PLANNED" && shipment.scheduledDate <= localDate()));
  const open = (shipment: Shipment) => { setEditing(shipment); setDate(shipment.scheduledDate < localDate() ? localDate(1) : shipment.scheduledDate); setStart(shipment.scheduledTime); setEnd(shipment.scheduledEndTime || ""); };
  return <div className="page-stack">
    <section className="hero-row"><div><span className="eyebrow">Recovery planning</span><h1>Backlog manager</h1><p>Move an unserved delivery to any exact date and time—no fixed slots.</p></div><span className="count-chip warning">{backlog.length} needs rescheduling</span></section>
    <section className="panel flexible-backlog"><div className="panel-head"><div><span className="eyebrow">Unserved deliveries</span><h2>Backlog queue</h2></div></div><div className="backlog-table">{backlog.map((shipment) => <article key={shipment.id}><span className="backlog-icon"><History size={18} /></span><button className="table-link" onClick={() => onOpenShipment(shipment)}>{shipment.shipmentNumber}</button><span><b>{shipment.supplier}</b><small>{shipment.items[0]?.materialName}</small></span><span><b>{formatDate(shipment.scheduledDate, true)} · {shipment.scheduledTime}</b><small>Previous schedule</small></span><StatusPill status={shipment.status} /><button className="button secondary compact" onClick={() => open(shipment)}>Reschedule</button></article>)}</div>{!backlog.length && <div className="feature-empty"><History size={24} /><strong>Backlog cleared</strong><span>There are no missed or rejected deliveries waiting to be moved.</span></div>}</section>
    {editing && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && setEditing(null)}><section className="modal" role="dialog" aria-modal="true" aria-label="Reschedule delivery"><div className="modal-head"><div><h2>Reschedule delivery</h2><p>{editing.shipmentNumber} · {editing.supplier}</p></div><button className="icon-button" onClick={() => setEditing(null)}>×</button></div><form className="modal-form" onSubmit={(event) => { event.preventDefault(); onReschedule(editing.id, date, start, end); setEditing(null); }}><div className="notice"><Clock3 size={17} /><span>Set any exact arrival time. End time is optional.</span></div><div className="form-grid"><label>Delivery date<input type="date" value={date} onChange={(event) => setDate(event.target.value)} required /></label><label>Exact arrival time<input type="time" value={start} onChange={(event) => setStart(event.target.value)} required /></label><label>Optional end time<input type="time" value={end} onChange={(event) => setEnd(event.target.value)} /></label></div><div className="modal-actions"><button type="button" className="button secondary" onClick={() => setEditing(null)}>Cancel</button><button className="button primary">Save new time</button></div></form></section></div>}
  </div>;
}
