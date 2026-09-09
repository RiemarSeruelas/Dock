"use client";
import { supplierHue } from "./company-colors";
import { Dialog } from "./receiving-ui";
import { SupplierConfirmation } from "./receiving-ui";

import { AlertTriangle, ArrowLeft, ArrowRight, CalendarDays, Check, Clock3, FileSpreadsheet, History, Loader2, Maximize2, Minimize2, Search, Truck, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { localDate } from "./date-utils";
import { LiveClock } from "./live-clock";
import type { AppData, SessionUser, Shipment, ShipmentStatus } from "./types";

const STATUS_META: Record<ShipmentStatus, { label: string; color: string }> = {
  PROPOSED: { label: "Supplier approval", color: "purple" }, BOOKED: { label: "Booked", color: "slate" }, IN_TRANSIT: { label: "In transit", color: "blue" }, GATE_IN: { label: "Gate in", color: "amber" },
  UNLOADING: { label: "Unload", color: "orange" }, RECEIVED: { label: "Received", color: "green" }, GATE_OUT: { label: "Gate out", color: "teal" }, REJECTED: { label: "Rejected", color: "red" },
};
const statusOrder: ShipmentStatus[] = ["PROPOSED", "BOOKED", "IN_TRANSIT", "GATE_IN", "UNLOADING", "RECEIVED", "GATE_OUT", "REJECTED"];
const journeySteps = ["Booking", "Trip", "Gate in", "Unload", "Received", "Gate out"];
const journeyPosition: Record<ShipmentStatus, number> = { PROPOSED: 0, BOOKED: 1, IN_TRANSIT: 2, GATE_IN: 3, UNLOADING: 4, RECEIVED: 5, GATE_OUT: 6, REJECTED: 0 };
const processRank: Record<ShipmentStatus, number> = { PROPOSED: 0, BOOKED: 1, IN_TRANSIT: 2, GATE_IN: 3, UNLOADING: 4, RECEIVED: 5, GATE_OUT: 6, REJECTED: 0 };
const formatDate = (date: string, short = false) => new Intl.DateTimeFormat("en-PH", short ? { month: "short", day: "numeric", year: "numeric" } : { weekday: "short", month: "short", day: "numeric" }).format(new Date(`${date}T12:00:00`));
const formatEta = (value?: string | null) => value ? new Intl.DateTimeFormat("en-PH", { hour: "numeric", minute: "2-digit", timeZone: "Asia/Manila" }).format(new Date(value)) : null;
const addDays = (date: string, days: number) => { const next = new Date(`${date}T12:00:00`); next.setDate(next.getDate() + days); return `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, "0")}-${String(next.getDate()).padStart(2, "0")}`; };
const startOfWeek = (date: string) => { const value = new Date(`${date}T12:00:00`); return addDays(date, value.getDay() === 0 ? -6 : 1 - value.getDay()); };
const toMinutes = (time: string) => { const [hour, minute] = String(time || "00:00").split(":").map(Number); return hour * 60 + minute; };
const colorFor = (shipment: Shipment) => supplierHue(shipment.supplierId, shipment.supplier);

function StatusPill({ status, receipt }: { status: ShipmentStatus; receipt?: Shipment["receipt"] }) { const meta = STATUS_META[status]; return <span className={`status-pill status-${meta.color}`}><span />{meta.label}{receipt?.inFull === false ? " · Not in Full" : ""}</span>; }

type PositionedBooking = { shipment: Shipment; lane: number; lanes: number; start: number; end: number };

const layoutDayBookings = (shipments: Shipment[], date: string): PositionedBooking[] => {
  const bookings = shipments
    .filter((shipment) => shipment.scheduledDate === date && shipment.status !== "REJECTED")
    .map((shipment) => {
      const start = toMinutes(shipment.scheduledTime);
      const scheduledEnd = toMinutes(shipment.scheduledEndTime || shipment.scheduledTime);
      const end = shipment.scheduledEndTime ? (scheduledEnd > start ? scheduledEnd : scheduledEnd + 1440) : start + 30;
      return { shipment, start, end: Math.max(start + 30, end) };
    })
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const positioned: PositionedBooking[] = [];
  let cluster: typeof bookings = [];
  let clusterEnd = -1;
  const placeCluster = () => {
    if (!cluster.length) return;
    const laneEnds: number[] = [];
    const assigned = cluster.map((booking) => {
      let lane = laneEnds.findIndex((end) => end <= booking.start);
      if (lane < 0) lane = laneEnds.length;
      laneEnds[lane] = booking.end;
      return { ...booking, lane };
    });
    const lanes = Math.max(1, laneEnds.length);
    positioned.push(...assigned.map((booking) => ({ ...booking, lanes })));
    cluster = [];
  };
  bookings.forEach((booking) => {
    if (cluster.length && booking.start >= clusterEnd) placeCluster();
    cluster.push(booking);
    clusterEnd = Math.max(booking.end, cluster.length === 1 ? booking.end : clusterEnd);
  });
  placeCluster();
  return positioned;
};

const clockLabel = (hour: number) => hour === 0 || hour === 24 ? "12 AM" : hour === 12 ? "12 PM" : hour < 12 ? `${hour} AM` : `${hour - 12} PM`;

function CustomDatePicker({ value, onChange, label = "Choose date" }: { value: string; onChange: (value: string) => void; label?: string }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [month, setMonth] = useState(value.slice(0, 7));
  const [year, monthNumber] = month.split("-").map(Number);
  const firstOffset = (new Date(year, monthNumber - 1, 1).getDay() + 6) % 7;
  const cells = Array.from({ length: 42 }, (_, index) => {
    const day = new Date(year, monthNumber - 1, index - firstOffset + 1);
    return {
      date: `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`,
      day: day.getDate(),
      outside: day.getMonth() !== monthNumber - 1,
    };
  });
  const moveMonth = (direction: number) => {
    const next = new Date(year, monthNumber - 1 + direction, 1);
    setMonth(`${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, "0")}`);
  };
  useEffect(() => {
    const close = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, []);
  return <div className="custom-date-picker" ref={rootRef}>
    <button type="button" className={`custom-date-trigger ${open ? "open" : ""}`} aria-haspopup="dialog" aria-expanded={open} onClick={() => { setMonth(value.slice(0, 7)); setOpen((current) => !current); }}>
      <CalendarDays size={16} /><span><small>{label}</small><b>{formatDate(value, true)}</b></span>
    </button>
    {open && <div className="custom-calendar-popover" role="dialog" aria-label={label}>
      <div className="custom-calendar-head"><button type="button" onClick={() => moveMonth(-1)} aria-label="Previous month"><ArrowLeft size={16} /></button><strong>{new Intl.DateTimeFormat("en-PH", { month: "long", year: "numeric" }).format(new Date(year, monthNumber - 1, 1))}</strong><button type="button" onClick={() => moveMonth(1)} aria-label="Next month"><ArrowRight size={16} /></button></div>
      <div className="custom-calendar-weekdays">{["M", "T", "W", "T", "F", "S", "S"].map((day, index) => <span key={`${day}-${index}`}>{day}</span>)}</div>
      <div className="custom-calendar-grid">{cells.map((cell) => <button type="button" className={`${cell.outside ? "outside" : ""} ${cell.date === localDate() ? "today" : ""} ${cell.date === value ? "selected" : ""}`} aria-pressed={cell.date === value} key={cell.date} onClick={() => { onChange(cell.date); setOpen(false); }}>{cell.day}</button>)}</div>
      <div className="custom-calendar-foot"><button type="button" onClick={() => { const today = localDate(); onChange(today); setMonth(today.slice(0, 7)); setOpen(false); }}>Today</button></div>
    </div>}
  </div>;
}

function CustomDateRangePicker({ start, end, active, onChange }: { start: string; end: string; active: boolean; onChange: (start: string, end: string) => void }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false), [rangeStart, setRangeStart] = useState<string | null>(null), [month, setMonth] = useState(start.slice(0, 7));
  const [year, monthNumber] = month.split("-").map(Number);
  const firstOffset = (new Date(year, monthNumber - 1, 1).getDay() + 6) % 7;
  const cells = Array.from({ length: 42 }, (_, index) => {
    const day = new Date(year, monthNumber - 1, index - firstOffset + 1);
    return { date: `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`, day: day.getDate(), outside: day.getMonth() !== monthNumber - 1 };
  });
  const moveMonth = (direction: number) => { const next = new Date(year, monthNumber - 1 + direction, 1); setMonth(`${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, "0")}`); };
  const choose = (date: string) => {
    if (!rangeStart) { setRangeStart(date); onChange(date, date); return; }
    const [from, to] = rangeStart <= date ? [rangeStart, date] : [date, rangeStart];
    onChange(from, to); setRangeStart(null); setOpen(false);
  };
  useEffect(() => {
    const close = (event: PointerEvent) => { if (!rootRef.current?.contains(event.target as Node)) { setOpen(false); setRangeStart(null); } };
    document.addEventListener("pointerdown", close); return () => document.removeEventListener("pointerdown", close);
  }, []);
  return <div className="custom-date-picker range-picker" ref={rootRef}><button type="button" className={`custom-date-trigger ${open ? "open" : ""}`} aria-haspopup="dialog" aria-expanded={open} onClick={() => { setMonth(start.slice(0, 7)); setRangeStart(null); setOpen((current) => !current); }}><CalendarDays size={17} /><span><small>Date range</small><b>{active ? `${formatDate(start, true)} – ${formatDate(end, true)}` : "Choose dates"}</b></span></button>
    {open && <div className="custom-calendar-popover" role="dialog" aria-label="Monitoring date range"><div className="custom-calendar-head"><button type="button" onClick={() => moveMonth(-1)} aria-label="Previous month"><ArrowLeft size={16} /></button><strong>{new Intl.DateTimeFormat("en-PH", { month: "long", year: "numeric" }).format(new Date(year, monthNumber - 1, 1))}</strong><button type="button" onClick={() => moveMonth(1)} aria-label="Next month"><ArrowRight size={16} /></button></div><div className="custom-calendar-weekdays">{["M", "T", "W", "T", "F", "S", "S"].map((day, index) => <span key={`${day}-${index}`}>{day}</span>)}</div><div className="custom-calendar-grid">{cells.map((cell) => { const selectedStart = cell.date === (rangeStart || (active ? start : "")); const selectedEnd = !rangeStart && active && cell.date === end; const inRange = active && !rangeStart && cell.date >= start && cell.date <= end; return <button type="button" className={`${cell.outside ? "outside" : ""} ${cell.date === localDate() ? "today" : ""} ${selectedStart || selectedEnd ? "selected" : ""} ${inRange ? "in-range" : ""}`} key={cell.date} onClick={() => choose(cell.date)}>{cell.day}</button>; })}</div><div className="custom-calendar-foot"><span>{rangeStart ? "Select the end date" : "Select the start date"}</span></div></div>}
  </div>;
}

function ScheduleTimeline({ shipments, anchorDate, mode, showPending, onOpenShipment }: { shipments: Shipment[]; anchorDate: string; mode: "day" | "week"; showPending: boolean; onOpenShipment: (shipment: Shipment) => void }) {
  const dayStart = 0, dayEnd = 24 * 60;
  const days = mode === "day" ? [anchorDate] : Array.from({ length: 7 }, (_, index) => addDays(startOfWeek(anchorDate), index));
  const hours = Array.from({ length: 25 }, (_, index) => index);
  return <div className={`schedule-timeline mode-${mode} unified-schedule`}>
    <div className="schedule-time-corner"><Clock3 size={15} /></div>
    {days.map((day) => <div className={`schedule-day-title ${day === localDate() ? "today" : ""}`} key={day}><small>{new Intl.DateTimeFormat("en-PH", { weekday: "short" }).format(new Date(`${day}T12:00:00`))}</small><b>{new Date(`${day}T12:00:00`).getDate()}</b></div>)}
    <div className="schedule-time-axis">{hours.map((hour) => <span style={{ top: `${hour / 24 * 100}%` }} key={hour}>{clockLabel(hour)}</span>)}</div>
    {days.map((day) => <div className="schedule-day-lane" key={day}>
      {hours.slice(0, -1).map((hour) => <i style={{ top: `${hour / 24 * 100}%` }} key={hour} />)}
      {layoutDayBookings(shipments.filter((shipment) => shipment.bookingStatus === "APPROVED" || (showPending && ["PENDING_SUPPLIER", "PENDING_COMPANY"].includes(shipment.bookingStatus || ""))), day).map(({ shipment, lane, lanes, start, end }) => {
        const pendingSupplier = shipment.bookingStatus === "PENDING_SUPPLIER";
        const pendingCompany = shipment.bookingStatus === "PENDING_COMPANY";
        const pending = pendingSupplier || pendingCompany;
        return <button type="button" className={`schedule-entry ${pending ? "proposal" : "approved"}`} style={{ "--event-hue": colorFor(shipment), top: `${Math.max(dayStart, start) / dayEnd * 100}%`, height: `${Math.max(2.1, (Math.min(dayEnd, end) - Math.max(dayStart, start)) / dayEnd * 100)}%`, left: `calc(${lane / lanes * 100}% + 4px)`, width: `calc(${100 / lanes}% - 8px)` } as CSSProperties} key={shipment.id} onClick={() => onOpenShipment(shipment)}><b>{shipment.scheduledTime}</b><span>{pendingCompany ? "Company review" : pendingSupplier ? "Waiting for Confirmation" : shipment.truckPlate}</span><small>{shipment.supplier}{pending ? " · not booked yet" : " · booked"}</small></button>;
      })}
    </div>)}
  </div>;
}

export type SupplierResponsePayload = {
  decision: "ACCEPT" | "PROPOSE_ALTERNATIVE";
  reason?: string;
  changeReason?: string;
  alternativeDate?: string;
  alternativeTime?: string;
  alternativeEndTime?: string;
  quantityAllocations?: import("./types").QuantityAllocation[];
  loadConfirmed?: boolean;
  trucks?: { truckPlate: string; driverName: string; driverPhone: string; helper1Name?: string; helper2Name?: string; poNumber?: string; drNumber?: string; itemIds: number[]; itemQuantities?: { itemId: number; quantity: number }[] }[];
};

export const SupplierSdsModal = SupplierConfirmation;

export type CompanyDecisionPayload = { decision: "APPROVE" | "REJECT"; reason?: string };

export function CompanyDecisionModal({ shipment, onClose, onSubmit }: { shipment: Shipment; onClose: () => void; onSubmit: (shipment: Shipment, payload: CompanyDecisionPayload) => Promise<void> | void }) {
  const [decision, setDecision] = useState<"APPROVE" | "REJECT">("APPROVE");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error,setError]=useState("");
  const [attempted, setAttempted] = useState(false);
  const valid = decision === "APPROVE" || Boolean(reason.trim());
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setAttempted(true);
    if (!valid || busy) return;
    setBusy(true);setError("");
    try {
      await onSubmit(shipment, { decision, reason: reason.trim() || undefined });
      onClose();
    } catch(error) {setError(error instanceof Error ? error.message : "Could not save the decision");} finally { setBusy(false); }
  };
  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    document.body.style.overflow = "hidden";
    document.addEventListener("keydown", escape);
    return () => { document.body.style.overflow = previousOverflow; document.removeEventListener("keydown", escape); };
  }, [onClose]);
  const dialog = <div className="modal-backdrop sds-fullscreen-backdrop" role="presentation"><section className="modal company-decision-modal" role="dialog" aria-modal="true" aria-label="Review supplier reschedule request"><div className="modal-head"><div><h2>Review reschedule request</h2><p>{shipment.supplier} · {shipment.shipmentNumber}</p></div><button type="button" className="icon-button" onClick={onClose} aria-label="Close"><X size={20} /></button></div><form onSubmit={submit} className="company-decision-form">
    <div className="company-proposal-summary"><div className="company-schedule-card original"><small>Original schedule</small><b>{formatDate(shipment.scheduledDate, true)}</b><span>{shipment.scheduledTime}</span></div><ArrowRight size={22} /><div className="company-schedule-card proposed"><small>Supplier proposal</small><b>{shipment.alternativeDate ? formatDate(shipment.alternativeDate, true) : "Not provided"}</b><span>{shipment.alternativeTime || "—"}{shipment.alternativeEndTime ? `–${shipment.alternativeEndTime}` : ""}</span></div></div>
    {shipment.quantityAllocations?.length ? <div className="allocation-section"><h3>Proposed quantities and schedules</h3>{shipment.quantityAllocations.map((row, index) => <div className="allocation-row" key={index}><b>{row.materialCode}</b><span>{row.quantity} {row.uom}</span><span>{row.cannotDeliver ? `Can’t deliver · ${row.reason || "Reason not provided"}` : `${row.date} · ${row.time}`}</span></div>)}</div> : null}
    <div className="company-reason-card"><AlertTriangle size={18} /><span><small>Supplier reason</small><b>{shipment.supplierResponseReason || "No reason recorded"}</b></span></div>
    <div className="company-decision-choices"><button type="button" className={decision === "APPROVE" ? "active approve" : ""} onClick={() => setDecision("APPROVE")}><Check size={18} /><span><b>Approve reschedule</b></span></button><button type="button" className={decision === "REJECT" ? "active reject" : ""} onClick={() => setDecision("REJECT")}><X size={18} /><span><b>Reject reschedule</b></span></button></div>
    {decision === "REJECT" && <label className="company-decision-reason">Reason for rejection<textarea value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Explain why the proposed time cannot be approved" autoFocus /></label>}
    {error&&<p className="form-error" role="alert">{error}</p>}<div className="company-decision-actions">{attempted && !valid && <span className="form-error"><AlertTriangle size={16} />A rejection reason is required.</span>}<div><button type="button" className="button secondary" onClick={onClose}>Cancel</button><button className={`button ${decision === "APPROVE" ? "primary" : "danger"}`} disabled={busy}>{busy ? <Loader2 className="spin" size={17} /> : decision === "APPROVE" ? <Check size={17} /> : <X size={17} />}{decision === "APPROVE" ? "Approve reschedule" : "Reject reschedule"}</button></div></div>
  </form></section></div>;
  return createPortal(dialog, document.body);
}

function SdsWorkflowPanel({ data, onOpenShipment, onReviewAlternative }: { data: AppData; onOpenShipment: (shipment: Shipment) => void; onReviewAlternative: (shipment: Shipment) => void }) {
  const [open,setOpen]=useState(false),[query,setQuery]=useState("");
  const companyReview=data.shipments.filter(row=>row.bookingStatus === "PENDING_COMPANY");
  const unlinked=data.shipments.filter(row=>row.bookingStatus === "PENDING_SUPPLIER" && row.supplierAccountLinked === false);
  return <div className="sds-actions"><button className="button secondary reschedule-trigger" onClick={()=>setOpen(true)}><CalendarDays size={17}/> Rescheduling <span className={companyReview.length?"review-count pending":"review-count"}>{companyReview.length}</span></button>{unlinked.length>0&&<details className="unlinked-accounts"><summary>{unlinked.length} schedules need a supplier account</summary>{unlinked.map(row=><button key={row.id} onClick={()=>onOpenShipment(row)}>{row.supplier}</button>)}</details>}{open&&<Dialog title={`Rescheduling · ${companyReview.length} requests`} close={()=>setOpen(false)}><div className="reschedule-popup"><label className="search-box"><Search size={17}/><input placeholder="Search supplier or shipment" value={query} onChange={event=>setQuery(event.target.value)}/></label><div className="reschedule-list">{companyReview.filter(row=>`${row.supplier} ${row.shipmentNumber}`.toLowerCase().includes(query.toLowerCase())).map(row=><button key={row.id} onClick={()=>{setOpen(false);onReviewAlternative(row);}}><span className="supplier-dot" style={{background:`hsl(${colorFor(row)} 65% 48%)`}}/><span><b>{row.supplier}</b><small>{row.shipmentNumber} · {row.items.length} codes</small></span><span><small>{row.scheduledDate} · {row.scheduledTime}</small><b>{row.alternativeDate||row.scheduledDate} · {row.alternativeTime||row.scheduledTime}</b></span><ArrowRight size={17}/></button>)}{!companyReview.length&&<p>No rescheduling requests waiting.</p>}</div></div></Dialog>}</div>;
}

export function FlexibleSchedulePage({ data, user, onOpenShipment, onImportSds, onReviewAlternative }: { data: AppData; user: SessionUser; onOpenShipment: (shipment: Shipment) => void; onImportSds: () => void; onReviewAlternative: (shipment: Shipment) => void }) {
  const [date, setDate] = useState(data.settings.availableDates.find((item) => item >= localDate()) || localDate());
  const [mode, setMode] = useState<"day" | "week">("week");
  const canImport = ["admin", "planner", "production"].includes(user.role);
  const canReviewCompany = ["admin", "planner", "production"].includes(user.role);
  const move = (direction: number) => setDate(addDays(date, direction * (mode === "day" ? 1 : 7)));
  const visibleDates = mode === "day" ? [date] : Array.from({ length: 7 }, (_, index) => addDays(startOfWeek(date), index));
  const bookingCount = data.shipments.filter((shipment) => visibleDates.includes(shipment.scheduledDate) && shipment.bookingStatus === "APPROVED" && shipment.status !== "REJECTED").length;
  const period = mode === "day" ? formatDate(date) : `${formatDate(startOfWeek(date), true)} – ${formatDate(addDays(startOfWeek(date), 6), true)}`;
  const pendingSupplierBookings = ["supplier", "ecosystem"].includes(user.role) ? data.shipments.filter((shipment) => shipment.bookingStatus === "PENDING_SUPPLIER").sort((a, b) => `${a.scheduledDate}${a.scheduledTime}`.localeCompare(`${b.scheduledDate}${b.scheduledTime}`)) : [];
  return <div className="page-stack">
    <section className="hero-row"><div><span className="eyebrow">Scheduling center</span><h1>Delivery schedule</h1></div></section>
    {pendingSupplierBookings.length > 0 && <section className="panel supplier-booking-queue"><div className="panel-head"><div><span className="eyebrow">Action required</span><h2>Deliveries waiting for your confirmation</h2></div><span className="count-chip">{pendingSupplierBookings.length} pending</span></div><div className="supplier-booking-list">{pendingSupplierBookings.map((shipment) => <button type="button" key={shipment.id} onClick={() => onOpenShipment(shipment)}><span className="booking-date"><b>{formatDate(shipment.scheduledDate, true)}</b><small>{shipment.scheduledTime}</small></span><span className="booking-materials"><small>Material code{shipment.items.length === 1 ? "" : "s"}</small><b>{shipment.items.map((item) => item.materialCode).join(", ")}</b></span><strong>Review & confirm <ArrowRight size={16} /></strong></button>)}</div></section>}
    <section className="panel schedule-board overlap-schedule schedule-section-panel unified">
      <div className="panel-head schedule-board-head"><div><span className="eyebrow">{period}</span><h2>Booked delivery schedule</h2></div><div className="schedule-view-controls schedule-command-bar"><span className="approved-delivery-count"><i/><b>{bookingCount}</b> Approved Deliveries</span>{canReviewCompany&&<SdsWorkflowPanel data={data} onOpenShipment={onOpenShipment} onReviewAlternative={onReviewAlternative}/>}<div className="view-toggle"><button className={mode === "day" ? "active" : ""} onClick={() => setMode("day")}>Day</button><button className={mode === "week" ? "active" : ""} onClick={() => setMode("week")}>Week</button></div><div className="date-stepper"><button type="button" onClick={() => move(-1)} aria-label={`Previous ${mode}`}><ArrowLeft size={17} /></button><CustomDatePicker value={date} onChange={setDate} label="Schedule date" /><button type="button" onClick={() => move(1)} aria-label={`Next ${mode}`}><ArrowRight size={17} /></button></div>{canImport&&<button className="button primary import-sds-button" onClick={onImportSds}><FileSpreadsheet size={17}/> Import SDS</button>}</div></div>
      <div className="supplier-legend">{Array.from(new Map(data.shipments.filter(row=>visibleDates.includes(row.scheduledDate)).map(row=>[row.supplierId||row.supplier,row])).values()).map(row=><span key={row.supplierId||row.supplier}><i style={{background:`hsl(${colorFor(row)} 65% 48%)`}}/>{row.supplier}</span>)}</div>
      {mode === "day" && <div className="schedule-day-details">{data.shipments.filter(row=>row.scheduledDate===date && row.bookingStatus!=="REJECTED").sort((a,b)=>a.scheduledTime.localeCompare(b.scheduledTime)).map(row=><button key={row.id} style={{borderLeftColor:`hsl(${colorFor(row)} 65% 48%)`}} onClick={()=>onOpenShipment(row)}><b>{row.scheduledTime}</b><span><strong>{row.supplier}</strong><small>{row.items.map(item=>`${item.materialCode} · ${item.quantity} ${item.uom}`).join(" / ")}</small></span><span>{row.truckPlate||"Waiting for Confirmation"}<small>{row.shipmentNumber}</small></span></button>)}</div>}
      <div className="schedule-timeline-viewport"><ScheduleTimeline shipments={data.shipments} anchorDate={date} mode={mode} showPending={["admin", "planner", "supplier", "ecosystem"].includes(user.role)} onOpenShipment={onOpenShipment} /></div>
    </section>
  </div>;
}

export function MonitoringPage({ data, theme, onOpenShipment }: { data: AppData; theme: "light" | "dark"; onOpenShipment: (shipment: Shipment) => void }) {
  const [dateFilter, setDateFilter] = useState(false), [rangeStart, setRangeStart] = useState(localDate()), [rangeEnd, setRangeEnd] = useState(localDate()), [query, setQuery] = useState(""), [status, setStatus] = useState<ShipmentStatus | "ALL">("ALL"), [fullscreen, setFullscreen] = useState(false);
  const fullscreenRef = useRef<HTMLDivElement>(null);
  useEffect(() => { const changed = () => { if (!document.fullscreenElement) setFullscreen(false); }; document.addEventListener("fullscreenchange", changed); return () => document.removeEventListener("fullscreenchange", changed); }, []);
  const enterFullscreen = async () => { setFullscreen(true); await fullscreenRef.current?.requestFullscreen?.().catch(() => undefined); }, exitFullscreen = async () => { if (document.fullscreenElement) await document.exitFullscreen().catch(() => undefined); setFullscreen(false); };
  const openMonitoringEntry = async (shipment: Shipment) => {
    // A modal mounted outside the browser's fullscreen element cannot be shown.
    // Leave fullscreen first, then open the delivery details normally.
    if (document.fullscreenElement) await document.exitFullscreen().catch(() => undefined);
    setFullscreen(false);
    onOpenShipment(shipment);
  };
  const active = useMemo(() => data.shipments.filter((shipment) => shipment.bookingStatus === "APPROVED" && !["GATE_OUT", "REJECTED"].includes(shipment.status)), [data.shipments]);
  const rows = useMemo(() => active.filter((shipment) => !dateFilter || (shipment.scheduledDate >= rangeStart && shipment.scheduledDate <= rangeEnd)).filter((shipment) => status === "ALL" || shipment.status === status).filter((shipment) => `${shipment.shipmentNumber} ${shipment.bookingReceipt} ${shipment.supplier} ${shipment.truckPlate} ${shipment.driverName} ${shipment.driverPhone} ${shipment.items.map((item) => item.materialCode).join(" ")}`.toLowerCase().includes(query.toLowerCase())).sort((a, b) => { if (!dateFilter) { const group = (value: string) => value === localDate() ? 0 : value > localDate() ? 1 : 2; const difference = group(a.scheduledDate) - group(b.scheduledDate); if (difference) return difference; } const dateDifference = a.scheduledDate.localeCompare(b.scheduledDate); if (dateDifference) return dateDifference; const rankDifference = processRank[b.status] - processRank[a.status]; return rankDifference || a.scheduledTime.localeCompare(b.scheduledTime); }), [active, dateFilter, rangeStart, rangeEnd, status, query]);
  return <div ref={fullscreenRef} className={`page-stack monitoring-page tv-${theme} ${fullscreen ? "tv-mode" : ""}`}>
    {!fullscreen && <section className="hero-row"><div><span className="eyebrow">Truck movement board</span><h1>Delivery monitoring</h1></div><div className="hero-actions"><span className="operation-live"><span className="live-dot" /><span>Live status</span></span><button className="icon-button fullscreen-trigger" onClick={enterFullscreen} aria-label="Open fullscreen monitoring" title="Fullscreen"><Maximize2 size={19} /></button></div></section>}
    {fullscreen && <header className="monitor-tv-header">
      <div className="monitor-tv-brand"><span className="eyebrow">Live receiving board</span><h1>{data.settings.siteName}</h1><span className="monitor-tv-live"><i className="live-dot" />{rows.length} active deliver{rows.length === 1 ? "y" : "ies"}</span></div>
      <LiveClock className="monitor-tv-clock" showZone={false} showDate />
      <button className="monitor-tv-exit" onClick={exitFullscreen} aria-label="Exit fullscreen" title="Exit fullscreen"><Minimize2 size={22} /></button>
    </header>}
    {!fullscreen && <section className="monitor-status-strip">{statusOrder.filter((item) => !["PROPOSED", "GATE_OUT", "REJECTED"].includes(item)).map((item) => <button key={item} className={status === item ? "active" : ""} onClick={() => setStatus(status === item ? "ALL" : item)}><StatusPill status={item} /><b>{active.filter((shipment) => shipment.status === item).length}</b></button>)}</section>}
    <section className="panel monitoring-panel">
      {!fullscreen && <div className="monitor-toolbar">
        <label className="search-box"><Search size={17} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search truck, delivery, supplier, driver or product" /></label>
        <div className="monitor-date-system"><button className={`see-all-button ${!dateFilter ? "active" : ""}`} onClick={() => setDateFilter(false)}>See all</button><CustomDateRangePicker start={rangeStart} end={rangeEnd} active={dateFilter} onChange={(start, end) => { setRangeStart(start); setRangeEnd(end); setDateFilter(true); }} /></div>
      </div>}
      <div className="monitor-grid">{rows.map((shipment) => {
        const position = journeyPosition[shipment.status];
        const timeOfDayTraffic = shipment.etaTrafficModel === "TIME_OF_DAY";
        const trafficSuffix = timeOfDayTraffic
          ? shipment.estimatedTrafficDelayMinutes
            ? ` · +${shipment.estimatedTrafficDelayMinutes} min estimated traffic`
            : " · estimated traffic"
          : " · base road time";
        const showEta = false;
        return <button className={`monitor-delivery-card monitor-tone-${STATUS_META[shipment.status].color}`} key={shipment.id} onClick={() => void openMonitoringEntry(shipment)}>
          <span className="monitor-card-head">
            <span><small>{formatDate(shipment.scheduledDate)}</small><b>{shipment.scheduledTime}</b></span>
            <span className="monitor-card-meta">
              <span className={`monitor-eta-top ${showEta ? "" : "hidden"}`} aria-hidden={!showEta}><Clock3 size={14} /><span><small>{timeOfDayTraffic ? "Traffic ETA" : "ETA"}</small><b>{showEta && shipment.estimatedArrivalAt ? `${formatEta(shipment.estimatedArrivalAt)} · ${shipment.estimatedTravelMinutes} min` : "ETA pending"}{showEta ? ` · ${shipment.estimatedTravelDistanceKm || "—"} km${trafficSuffix}` : ""}</b></span></span>
              {shipment.bookingStatus !== "APPROVED" ? <span className="approval-chip pending">Approval pending</span> : <StatusPill status={shipment.status} receipt={shipment.receipt} />}
            </span>
          </span>
          <span className="monitor-card-shipment"><span className="truck-tile"><Truck size={19} /></span><span><b>{shipment.truckPlate}</b><small>{shipment.supplier}</small></span><ArrowRight size={17} /></span>
          <span className="monitor-card-facts"><span><small>Delivery</small><b>{shipment.shipmentNumber}</b></span><span><small>Driver</small><b>{shipment.driverName}</b></span><span><small>Phone</small><b>{shipment.driverPhone || "—"}</b></span><span><small>Products</small><b>{shipment.items.length}</b></span></span>
          <span className="monitor-card-material"><b>{shipment.items.map((item) => item.materialCode).join(", ") || "Materials pending"}</b><small>{shipment.items.map((item) => `${item.quantity.toLocaleString()} ${item.uom}`).join(" · ")}</small></span>
          <span className={`monitor-progress ${shipment.status === "REJECTED" ? "rejected" : ""}`}>{journeySteps.map((step, index) => { const stepNumber = index + 1; return <span className={position > stepNumber ? "complete" : position === stepNumber ? "current" : ""} key={step}><i>{position > stepNumber ? "✓" : stepNumber}</i><small>{step}</small></span>; })}</span>
        </button>;
      })}</div>
      {!rows.length && <div className="feature-empty"><CalendarDays size={24} /><strong>No matching trucks</strong><span>Change the date or filters to view another delivery.</span></div>}
    </section>
  </div>;
}

export function HistoryPage({ data, onOpenShipment }: { data: AppData; user: SessionUser; onOpenShipment: (shipment: Shipment) => void }) {
  const [query, setQuery] = useState("");
  const [material, setMaterial] = useState("ALL"), [driver, setDriver] = useState("ALL");
  const [fromDate, setFromDate] = useState(""), [toDate, setToDate] = useState("");
  const received = useMemo(() => data.shipments.filter((shipment) => ["RECEIVED", "GATE_OUT"].includes(shipment.status)).sort((a, b) => String(b.gateOutAt || b.receivedAt || "").localeCompare(String(a.gateOutAt || a.receivedAt || ""))), [data.shipments]);
  const rejected = useMemo(() => data.shipments.filter((shipment) => shipment.status === "REJECTED").sort((a, b) => `${b.scheduledDate}${b.scheduledTime}`.localeCompare(`${a.scheduledDate}${a.scheduledTime}`)), [data.shipments]);
  const source = [...received, ...rejected].sort((a, b) => `${b.scheduledDate}${b.scheduledTime}`.localeCompare(`${a.scheduledDate}${a.scheduledTime}`));
  const materials = [...new Set(source.flatMap((shipment) => shipment.items.map((item) => item.materialCode)).filter(Boolean))].sort();
  const drivers = [...new Set(source.map((shipment) => shipment.driverName).filter((value) => value && value !== "To be assigned"))].sort();
  const rows = source.filter((shipment) => {
    const searchable = `${shipment.shipmentNumber} ${shipment.bookingReceipt} ${shipment.supplier} ${shipment.truckPlate} ${shipment.driverName} ${shipment.driverPhone} ${shipment.items.map((item) => item.materialCode).join(" ")} ${shipment.rejectionReason || ""}`.toLowerCase();
    return searchable.includes(query.trim().toLowerCase()) && (material === "ALL" || shipment.items.some((item) => item.materialCode === material)) && (driver === "ALL" || shipment.driverName === driver) && (!fromDate || shipment.scheduledDate >= fromDate) && (!toDate || shipment.scheduledDate <= toDate);
  });
  const clearFilters = () => { setQuery(""); setMaterial("ALL"); setDriver("ALL"); setFromDate(""); setToDate(""); };
  return <div className="page-stack history-page">
    <section className="hero-row history-hero"><div><span className="eyebrow">Delivery records</span><h1>History</h1></div><div className="history-total-card compact" aria-label={`${source.length} total delivery records`}><History size={18} /><span><b>{source.length}</b> total</span></div></section>
    <section className="panel history-panel">
      <div className="history-filter-panel compact">
        <label className="search-box history-search"><Search size={17} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search delivery" /></label>
        <label><span>Material</span><select value={material} onChange={(event) => setMaterial(event.target.value)}><option value="ALL">All materials</option>{materials.map((value) => <option value={value} key={value}>{value}</option>)}</select></label>
        <label><span>Driver</span><select value={driver} onChange={(event) => setDriver(event.target.value)}><option value="ALL">All drivers</option>{drivers.map((value) => <option value={value} key={value}>{value}</option>)}</select></label>
        <label><span>From</span><input type="date" value={fromDate} max={toDate || undefined} onChange={(event) => setFromDate(event.target.value)} /></label>
        <label><span>To</span><input type="date" value={toDate} min={fromDate || undefined} onChange={(event) => setToDate(event.target.value)} /></label>
        <button type="button" className="button secondary compact" onClick={clearFilters}>Clear</button>
      </div>
      <div className="table-wrap"><table><thead><tr><th>Date & time</th><th>Truck / booking</th><th>Supplier</th><th>Materials</th><th>Driver</th><th>Outcome</th><th /></tr></thead><tbody>{rows.map((shipment) => <tr key={shipment.id}><td><b>{formatDate(shipment.scheduledDate, true)}</b><small>{shipment.scheduledTime}</small></td><td><button className="table-link" onClick={() => onOpenShipment(shipment)}>{shipment.truckPlate}</button><small>{shipment.shipmentNumber}</small></td><td>{shipment.supplier}</td><td><b>{shipment.items.map((item) => item.materialCode).join(", ")}</b><small>{shipment.items.length} code{shipment.items.length === 1 ? "" : "s"}</small></td><td>{shipment.driverName}<small>{shipment.driverPhone}</small></td><td>{shipment.status === "REJECTED" ? <span className="rejection-copy">{shipment.rejectionReason || "No reason recorded"}</span> : <StatusPill status={shipment.status} receipt={shipment.receipt} />}</td><td><button className="icon-button" onClick={() => onOpenShipment(shipment)}><ArrowRight size={17} /></button></td></tr>)}</tbody></table></div>
      {!rows.length && <div className="feature-empty"><History size={26} /><strong>No matching records</strong><span>Clear or adjust the filters to see other records.</span></div>}
    </section>
  </div>;
}
