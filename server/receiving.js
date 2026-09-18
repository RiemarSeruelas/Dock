// Business rules shared by the API and its regression tests. Quantities are
// conserved separately for every SDS line; units are never added together.
export const fail = (message, status = 400) => { const error = new Error(message); error.status = status; throw error; };
export const validDay = value => { if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return false; const date = new Date(`${value}T00:00:00Z`); return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value; };
export const validClock = value => /^([01]\d|2[0-3]):[0-5]\d$/.test(value || '');
export const roundQuantity = n => Math.round(n * 1e6) / 1e6;
export function calculateOtifPercent(onTime, expectedQuantity, actualReceived) {
  if (onTime === false || onTime === 'No') return 0;
  if (onTime !== true && onTime !== 'Yes') return null;
  if (String(expectedQuantity ?? '').trim() === '' || String(actualReceived ?? '').trim() === '') return null;
  const expected = Number(expectedQuantity);
  const actual = Number(actualReceived);
  if (!Number.isFinite(expected) || !Number.isFinite(actual) || expected <= 0 || actual < 0) return null;
  return Math.round(Math.min(100, actual / expected * 100) * 100) / 100;
}
export function calculateShipmentOtif(shipment) {
  const arrival = classifyArrival(shipment.scheduledDate, shipment.scheduledTime, shipment.gateInAt);
  const onTime = arrival ? arrival !== 'LATE' : shipment.receipt?.onTime ?? null;
  if (onTime === false) return { onTime, otifPercent: 0 };
  if (onTime !== true) return { onTime: null, otifPercent: null };
  const received = shipment.items.map(item => item.actualReceived ?? shipment.receipt?.items?.find(row => Number(row.itemId) === Number(item.id))?.acceptedQuantity);
  if (received.some(value => String(value ?? '').trim() === '' || !Number.isFinite(Number(value)) || Number(value) < 0)) return { onTime, otifPercent: null };
  const expectedTotal = shipment.items.reduce((sum, item) => sum + Number(item.quantity || 0), 0);
  const actualTotal = received.reduce((sum, value) => sum + Number(value || 0), 0);
  return { onTime, otifPercent: calculateOtifPercent(onTime, expectedTotal, actualTotal) };
}
export function classifyArrival(scheduledDate, scheduledTime, gateInAt) {
  const scheduled = Date.parse(`${scheduledDate}T${scheduledTime}:00+08:00`);
  const arrived = Date.parse(gateInAt);
  if (!Number.isFinite(scheduled) || !Number.isFinite(arrived)) return null;
  const varianceMinutes = (arrived - scheduled) / 60000;
  if (varianceMinutes < -30) return 'ADVANCED';
  if (varianceMinutes <= 15) return 'ON_TIME';
  return 'LATE';
}
export const defaultScheduleEnd = (start, duration = 120) => {
  if (!validClock(start)) return null;
  const [hour, minute] = start.split(':').map(Number);
  const total = Math.min(1439, hour * 60 + minute + duration);
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
};
export const scheduleDurationMinutes = (start, end) => {
  if (!validClock(start) || !validClock(end)) return null;
  const [startHour, startMinute] = start.split(':').map(Number);
  const [endHour, endMinute] = end.split(':').map(Number);
  return endHour * 60 + endMinute - (startHour * 60 + startMinute);
};
export function normalizeSplits(proposal, input, date, time) {
  if (input !== undefined && !Array.isArray(input)) fail('Quantity allocations must be a list');
  const rows = input?.length ? input : proposal.items.map(item => ({ itemId: item.id, quantity: item.quantity, date, time }));
  if (rows.length > 500) fail('Too many allocation rows');
  const result = rows.map(row => {
    const item = proposal.items.find(item => item.id === Number(row.itemId));
    const quantity = Number(row.quantity);
    const cannotDeliver = Boolean(row.cannotDeliver);
    const day = row.date || date || proposal.scheduledDate;
    const clock = row.time || time || proposal.scheduledTime;
    const reason = String(row.reason || '').trim().slice(0, 1000);
    if (!item || !Number.isFinite(quantity) || quantity <= 0) fail('Each allocation needs a valid material and positive quantity');
    if (cannotDeliver && !reason) fail(`Explain why ${item.materialCode} cannot be delivered`);
    if (!cannotDeliver && (!validDay(day) || !validClock(clock))) fail('Each scheduled allocation needs a valid date and time');
    return { itemId: item.id, materialCode: item.materialCode, uom: item.uom, quantity: roundQuantity(quantity), date: cannotDeliver ? '' : day, time: cannotDeliver ? '' : clock, cannotDeliver, reason: cannotDeliver ? reason : '' };
  });
  for (const item of proposal.items) {
    const sum = roundQuantity(result.filter(row => row.itemId === item.id).reduce((sum, row) => sum + row.quantity, 0));
    if (Math.abs(sum - Number(item.quantity)) > 0.000001) fail(`Allocations for ${item.materialCode} must total ${item.quantity} ${item.uom}`);
  }
  return result;
}
export function applySplits(state, proposal, nextId, nextCode) {
  const original = structuredClone(proposal);
  const groups = new Map();
  for (const row of (proposal.quantityAllocations || []).filter(row => !row.cannotDeliver)) {
    const key = `${row.date} ${row.time}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  if (!groups.size) return [];
  const created = [];
  let nextItem = Math.max(0, ...state.shipments.flatMap(s => s.items.map(item => item.id))) + 1;
  for (const rows of groups.values()) {
    const delivery = created.length ? structuredClone(original) : proposal;
    if (created.length) delivery.id = nextId(state.shipments);
    delivery.splitParentId = original.splitParentId || original.id;
    delivery.originalSchedule ||= { date: original.scheduledDate, time: original.scheduledTime, items: original.items };
    delivery.scheduledDate = rows[0].date;
    delivery.scheduledTime = rows[0].time;
    const approvedAlternativeEnd = rows[0].date === proposal.alternativeDate && rows[0].time === proposal.alternativeTime && validClock(proposal.alternativeEndTime) && proposal.alternativeEndTime > rows[0].time
      ? proposal.alternativeEndTime
      : null;
    delivery.scheduledEndTime = approvedAlternativeEnd || defaultScheduleEnd(rows[0].time);
    delivery.scheduleDurationSource = approvedAlternativeEnd ? 'MANUAL' : 'DEFAULT';
    delivery.expectedDurationMinutes = scheduleDurationMinutes(delivery.scheduledTime, delivery.scheduledEndTime);
    delivery.timeSlot = `${delivery.scheduledTime} - ${delivery.scheduledEndTime}`;
    delivery.shipmentNumber = nextCode('SHP', delivery.id, delivery.scheduledDate);
    delivery.bookingReceipt = nextCode('BKG', delivery.id, delivery.scheduledDate);
    delivery.items = original.items.filter(item => rows.some(row => row.itemId === item.id)).map(item => ({ ...item, id: created.length ? nextItem++ : item.id, sourceAllocationItemId: item.sourceAllocationItemId || item.id, quantity: roundQuantity(rows.filter(row => row.itemId === item.id).reduce((sum, row) => sum + row.quantity, 0)), supplierApprovedAt: null, assignedTruckPlate: null }));
    delivery.confirmedTruckLoads = [];
    delivery.bookingStatus = 'PENDING_SUPPLIER';
    delivery.status = 'PROPOSED';
    delivery.supplierResponse = null;
    if (created.length) { delivery.sdsImportIdentity = null; delivery.sdsImportFingerprint = null; state.shipments.push(delivery); }
    created.push(delivery);
  }
  return created;
}
export function inspectReceipt(shipment, input) {
  if (!input || !['FULL', 'NOT_IN_FULL', 'NOT_OTIF'].includes(input.outcome)) fail('Choose Received or Received – Not in Full after inspection');
  const submitted = input.items;
  if (!Array.isArray(submitted) || submitted.length !== shipment.items.length || new Set(submitted.map(row => Number(row.itemId))).size !== submitted.length) fail('Inspect every material exactly once');
  const items = shipment.items.map(item => {
    const row = submitted.find(row => Number(row.itemId) === item.id);
    const acceptedQuantity = Number(row?.acceptedQuantity);
    if (!row || row.acceptedQuantity === '' || !Number.isFinite(acceptedQuantity) || acceptedQuantity < 0 || acceptedQuantity > item.quantity) fail(`Invalid accepted quantity for ${item.materialCode}`);
    const remainingQuantity = roundQuantity(item.quantity - acceptedQuantity);
    if (remainingQuantity && !String(row.reason || '').trim()) fail(`Provide a rejection reason for ${item.materialCode}`);
    if (remainingQuantity && (!validDay(row.date) || !validClock(row.time))) fail(`Provide the follow-up date and time for ${item.materialCode}`);
    return { itemId: item.id, materialCode: item.materialCode, uom: item.uom, expectedQuantity: item.quantity, acceptedQuantity, remainingQuantity, reason: remainingQuantity ? String(row.reason).trim().slice(0, 1000) : '', date: remainingQuantity ? row.date : null, time: remainingQuantity ? row.time : null };
  });
  const inFull = items.every(row => row.remainingQuantity === 0);
  if (input.outcome !== 'NOT_OTIF' && (input.outcome === 'FULL') !== inFull) fail('Receipt outcome must match the inspected quantities');
  if(input.outcome === 'NOT_OTIF' && !String(input.reason || '').trim()) fail('Choose a reason for Not OTIF');
  const arrivalClassification = classifyArrival(shipment.scheduledDate, shipment.scheduledTime, shipment.gateInAt);
  const onTime = arrivalClassification ? arrivalClassification !== 'LATE' : null;
  const evaluatedItems = items.map(row => ({ ...row, otifPercent: calculateOtifPercent(onTime, row.expectedQuantity, row.acceptedQuantity) }));
  const expectedTotal = evaluatedItems.reduce((sum, row) => sum + Number(row.expectedQuantity || 0), 0);
  const acceptedTotal = evaluatedItems.reduce((sum, row) => sum + Number(row.acceptedQuantity || 0), 0);
  const otifPercent = input.outcome === 'NOT_OTIF' ? 0 : calculateOtifPercent(onTime, expectedTotal, acceptedTotal);
  return { outcome: input.outcome, reason: String(input.reason || '').trim().slice(0,1000), inFull, onTime, otifPercent, otif: otifPercent === null ? null : otifPercent >= 100 && input.outcome !== 'NOT_OTIF', items: evaluatedItems };
}
export function createReplacements(state, shipment, nextId, nextCode) {
  const groups = new Map();
  for (const row of shipment.receipt.items.filter(row => row.remainingQuantity > 0 && validDay(row.date) && validClock(row.time))) {
    const key = `${row.date} ${row.time}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  let nextItem = Math.max(0, ...state.shipments.flatMap(s => s.items.map(item => item.id))) + 1;
  return [...groups.values()].map(rows => {
    const id = nextId(state.shipments);
    const scheduledEndTime = defaultScheduleEnd(rows[0].time);
    const replacement = { id, shipmentNumber: nextCode('SHP', id, rows[0].date), bookingReceipt: nextCode('BKG', id, rows[0].date), supplier: shipment.supplier, supplierId: shipment.supplierId, vendorCode: shipment.vendorCode, destinationEcosystemId: shipment.destinationEcosystemId || null, replacementForId: shipment.id, isFollowUp: true, followUpLabel: 'Follow up', scheduledDate: rows[0].date, scheduledTime: rows[0].time, scheduledEndTime, expectedDurationMinutes: 120, timeSlot: `${rows[0].time} - ${scheduledEndTime}`, status: 'PROPOSED', bookingStatus: 'PENDING_SUPPLIER', truckPlate: '', driverName: '', driverPhone: '', confirmedTruckLoads: [], palletsScanned: 0, palletsTotal: 0, materialWeightKg: 0, items: rows.map(row => ({ ...shipment.items.find(item => item.id === row.itemId), id: nextItem++, quantity: row.remainingQuantity, batchNumber: '', supplierLot: '', productionDate: '', expiryDate: '', batches: [], supplierApprovedAt: null, assignedTruckPlate: null, remarks: row.reason })) };
    state.shipments.push(replacement);
    return replacement;
  });
}
export function calculateKpi(shipments, month) {
  const rows = shipments.filter(row => row.bookingStatus === 'APPROVED' && row.scheduledDate?.startsWith(month) && !row.replacementForId);
  const evaluated = rows.filter(row => row.receipt && row.receipt.onTime !== null);
  const pct = count => evaluated.length ? Math.round(count / evaluated.length * 10000) / 100 : null;
  const minutes = rows.filter(row => row.gateInAt && row.gateOutAt).map(row => (new Date(row.gateOutAt) - new Date(row.gateInAt)) / 60000);
  return { month, confirmed: rows.length, evaluated: evaluated.length, awaitingInspection: rows.length - evaluated.length, onTimePercent: pct(evaluated.filter(row => row.receipt.onTime).length), inFullPercent: pct(evaluated.filter(row => row.receipt.inFull).length), otifPercent: pct(evaluated.filter(row => row.receipt.otif).length), averageSiteMinutes: minutes.length ? Math.round(minutes.reduce((a, b) => a + b, 0) / minutes.length) : null, completed: rows.filter(row => row.gateOutAt).length };
}
