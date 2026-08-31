"use client";

import { AlertTriangle, ArrowLeft, ArrowRight, CalendarDays, Check, Clock3, FileSpreadsheet, History, Loader2, Maximize2, Minimize2, Search, ShieldCheck, Truck, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { localDate } from "./date-utils";
import type { AppData, AvailabilityInput, SessionUser, Shipment, ShipmentStatus } from "./types";

const STATUS_META: Record<ShipmentStatus, { label: string; color: string }> = {
  PROPOSED: { label: "Supplier approval", color: "purple" }, BOOKED: { label: "Booked", color: "slate" }, IN_TRANSIT: { label: "Trip", color: "blue" }, GATE_IN: { label: "Gate in", color: "amber" },
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
const colorFor = (shipment: Shipment) => (`${shipment.supplierId || ""}${shipment.supplier}`.split("").reduce((sum, character) => sum + character.charCodeAt(0), 0) * 47) % 360;

function StatusPill({ status }: { status: ShipmentStatus }) { const meta = STATUS_META[status]; return <span className={`status-pill status-${meta.color}`}><span />{meta.label}</span>; }

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

const minutesToTime = (minutes: number) => {
  const normalized = ((minutes % 1440) + 1440) % 1440;
  return `${String(Math.floor(normalized / 60)).padStart(2, "0")}:${String(normalized % 60).padStart(2, "0")}`;
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

function ScheduleTimeline({ shipments, availableSlots, anchorDate, mode, showPending, onOpenShipment }: { shipments: Shipment[]; availableSlots: AppData["settings"]["availableSlots"]; anchorDate: string; mode: "day" | "week"; showPending: boolean; onOpenShipment: (shipment: Shipment) => void }) {
  const dayStart = 0, dayEnd = 24 * 60;
  const days = mode === "day" ? [anchorDate] : Array.from({ length: 7 }, (_, index) => addDays(startOfWeek(anchorDate), index));
  const hours = Array.from({ length: 25 }, (_, index) => index);
  return <div className={`schedule-timeline mode-${mode} unified-schedule`}>
    <div className="schedule-time-corner"><Clock3 size={15} /></div>
    {days.map((day) => <div className={`schedule-day-title ${day === localDate() ? "today" : ""}`} key={day}><small>{new Intl.DateTimeFormat("en-PH", { weekday: "short" }).format(new Date(`${day}T12:00:00`))}</small><b>{new Date(`${day}T12:00:00`).getDate()}</b></div>)}
    <div className="schedule-time-axis">{hours.map((hour) => <span style={{ top: `${hour / 24 * 100}%` }} key={hour}>{clockLabel(hour)}</span>)}</div>
    {days.map((day) => <div className="schedule-day-lane" key={day}>
      {hours.slice(0, -1).map((hour) => <i style={{ top: `${hour / 24 * 100}%` }} key={hour} />)}
      {availableSlots.filter((slot) => slot.date === day).map((slot) => <div className="schedule-open-window" style={{ top: `${toMinutes(slot.startTime) / 1440 * 100}%`, height: `${Math.max(2.1, (toMinutes(slot.endTime) - toMinutes(slot.startTime)) / 1440 * 100)}%` }} key={slot.id} title={`${slot.startTime}–${slot.endTime} · ${slot.label}`}><b>{slot.startTime}–{slot.endTime}</b><span>{slot.label || "Available for booking"}</span></div>)}
      {shipments.filter((shipment) => shipment.scheduledDate === day && shipment.bookingStatus === "APPROVED" && shipment.status !== "REJECTED").map((shipment) => { const start = toMinutes(shipment.scheduledTime); const end = shipment.scheduledEndTime ? Math.max(start + 30, toMinutes(shipment.scheduledEndTime)) : start + 30; return <span className="schedule-booked-mask" aria-hidden="true" key={`mask-${shipment.id}`} style={{ top: `${start / 1440 * 100}%`, height: `${Math.max(2.1, (end - start) / 1440 * 100)}%` }} />; })}
      {layoutDayBookings(shipments.filter((shipment) => shipment.bookingStatus === "APPROVED" || (showPending && shipment.bookingStatus === "PENDING_SUPPLIER")), day).map(({ shipment, lane, lanes, start, end }) => {
        const pending = shipment.bookingStatus === "PENDING_SUPPLIER";
        return <button type="button" className={`schedule-entry ${pending ? "proposal" : "approved"}`} style={{ "--event-hue": colorFor(shipment), top: `${Math.max(dayStart, start) / dayEnd * 100}%`, height: `${Math.max(2.1, (Math.min(dayEnd, end) - Math.max(dayStart, start)) / dayEnd * 100)}%`, left: `calc(${lane / lanes * 100}% + 4px)`, width: `calc(${100 / lanes}% - 8px)` } as CSSProperties} key={shipment.id} onClick={() => onOpenShipment(shipment)}><b>{shipment.scheduledTime}</b><span>{pending ? "Awaiting supplier" : shipment.truckPlate}</span><small>{shipment.supplier}{pending ? " · not booked yet" : " · booked"}</small></button>;
      })}
    </div>)}
  </div>;
}

export type SupplierResponsePayload = {
  decision: "ACCEPT" | "PROPOSE_ALTERNATIVE";
  reason?: string;
  alternativeDate?: string;
  alternativeTime?: string;
  alternativeEndTime?: string;
  loadConfirmed: boolean;
  trucks: { truckPlate: string; driverName: string; driverPhone: string; itemIds: number[] }[];
};

const PHONE_COUNTRIES = [
  { dial: "+63", label: "PH +63", min: 10, max: 10 },
  { dial: "+1", label: "US/CA +1", min: 10, max: 10 },
  { dial: "+44", label: "UK +44", min: 9, max: 10 },
  { dial: "+61", label: "AU +61", min: 9, max: 9 },
  { dial: "+65", label: "SG +65", min: 8, max: 8 },
  { dial: "+60", label: "MY +60", min: 9, max: 10 },
  { dial: "+62", label: "ID +62", min: 9, max: 12 },
  { dial: "+66", label: "TH +66", min: 9, max: 9 },
  { dial: "+81", label: "JP +81", min: 9, max: 10 },
  { dial: "+82", label: "KR +82", min: 9, max: 10 },
  { dial: "+971", label: "UAE +971", min: 9, max: 9 },
];

export function SupplierSdsModal({ shipment, onClose, onSubmit }: { shipment: Shipment; onClose: () => void; onSubmit: (shipment: Shipment, payload: SupplierResponsePayload) => Promise<void> | void }) {
  const previousLoads = shipment.confirmedTruckLoads || [];
  const remainingItems = shipment.items.filter((item) => !item.supplierApprovedAt);
  const firstLoad = previousLoads.length === 0;
  const [decision, setDecision] = useState<"ACCEPT" | "PROPOSE_ALTERNATIVE">(shipment.supplierResponse === "ALTERNATIVE_PROPOSED" ? "PROPOSE_ALTERNATIVE" : "ACCEPT");
  const [reason, setReason] = useState(shipment.supplierResponseReason || "");
  const [alternativeDate, setAlternativeDate] = useState(shipment.alternativeDate || shipment.scheduledDate);
  const [alternativeTime, setAlternativeTime] = useState(shipment.alternativeTime || shipment.scheduledTime);
  const [alternativeEndTime, setAlternativeEndTime] = useState(shipment.alternativeEndTime || shipment.scheduledEndTime || minutesToTime(toMinutes(shipment.scheduledTime) + 60));
  const [truck, setTruck] = useState({ truckPlate: "", driverName: "" });
  const [countryDial, setCountryDial] = useState("+63");
  const [phoneNumber, setPhoneNumber] = useState("");
  const [selectedItems, setSelectedItems] = useState<number[]>(() => remainingItems.map((item) => item.id));
  const [busy, setBusy] = useState(false), [attempted, setAttempted] = useState(false);
  const country = PHONE_COUNTRIES.find((item) => item.dial === countryDial) || PHONE_COUNTRIES[0];
  const updateTruck = (field: "truckPlate" | "driverName", value: string) => setTruck((current) => ({ ...current, [field]: value }));
  const updatePhone = (value: string) => {
    let digits = value.replace(/\D/g, "");
    if (countryDial === "+63" && digits.startsWith("0")) digits = digits.slice(1);
    setPhoneNumber(digits.slice(0, country.max));
  };
  const validAlternative = decision === "ACCEPT" || Boolean(reason.trim() && alternativeDate && alternativeTime && alternativeEndTime && alternativeEndTime > alternativeTime);
  const validPhone = phoneNumber.length >= country.min && phoneNumber.length <= country.max;
  const validTruck = Boolean(truck.truckPlate.trim() && truck.driverName.trim() && validPhone && selectedItems.length > 0);
  const valid = decision === "PROPOSE_ALTERNATIVE" ? validAlternative : validTruck;
  const validationMessage = !validAlternative ? "Complete the alternative date, time, and reason." : !truck.truckPlate.trim() ? "Enter the truck plate." : !truck.driverName.trim() ? "Enter the driver name." : !validPhone ? "Enter a valid phone number." : !selectedItems.length ? "Select at least one material code for this delivery." : "";
  const submit = async (event: React.FormEvent) => {
    event.preventDefault(); setAttempted(true); if (!valid || busy) return; setBusy(true);
    try {
      await onSubmit(shipment, {
        decision, reason: reason.trim(), alternativeDate, alternativeTime, alternativeEndTime, loadConfirmed: true,
        trucks: decision === "ACCEPT" ? [{ ...truck, driverName: truck.driverName.trim(), driverPhone: `${country.dial}${phoneNumber}`, truckPlate: truck.truckPlate.trim().toUpperCase(), itemIds: selectedItems }] : [],
      });
      onClose();
    } finally { setBusy(false); }
  };
  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    document.body.style.overflow = "hidden";
    document.addEventListener("keydown", escape);
    return () => { document.body.style.overflow = previousOverflow; document.removeEventListener("keydown", escape); };
  }, [onClose]);
  const dialog = <div className="modal-backdrop sds-fullscreen-backdrop" role="presentation"><section className="modal sds-response-modal" role="dialog" aria-modal="true" aria-label="Confirm delivery"><div className="modal-head"><div><h2>Confirm delivery</h2><p>{shipment.supplier} · {formatDate(shipment.scheduledDate, true)} · {shipment.scheduledTime}</p></div><button type="button" className="icon-button" onClick={onClose} aria-label="Close"><X size={20} /></button></div><form className="sds-response-form" onSubmit={submit} noValidate>
    <div className="sds-response-body"><section className="sds-response-column">{firstLoad ? <><div className="sds-choice-row"><button type="button" className={decision === "ACCEPT" ? "active" : ""} onClick={() => setDecision("ACCEPT")}><Check size={17} /><span><b>Accept proposed time</b><small>Use the SDS date and time</small></span></button><button type="button" className={decision === "PROPOSE_ALTERNATIVE" ? "active warning" : ""} onClick={() => setDecision("PROPOSE_ALTERNATIVE")}><CalendarDays size={17} /><span><b>Reject and propose alternative</b><small>Reason and one alternative are required</small></span></button></div>
      {decision === "PROPOSE_ALTERNATIVE" && <div className="sds-alternative-grid"><label>Reason<textarea value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Why the proposed time cannot be used" /></label><label>Alternative date<input type="date" value={alternativeDate} onChange={(event) => setAlternativeDate(event.target.value)} /></label><label>Entrance time<input type="time" value={alternativeTime} onChange={(event) => { const value = event.target.value; setAlternativeTime(value); setAlternativeEndTime(minutesToTime(toMinutes(value) + 60)); }} /></label></div>}</> : <div className="saved-response-note"><Check size={17} /><span><b>Schedule response saved</b>{shipment.supplierResponse === "ALTERNATIVE_PROPOSED" ? `${shipment.alternativeDate} · ${shipment.alternativeTime}` : "Proposed date and time accepted"}</span></div>}
      {decision === "ACCEPT" && previousLoads.length > 0 && <div className="confirmed-load-list">{previousLoads.map((load) => <span key={load.id}><b>{load.truckPlate}</b><small>{load.deliveryCode} · {load.itemIds.length} code{load.itemIds.length === 1 ? "" : "s"}</small></span>)}</div>}
      {decision === "ACCEPT" && <>
      <div className="truck-load-head"><div><span className="eyebrow">Truck details</span><h3>Delivery vehicle and driver</h3></div></div>
      <div className="truck-load-grid single"><article><header><span>{previousLoads.length ? `Truck ${previousLoads.length + 1}` : "First truck"}</span></header><label>Truck plate<input value={truck.truckPlate} onChange={(event) => updateTruck("truckPlate", event.target.value)} placeholder="ABC 1234" /></label><label>Driver name<input value={truck.driverName} onChange={(event) => updateTruck("driverName", event.target.value)} placeholder="Driver name" /></label><label className="phone-number-field">Phone number<span className="phone-input-row"><select aria-label="Country calling code" value={countryDial} onChange={(event) => { const next = PHONE_COUNTRIES.find((item) => item.dial === event.target.value) || PHONE_COUNTRIES[0]; setCountryDial(next.dial); setPhoneNumber((current) => current.slice(0, next.max)); }}>{PHONE_COUNTRIES.map((item) => <option value={item.dial} key={item.dial}>{item.label}</option>)}</select><input aria-label="Phone number" type="tel" inputMode="numeric" pattern="[0-9]*" maxLength={country.max} value={phoneNumber} onChange={(event) => updatePhone(event.target.value)} placeholder="xxxxxxxxxx" /></span></label></article></div>
      </>}
    </section>{decision === "ACCEPT" && <section className="sds-response-column sds-material-column"><div className="material-allocation selectable"><div className="panel-head"><div><span className="eyebrow">Material allocation</span><h3>Codes carried by this truck</h3></div><span className="count-chip">{selectedItems.length}/{remainingItems.length} selected</span></div><div className="material-selection-list">{remainingItems.map((item) => <label key={item.id}><input type="checkbox" checked={selectedItems.includes(item.id)} onChange={() => setSelectedItems((current) => current.includes(item.id) ? current.filter((id) => id !== item.id) : [...current, item.id])} /><span><b>{item.materialCode}</b><small>{item.quantity.toLocaleString()} {item.uom}</small></span></label>)}</div></div><div className="delivery-confirm-note"><Check size={18} /><span><b>One confirmation creates one delivery.</b><small>If another truck is needed, confirm this delivery first, then return for the remaining material codes.</small></span></div></section>}
    </div><div className="sds-response-actions">{attempted && !valid ? <div className="form-error"><AlertTriangle size={16} />{validationMessage}</div> : <span className="sds-ready-note">{decision === "PROPOSE_ALTERNATIVE" ? "The rejection and alternative time are ready to send." : valid ? `${selectedItems.length} material code${selectedItems.length === 1 ? "" : "s"} ready` : `${remainingItems.length} material code${remainingItems.length === 1 ? "" : "s"} available`}</span>}<div><button type="button" className="button secondary" onClick={onClose}>Cancel</button><button className={`button ${decision === "PROPOSE_ALTERNATIVE" ? "danger" : "primary"}`} disabled={busy}>{busy ? <Loader2 className="spin" size={17} /> : decision === "PROPOSE_ALTERNATIVE" ? <AlertTriangle size={17} /> : <Check size={17} />} {decision === "PROPOSE_ALTERNATIVE" ? "Reject & send alternative" : "Confirm Delivery"}</button></div></div>
  </form></section></div>;
  return createPortal(dialog, document.body);
}

function SdsWorkflowPanel({ data, onImportSds, onOpenShipment }: { data: AppData; onImportSds: () => void; onOpenShipment: (shipment: Shipment) => void }) {
  const supplierPending = data.shipments.filter((shipment) => shipment.bookingStatus === "PENDING_SUPPLIER");
  const unlinked = supplierPending.filter((shipment) => shipment.supplierAccountLinked === false);
  const nowKey = `${localDate()}${new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Manila" })}`;
  const confirmed = data.shipments.filter((shipment) => shipment.bookingStatus === "APPROVED" && shipment.status === "BOOKED" && `${shipment.scheduledDate}${shipment.scheduledTime}` >= nowKey).sort((a, b) => String(b.supplierRespondedAt || b.finalDecisionAt || "").localeCompare(String(a.supplierRespondedAt || a.finalDecisionAt || "")));
  const rejected = data.shipments.filter((shipment) => shipment.bookingStatus === "REJECTED" || shipment.status === "REJECTED").sort((a, b) => String(b.supplierRespondedAt || "").localeCompare(String(a.supplierRespondedAt || "")));
  return <section className="sds-command-grid"><article className="panel sds-import-panel"><div className="panel-head"><div><span className="eyebrow">SDS workflow</span><h2>Import & account checks</h2></div><button className="button primary" onClick={onImportSds}><FileSpreadsheet size={17} /> Import SDS</button></div>{unlinked.length ? <div className="sds-account-issues">{unlinked.map((shipment) => <button key={shipment.id} onClick={() => onOpenShipment(shipment)}><AlertTriangle size={16} /><span><b>{shipment.supplier}</b><small>No supplier account · {formatDate(shipment.scheduledDate, true)} {shipment.scheduledTime}</small></span></button>)}</div> : <div className="feature-empty management-empty"><ShieldCheck size={24} /><strong>No account issues</strong><span>Every imported supplier is linked to an account.</span></div>}</article>
    <article className="panel sds-outcomes-panel"><div className="panel-head"><div><span className="eyebrow">Supplier responses</span><h2>Confirmed and rejected</h2></div><span className="count-chip">{confirmed.length + rejected.length} responses</span></div><div className="sds-outcome-columns"><section className="confirmed"><header><span className="outcome-icon"><Check size={16} /></span><div><b>Confirmed</b><small>Upcoming accepted deliveries</small></div><span className="outcome-count">{confirmed.length}</span></header><div className="sds-response-scroll">{confirmed.map((shipment) => <button className="sds-response-row" key={shipment.id} onClick={() => onOpenShipment(shipment)}><span className="response-status-icon"><Check size={15} /></span><span className="response-copy"><b>{shipment.supplier}</b><small>{shipment.scheduledDate} · {shipment.scheduledTime}</small><em>{shipment.truckPlate}</em></span><span className="response-open">View <ArrowRight size={14} /></span></button>)}{!confirmed.length && <span className="outcome-empty"><Check size={18} />No upcoming confirmations</span>}</div></section><section className="rejected"><header><span className="outcome-icon"><X size={16} /></span><div><b>Rejected / unavailable</b><small>Alternative schedules requested</small></div><span className="outcome-count">{rejected.length}</span></header><div className="sds-response-scroll">{rejected.map((shipment) => <button className="sds-response-row" key={shipment.id} onClick={() => onOpenShipment(shipment)}><span className="response-status-icon"><X size={15} /></span><span className="response-copy"><b>{shipment.supplier}</b><small>Original: {shipment.scheduledDate} · {shipment.scheduledTime}</small><em>{shipment.rejectionReason || "Reason not recorded"}</em></span><span className="response-proposed"><small>Proposed</small><strong>{shipment.alternativeDate || "—"}</strong><em>{shipment.alternativeTime || "—"}</em><ArrowRight size={14} /></span></button>)}{!rejected.length && <span className="outcome-empty"><Check size={18} />No rejected schedules</span>}</div></section></div></article>
  </section>;
}

export function FlexibleSchedulePage({ data, user, onOpenShipment, onImportSds }: { data: AppData; user: SessionUser; onOpenShipment: (shipment: Shipment) => void; onSaveAvailability: (slot: AvailabilityInput) => Promise<void> | void; onDeleteAvailability: (id: number) => Promise<void> | void; onMoveShipment: (shipment: Shipment, date: string, startTime: string, endTime: string) => Promise<void> | void; onImportSds: () => void }) {
  const [date, setDate] = useState(data.settings.availableDates.find((item) => item >= localDate()) || localDate());
  const [mode, setMode] = useState<"day" | "week">("week");
  const canImport = ["admin", "planner"].includes(user.role);
  const move = (direction: number) => setDate(addDays(date, direction * (mode === "day" ? 1 : 7)));
  const visibleDates = mode === "day" ? [date] : Array.from({ length: 7 }, (_, index) => addDays(startOfWeek(date), index));
  const bookingCount = data.shipments.filter((shipment) => visibleDates.includes(shipment.scheduledDate) && shipment.bookingStatus === "APPROVED" && shipment.status !== "REJECTED").length;
  const availabilityCount = data.settings.availableSlots.filter((slot) => visibleDates.includes(slot.date)).length;
  const period = mode === "day" ? formatDate(date) : `${formatDate(startOfWeek(date), true)} – ${formatDate(addDays(startOfWeek(date), 6), true)}`;
  const pendingSupplierBookings = user.role === "supplier" ? data.shipments.filter((shipment) => shipment.bookingStatus === "PENDING_SUPPLIER").sort((a, b) => `${a.scheduledDate}${a.scheduledTime}`.localeCompare(`${b.scheduledDate}${b.scheduledTime}`)) : [];
  return <div className="page-stack">
    <section className="hero-row"><div><span className="eyebrow">Scheduling center</span><h1>Delivery schedule</h1></div><div className="schedule-hero-actions"><div className="schedule-view-controls"><div className="view-toggle"><button className={mode === "day" ? "active" : ""} onClick={() => setMode("day")}>Day</button><button className={mode === "week" ? "active" : ""} onClick={() => setMode("week")}>Week</button></div><div className="date-stepper"><button type="button" onClick={() => move(-1)} aria-label={`Previous ${mode}`}><ArrowLeft size={17} /></button><CustomDatePicker value={date} onChange={setDate} label="Schedule date" /><button type="button" onClick={() => move(1)} aria-label={`Next ${mode}`}><ArrowRight size={17} /></button></div></div></div></section>
    {canImport && <SdsWorkflowPanel data={data} onImportSds={onImportSds} onOpenShipment={onOpenShipment} />}
    {pendingSupplierBookings.length > 0 && <section className="panel supplier-booking-queue"><div className="panel-head"><div><span className="eyebrow">Action required</span><h2>Deliveries waiting for your confirmation</h2></div><span className="count-chip">{pendingSupplierBookings.length} pending</span></div><div className="supplier-booking-list">{pendingSupplierBookings.map((shipment) => <button type="button" key={shipment.id} onClick={() => onOpenShipment(shipment)}><span className="booking-date"><b>{formatDate(shipment.scheduledDate, true)}</b><small>{shipment.scheduledTime}</small></span><span><b>{shipment.items.length} material code{shipment.items.length === 1 ? "" : "s"}</b><small>{shipment.items.map((item) => item.materialCode).join(", ")}</small></span><strong>Review & confirm <ArrowRight size={16} /></strong></button>)}</div></section>}
    <section className="panel schedule-board overlap-schedule schedule-section-panel unified">
      <div className="panel-head"><div><span className="eyebrow">{period}</span><h2>{canImport ? "Delivery schedule" : "Times available to book"}</h2></div><span className="policy-chip"><Clock3 size={14} /> Manila time · GMT+8</span></div>
      <div className="schedule-calendar-summary"><span className="availability"><i /><b>{availabilityCount}</b> open window{availabilityCount === 1 ? "" : "s"}</span><span className="bookings"><i /><b>{bookingCount}</b> approved deliver{bookingCount === 1 ? "y" : "ies"}</span></div>
      <div className="schedule-timeline-viewport"><ScheduleTimeline shipments={data.shipments} availableSlots={data.settings.availableSlots} anchorDate={date} mode={mode} showPending={["admin", "planner", "supplier"].includes(user.role)} onOpenShipment={onOpenShipment} /></div>
    </section>
  </div>;
}

export function MonitoringPage({ data, onOpenShipment }: { data: AppData; onOpenShipment: (shipment: Shipment) => void }) {
  const [dateFilter, setDateFilter] = useState(false), [rangeStart, setRangeStart] = useState(localDate()), [rangeEnd, setRangeEnd] = useState(localDate()), [query, setQuery] = useState(""), [status, setStatus] = useState<ShipmentStatus | "ALL">("ALL"), [fullscreen, setFullscreen] = useState(false);
  const fullscreenRef = useRef<HTMLDivElement>(null);
  useEffect(() => { const changed = () => { if (!document.fullscreenElement) setFullscreen(false); }; document.addEventListener("fullscreenchange", changed); return () => document.removeEventListener("fullscreenchange", changed); }, []);
  const enterFullscreen = async () => { setFullscreen(true); await fullscreenRef.current?.requestFullscreen?.().catch(() => undefined); }, exitFullscreen = async () => { if (document.fullscreenElement) await document.exitFullscreen().catch(() => undefined); setFullscreen(false); };
  const active = useMemo(() => data.shipments.filter((shipment) => shipment.bookingStatus === "APPROVED" && !["GATE_OUT", "REJECTED"].includes(shipment.status)), [data.shipments]);
  const rows = useMemo(() => active.filter((shipment) => !dateFilter || (shipment.scheduledDate >= rangeStart && shipment.scheduledDate <= rangeEnd)).filter((shipment) => status === "ALL" || shipment.status === status).filter((shipment) => `${shipment.shipmentNumber} ${shipment.bookingReceipt} ${shipment.supplier} ${shipment.truckPlate} ${shipment.driverName} ${shipment.driverPhone} ${shipment.items.map((item) => item.materialCode).join(" ")}`.toLowerCase().includes(query.toLowerCase())).sort((a, b) => { if (!dateFilter) { const group = (value: string) => value === localDate() ? 0 : value > localDate() ? 1 : 2; const difference = group(a.scheduledDate) - group(b.scheduledDate); if (difference) return difference; } const dateDifference = a.scheduledDate.localeCompare(b.scheduledDate); if (dateDifference) return dateDifference; const rankDifference = processRank[b.status] - processRank[a.status]; return rankDifference || a.scheduledTime.localeCompare(b.scheduledTime); }), [active, dateFilter, rangeStart, rangeEnd, status, query]);
  return <div ref={fullscreenRef} className={`page-stack monitoring-page ${fullscreen ? "tv-mode" : ""}`}>
    {!fullscreen && <section className="hero-row"><div><span className="eyebrow">Truck movement board</span><h1>Delivery monitoring</h1></div><div className="hero-actions"><span className="operation-live"><span className="live-dot" /> Live status</span><button className="icon-button fullscreen-trigger" onClick={enterFullscreen} aria-label="Open fullscreen monitoring" title="Fullscreen"><Maximize2 size={19} /></button></div></section>}
    {fullscreen && <button className="monitor-tv-exit" onClick={exitFullscreen} aria-label="Exit fullscreen" title="Exit fullscreen"><Minimize2 size={19} /></button>}
    {!fullscreen && <section className="monitor-status-strip">{statusOrder.filter((item) => !["PROPOSED", "GATE_OUT", "REJECTED"].includes(item)).map((item) => <button key={item} className={status === item ? "active" : ""} onClick={() => setStatus(status === item ? "ALL" : item)}><StatusPill status={item} /><b>{active.filter((shipment) => shipment.status === item).length}</b></button>)}</section>}
    <section className="panel monitoring-panel">
      {!fullscreen && <div className="monitor-toolbar">
        <label className="search-box"><Search size={17} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search truck, delivery, supplier, driver or product" /></label>
        <div className="monitor-date-system"><button className={`see-all-button ${!dateFilter ? "active" : ""}`} onClick={() => setDateFilter(false)}>See all</button><CustomDateRangePicker start={rangeStart} end={rangeEnd} active={dateFilter} onChange={(start, end) => { setRangeStart(start); setRangeEnd(end); setDateFilter(true); }} /></div>
      </div>}
      <div className="monitor-grid">{rows.map((shipment) => {
        const position = journeyPosition[shipment.status];
        return <button className={`monitor-delivery-card monitor-tone-${STATUS_META[shipment.status].color}`} key={shipment.id} onClick={() => !fullscreen && onOpenShipment(shipment)}><span className="monitor-card-head"><span><small>{formatDate(shipment.scheduledDate)}</small><b>{shipment.scheduledTime}</b></span>{shipment.bookingStatus !== "APPROVED" ? <span className="approval-chip pending">Approval pending</span> : <StatusPill status={shipment.status} />}</span><span className="monitor-card-shipment"><span className="truck-tile"><Truck size={19} /></span><span><b>{shipment.truckPlate}</b><small>{shipment.supplier}</small></span><ArrowRight size={17} /></span><span className="monitor-card-facts"><span><small>Delivery</small><b>{shipment.shipmentNumber}</b></span><span><small>Driver</small><b>{shipment.driverName}</b></span><span><small>Phone</small><b>{shipment.driverPhone || "—"}</b></span><span><small>Products</small><b>{shipment.items.length}</b></span></span>{shipment.tripAt && shipment.estimatedTravelMinutes && <span className="monitor-eta"><Clock3 size={16} /><span><small>ETA from Trip scan</small><b>{shipment.estimatedArrivalAt ? `${formatEta(shipment.estimatedArrivalAt)} · ${shipment.estimatedTravelMinutes} min` : `${shipment.estimatedTravelMinutes} min · ${shipment.estimatedTravelDistanceKm || "—"} km`}</b></span></span>}<span className="monitor-card-material"><b>{shipment.items.map((item) => item.materialCode).join(", ") || "Materials pending"}</b><small>{shipment.items.map((item) => `${item.quantity.toLocaleString()} ${item.uom}`).join(" · ")}</small></span><span className={`monitor-progress ${shipment.status === "REJECTED" ? "rejected" : ""}`}>{journeySteps.map((step, index) => { const stepNumber = index + 1; return <span className={position > stepNumber ? "complete" : position === stepNumber ? "current" : ""} key={step}><i>{position > stepNumber ? "✓" : stepNumber}</i><small>{step}</small></span>; })}</span></button>;
      })}</div>
      {!rows.length && <div className="feature-empty"><CalendarDays size={24} /><strong>No matching trucks</strong><span>Change the date or filters to view another delivery.</span></div>}
    </section>
  </div>;
}

export function HistoryPage({ data, user, onOpenShipment }: { data: AppData; user: SessionUser; onOpenShipment: (shipment: Shipment) => void }) {
  const [query, setQuery] = useState("");
  const [supplier, setSupplier] = useState("ALL"), [material, setMaterial] = useState("ALL"), [driver, setDriver] = useState("ALL"), [outcome, setOutcome] = useState("ALL");
  const [fromDate, setFromDate] = useState(""), [toDate, setToDate] = useState(""), [fromTime, setFromTime] = useState(""), [toTime, setToTime] = useState("");
  const received = useMemo(() => data.shipments.filter((shipment) => ["RECEIVED", "GATE_OUT"].includes(shipment.status)).sort((a, b) => String(b.gateOutAt || b.receivedAt || "").localeCompare(String(a.gateOutAt || a.receivedAt || ""))), [data.shipments]);
  const rejected = useMemo(() => data.shipments.filter((shipment) => shipment.status === "REJECTED").sort((a, b) => `${b.scheduledDate}${b.scheduledTime}`.localeCompare(`${a.scheduledDate}${a.scheduledTime}`)), [data.shipments]);
  const source = [...received, ...rejected].sort((a, b) => `${b.scheduledDate}${b.scheduledTime}`.localeCompare(`${a.scheduledDate}${a.scheduledTime}`));
  const suppliers = [...new Set(source.map((shipment) => shipment.supplier).filter(Boolean))].sort();
  const materials = [...new Set(source.flatMap((shipment) => shipment.items.map((item) => item.materialCode)).filter(Boolean))].sort();
  const drivers = [...new Set(source.map((shipment) => shipment.driverName).filter((value) => value && value !== "To be assigned"))].sort();
  const simplified = ["supplier", "driver"].includes(user.role);
  const rows = source.filter((shipment) => {
    const searchable = `${shipment.shipmentNumber} ${shipment.bookingReceipt} ${shipment.supplier} ${shipment.truckPlate} ${shipment.driverName} ${shipment.driverPhone} ${shipment.items.map((item) => item.materialCode).join(" ")} ${shipment.rejectionReason || ""}`.toLowerCase();
    return searchable.includes(query.trim().toLowerCase()) && (simplified || supplier === "ALL" || shipment.supplier === supplier) && (material === "ALL" || shipment.items.some((item) => item.materialCode === material)) && (driver === "ALL" || shipment.driverName === driver) && (simplified || outcome === "ALL" || shipment.status === outcome) && (!fromDate || shipment.scheduledDate >= fromDate) && (!toDate || shipment.scheduledDate <= toDate) && (simplified || !fromTime || shipment.scheduledTime >= fromTime) && (simplified || !toTime || shipment.scheduledTime <= toTime);
  });
  const clearFilters = () => { setQuery(""); setSupplier("ALL"); setMaterial("ALL"); setDriver("ALL"); setOutcome("ALL"); setFromDate(""); setToDate(""); setFromTime(""); setToTime(""); };
  return <div className={`page-stack history-page ${simplified ? "history-simplified" : ""}`}><section className="hero-row history-hero"><div><span className="eyebrow">Delivery records</span><h1>History</h1></div><div className="history-total-card" aria-label={`${source.length} total delivery records`}><History size={22} /><div><small>Total records</small><b>{source.length}</b></div></div></section><section className="panel history-panel"><div className="history-filter-panel"><label className="search-box history-search"><Search size={18} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search truck or booking" /></label><div className="history-filter-grid"><label><span>Supplier</span><select value={supplier} onChange={(event) => setSupplier(event.target.value)}><option value="ALL">All suppliers</option>{suppliers.map((value) => <option value={value} key={value}>{value}</option>)}</select></label><label><span>Material</span><select value={material} onChange={(event) => setMaterial(event.target.value)}><option value="ALL">All materials</option>{materials.map((value) => <option value={value} key={value}>{value}</option>)}</select></label><label><span>Driver</span><select value={driver} onChange={(event) => setDriver(event.target.value)}><option value="ALL">All drivers</option>{drivers.map((value) => <option value={value} key={value}>{value}</option>)}</select></label><label><span>Outcome</span><select value={outcome} onChange={(event) => setOutcome(event.target.value)}><option value="ALL">All outcomes</option><option value="RECEIVED">Received</option><option value="GATE_OUT">Gate out</option><option value="REJECTED">Rejected</option></select></label><label><span>From date</span><input type="date" value={fromDate} max={toDate || undefined} onChange={(event) => setFromDate(event.target.value)} /></label><label><span>To date</span><input type="date" value={toDate} min={fromDate || undefined} onChange={(event) => setToDate(event.target.value)} /></label><label><span>From time</span><input type="time" value={fromTime} onChange={(event) => setFromTime(event.target.value)} /></label><label><span>To time</span><input type="time" value={toTime} onChange={(event) => setToTime(event.target.value)} /></label></div><div className="history-filter-foot"><span>{rows.length} of {source.length} records shown</span><button type="button" className="button secondary compact" onClick={clearFilters}>Clear filters</button></div></div><div className="table-wrap"><table><thead><tr><th>Date & time</th><th>Truck / booking</th><th>Supplier</th><th>Materials</th><th>Driver</th><th>Outcome</th><th /></tr></thead><tbody>{rows.map((shipment) => <tr key={shipment.id}><td><b>{formatDate(shipment.scheduledDate, true)}</b><small>{shipment.scheduledTime}</small></td><td><button className="table-link" onClick={() => onOpenShipment(shipment)}>{shipment.truckPlate}</button><small>{shipment.shipmentNumber}</small></td><td>{shipment.supplier}</td><td><b>{shipment.items.map((item) => item.materialCode).join(", ")}</b><small>{shipment.items.length} code{shipment.items.length === 1 ? "" : "s"}</small></td><td>{shipment.driverName}<small>{shipment.driverPhone}</small></td><td>{shipment.status === "REJECTED" ? <span className="rejection-copy">{shipment.rejectionReason || "No reason recorded"}</span> : <StatusPill status={shipment.status} />}</td><td><button className="icon-button" onClick={() => onOpenShipment(shipment)}><ArrowRight size={17} /></button></td></tr>)}</tbody></table></div>{!rows.length && <div className="feature-empty"><History size={26} /><strong>No matching records</strong><span>Clear or adjust the filters to see other records.</span></div>}</section></div>;
}
