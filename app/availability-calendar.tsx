"use client";

import { ArrowLeft, ArrowRight, CalendarDays, Check, Clock3, Plus, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { localDate } from "./date-utils";
import type { AvailabilityInput, AvailabilitySlot, Shipment } from "./types";

const DAY_START = 6 * 60;
const DAY_END = 22 * 60;
const STEP = 30;
const TOTAL_MINUTES = DAY_END - DAY_START;

const toMinutes = (value: string) => {
  const [hour, minute] = value.split(":").map(Number);
  return hour * 60 + minute;
};

const toTime = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

const addDays = (date: string, days: number) => {
  const next = new Date(`${date}T12:00:00`);
  next.setDate(next.getDate() + days);
  return `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, "0")}-${String(next.getDate()).padStart(2, "0")}`;
};

const startOfWeek = (date: string) => {
  const value = new Date(`${date}T12:00:00`);
  const offset = value.getDay() === 0 ? -6 : 1 - value.getDay();
  return addDays(date, offset);
};

const dayLabel = (date: string) => new Intl.DateTimeFormat("en-PH", { weekday: "short", month: "short", day: "numeric" }).format(new Date(`${date}T12:00:00`));
const longDate = (date: string) => new Intl.DateTimeFormat("en-PH", { month: "long", day: "numeric", year: "numeric" }).format(new Date(`${date}T12:00:00`));

const approvedBookingOverlaps = (shipments: Shipment[], slot: AvailabilityInput, exceptId?: number) => shipments.filter((shipment) =>
  shipment.id !== exceptId &&
  shipment.scheduledDate === slot.date &&
  shipment.scheduledTime >= slot.startTime &&
  shipment.scheduledTime < slot.endTime &&
  shipment.bookingStatus === "APPROVED" &&
  shipment.status !== "REJECTED"
).length;

type DrawDraft = { date: string; start: number; current: number };

export function AvailabilityCalendar({
  slots,
  shipments,
  anchorDate,
  editable = false,
  selectedSlotId,
  previewSlot,
  hiddenSlotId,
  onAnchorDateChange,
  onDraft,
  onMove,
  onSelect,
}: {
  slots: AvailabilitySlot[];
  shipments: Shipment[];
  anchorDate: string;
  editable?: boolean;
  selectedSlotId?: number | null;
  previewSlot?: AvailabilityInput | null;
  hiddenSlotId?: number | null;
  onAnchorDateChange: (date: string) => void;
  onDraft?: (date: string, startTime: string, endTime: string) => void;
  onMove?: (slot: AvailabilitySlot, date: string, startTime: string, endTime: string) => void;
  onSelect?: (slot: AvailabilitySlot) => void;
}) {
  const [draw, setDraw] = useState<DrawDraft | null>(null);
  const [movingSlot, setMovingSlot] = useState<AvailabilitySlot | null>(null);
  const week = startOfWeek(anchorDate);
  const days = useMemo(() => Array.from({ length: 7 }, (_, index) => addDays(week, index)), [week]);
  const hourLabels = Array.from({ length: TOTAL_MINUTES / 60 + 1 }, (_, index) => toTime(DAY_START + index * 60));
  const minuteAtPointer = (element: HTMLElement, clientY: number) => {
    const rect = element.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (clientY - rect.top) / rect.height));
    return Math.min(DAY_END - STEP, Math.max(DAY_START, Math.round((DAY_START + ratio * TOTAL_MINUTES) / STEP) * STEP));
  };
  const finishDrawing = () => {
    if (!draw || !onDraft) return setDraw(null);
    const start = Math.min(draw.start, draw.current);
    const end = Math.min(DAY_END, Math.max(draw.start, draw.current) + STEP);
    onDraft(draw.date, toTime(start), toTime(end));
    setDraw(null);
  };
  const bookingCount = (slot: AvailabilityInput) => approvedBookingOverlaps(shipments, slot);
  const blockStyle = (slot: AvailabilityInput) => ({
    top: `${(toMinutes(slot.startTime) - DAY_START) / TOTAL_MINUTES * 100}%`,
    height: `${Math.max(3.5, (toMinutes(slot.endTime) - toMinutes(slot.startTime)) / TOTAL_MINUTES * 100)}%`,
  });

  return <section className="availability-calendar" aria-label="Weekly booking availability">
    <div className="availability-calendar-head">
      <div><span className="eyebrow">Shared booking calendar</span><h3>{longDate(week)} – {longDate(addDays(week, 6))}</h3></div>
      <div className="calendar-nav"><button type="button" onClick={() => onAnchorDateChange(addDays(week, -7))} aria-label="Previous week"><ArrowLeft size={16} /></button><button type="button" onClick={() => onAnchorDateChange(localDate())}>Today</button><button type="button" onClick={() => onAnchorDateChange(addDays(week, 7))} aria-label="Next week"><ArrowRight size={16} /></button></div>
    </div>
    <div className="availability-scroll">
      <div className="availability-week">
        <div className="availability-corner"><Clock3 size={15} /></div>
        {days.map((day) => <button type="button" className={`availability-day-head ${day === localDate() ? "today" : ""}`} key={day} onClick={() => onAnchorDateChange(day)}><span>{dayLabel(day).split(",")[0]}</span><b>{new Date(`${day}T12:00:00`).getDate()}</b></button>)}
        <div className="availability-time-axis">{hourLabels.map((item, index) => <span key={item} style={{ top: `${index / (hourLabels.length - 1) * 100}%` }}>{item}</span>)}</div>
        {days.map((day) => <div
          className={`availability-day-column ${editable ? "editable" : ""} ${movingSlot ? "move-target" : ""}`}
          key={day}
          onDragOver={(event) => { if (editable && movingSlot && onMove) event.preventDefault(); }}
          onDrop={(event) => {
            event.preventDefault();
            if (!movingSlot || !onMove) return;
            const duration = toMinutes(movingSlot.endTime) - toMinutes(movingSlot.startTime);
            const nextStart = Math.min(DAY_END - duration, minuteAtPointer(event.currentTarget, event.clientY));
            onMove(movingSlot, day, toTime(nextStart), toTime(nextStart + duration));
            setMovingSlot(null);
          }}
          onPointerDown={(event) => {
            if (!editable || !onDraft) return;
            event.currentTarget.setPointerCapture(event.pointerId);
            const minute = minuteAtPointer(event.currentTarget, event.clientY);
            setDraw({ date: day, start: minute, current: minute });
          }}
          onPointerMove={(event) => {
            if (!draw || draw.date !== day) return;
            setDraw({ ...draw, current: minuteAtPointer(event.currentTarget, event.clientY) });
          }}
          onPointerUp={finishDrawing}
          onPointerCancel={() => setDraw(null)}
        >
          {Array.from({ length: TOTAL_MINUTES / 60 }, (_, index) => <i className="availability-hour-line" style={{ top: `${index / (TOTAL_MINUTES / 60) * 100}%` }} key={index} />)}
          {slots.filter((slot) => slot.date === day && slot.id !== hiddenSlotId).map((slot) => {
            const count = bookingCount(slot);
            return <button type="button" draggable={editable} className={`availability-block ${selectedSlotId === slot.id ? "selected" : ""}`} style={blockStyle(slot)} key={slot.id} onDragStart={(event) => { event.dataTransfer.effectAllowed = "move"; setMovingSlot(slot); }} onDragEnd={() => setMovingSlot(null)} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); onSelect?.(slot); }}><b>{slot.startTime}–{slot.endTime}</b><span>{slot.label || "Open for booking"}</span><small>{count ? `${count} approved booking${count === 1 ? "" : "s"} overlap` : "Open receiving hours"}</small></button>;
          })}
          {previewSlot?.date === day && <div className="availability-block preview" style={blockStyle(previewSlot)}><b>{previewSlot.startTime}–{previewSlot.endTime}</b><span>{previewSlot.label || "Open for booking"}</span><small>Unsaved change</small></div>}
          {draw?.date === day && (() => {
            const start = Math.min(draw.start, draw.current);
            const end = Math.max(draw.start, draw.current) + STEP;
            return <div className="availability-draft" style={{ top: `${(start - DAY_START) / TOTAL_MINUTES * 100}%`, height: `${(end - start) / TOTAL_MINUTES * 100}%` }}><Plus size={13} /> {toTime(start)}–{toTime(end)}</div>;
          })()}
        </div>)}
      </div>
    </div>
    <div className="availability-legend"><span><i /> Saved window</span><span><i /> Unsaved change</span>{editable && <small>Drag an empty area to create, or drag a saved block to move it. Click Save when ready.</small>}</div>
  </section>;
}

export function AvailabilityEditor({ slots, shipments, onSave, onDelete, anchorDate: controlledAnchorDate, onAnchorDateChange, compact = false }: {
  slots: AvailabilitySlot[];
  shipments: Shipment[];
  onSave: (slot: AvailabilityInput) => Promise<void> | void;
  onDelete: (id: number) => Promise<void> | void;
  anchorDate?: string;
  onAnchorDateChange?: (date: string) => void;
  compact?: boolean;
}) {
  const firstDate = slots.find((slot) => slot.date >= localDate())?.date || slots[0]?.date || localDate();
  const [internalAnchorDate, setInternalAnchorDate] = useState(firstDate);
  const [selectedSlotId, setSelectedSlotId] = useState<number | null>(null);
  const [date, setDate] = useState(controlledAnchorDate || firstDate);
  const [startTime, setStartTime] = useState("08:00");
  const [endTime, setEndTime] = useState("10:00");
  const [label, setLabel] = useState("Open receiving window");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const anchorDate = controlledAnchorDate || internalAnchorDate;
  const changeAnchor = (nextDate: string) => { setInternalAnchorDate(nextDate); onAnchorDateChange?.(nextDate); };
  const valid = date && startTime && endTime && toMinutes(endTime) > toMinutes(startTime);
  const selectSlot = (slot: AvailabilitySlot) => {
    setSelectedSlotId(slot.id); changeAnchor(slot.date); setDate(slot.date); setStartTime(slot.startTime); setEndTime(slot.endTime); setLabel(slot.label || "Open receiving window"); setDirty(false);
  };
  const prepareDraft = (nextDate: string, start: string, end: string, slot?: AvailabilitySlot) => {
    setSelectedSlotId(slot?.id || null); changeAnchor(nextDate); setDate(nextDate); setStartTime(start); setEndTime(end); if (slot) setLabel(slot.label || "Open receiving window"); setDirty(true);
  };
  const resetEditor = () => { setSelectedSlotId(null); setDirty(false); };
  const previewSlot = dirty ? { id: selectedSlotId || undefined, date, startTime, endTime, label } : null;

  return <div className={`availability-editor ${compact ? "compact" : ""}`}>
    <AvailabilityCalendar slots={slots} shipments={shipments} anchorDate={anchorDate} editable selectedSlotId={selectedSlotId} previewSlot={previewSlot} hiddenSlotId={dirty ? selectedSlotId : null} onAnchorDateChange={changeAnchor} onSelect={selectSlot} onDraft={(nextDate, start, end) => prepareDraft(nextDate, start, end)} onMove={(slot, nextDate, start, end) => prepareDraft(nextDate, start, end, slot)} />
    <form className="availability-input-card" onSubmit={async (event) => { event.preventDefault(); if (!valid || saving) return; setSaving(true); try { await onSave({ id: selectedSlotId || undefined, date, startTime, endTime, label }); resetEditor(); } finally { setSaving(false); } }}>
      <div className="availability-input-title"><span className="settings-icon"><CalendarDays size={19} /></span><div><h3>{selectedSlotId ? "Edit available time" : "Add available time"}</h3><p>Drag a block or enter the date and exact start/end time, then save manually.</p></div></div>
      <div className="availability-input-grid"><label>Date<input type="date" value={date} onChange={(event) => { setDate(event.target.value); changeAnchor(event.target.value); setDirty(true); }} required /></label><label>From<input type="time" value={startTime} onChange={(event) => { setStartTime(event.target.value); setDirty(true); }} required /></label><label>To<input type="time" value={endTime} onChange={(event) => { setEndTime(event.target.value); setDirty(true); }} required /></label><label>Label<input value={label} onChange={(event) => { setLabel(event.target.value); setDirty(true); }} placeholder="Open receiving window" /></label></div>
      {!valid && <p className="availability-error">End time must be later than the start time.</p>}
      <div className="availability-input-actions">{selectedSlotId && <button type="button" className="button danger compact" onClick={async () => { await onDelete(selectedSlotId); resetEditor(); }}><Trash2 size={15} /> Remove</button>}<button className="button primary compact" disabled={!valid || !dirty || saving}><Check size={15} /> {saving ? "Saving" : selectedSlotId ? "Update availability" : "Save availability"}</button></div>
    </form>
  </div>;
}
