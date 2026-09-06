// Business rules shared by the API and its regression tests. Quantities are
// conserved separately for every SDS line; units are never added together.
export const fail = (message, status = 400) => { const error = new Error(message); error.status = status; throw error; };
export const validDay = value => { if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return false; const date = new Date(`${value}T00:00:00Z`); return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value; };
export const validClock = value => /^([01]\d|2[0-3]):[0-5]\d$/.test(value || '');
export const roundQuantity = n => Math.round(n * 1e6) / 1e6;
export function normalizeSplits(proposal, input, date, time) {
  if (input !== undefined && !Array.isArray(input)) fail('Quantity allocations must be a list');
  const rows = input?.length ? input : proposal.items.map(item => ({ itemId: item.id, quantity: item.quantity, date, time }));
  if (rows.length > 500) fail('Too many allocation rows');
  const result = rows.map(row => {
    const item = proposal.items.find(item => item.id === Number(row.itemId));
    const quantity = Number(row.quantity);
    const day = row.date || date || proposal.scheduledDate;
    const clock = row.time || time || proposal.scheduledTime;
    if (!item || !Number.isFinite(quantity) || quantity <= 0 || !validDay(day) || !validClock(clock)) fail('Each allocation needs a valid material, positive quantity, date and time');
    return { itemId: item.id, materialCode: item.materialCode, uom: item.uom, quantity: roundQuantity(quantity), date: day, time: clock };
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
  for (const row of proposal.quantityAllocations || []) {
    const key = `${row.date} ${row.time}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const created = [];
  let nextItem = Math.max(0, ...state.shipments.flatMap(s => s.items.map(item => item.id))) + 1;
  for (const rows of groups.values()) {
    const delivery = created.length ? structuredClone(original) : proposal;
    if (created.length) delivery.id = nextId(state.shipments);
    delivery.splitParentId = original.splitParentId || original.id;
    delivery.originalSchedule ||= { date: original.scheduledDate, time: original.scheduledTime, items: original.items };
    delivery.scheduledDate = rows[0].date;
    delivery.scheduledTime = rows[0].time;
    delivery.scheduledEndTime = null;
    delivery.shipmentNumber = nextCode('SHP', delivery.id, delivery.scheduledDate);
    delivery.bookingReceipt = nextCode('BKG', delivery.id, delivery.scheduledDate);
    delivery.items = original.items.filter(item => rows.some(row => row.itemId === item.id)).map(item => ({ ...item, id: created.length ? nextItem++ : item.id, quantity: roundQuantity(rows.filter(row => row.itemId === item.id).reduce((sum, row) => sum + row.quantity, 0)), supplierApprovedAt: null, assignedTruckPlate: null }));
    delivery.confirmedTruckLoads = [];
    delivery.bookingStatus = 'PENDING_SUPPLIER';
    delivery.status = 'PROPOSED';
    delivery.supplierResponse = null;
    if (created.length) { delivery.sdsImportIdentity = null; delivery.sdsImportFingerprint = null; state.shipments.push(delivery); }
    created.push(delivery);
  }
  return created;
}
export function inspectReceipt(shipment, input, graceMinutes = 0) {
  if (!input || !['FULL', 'NOT_IN_FULL'].includes(input.outcome)) fail('Choose Received or Received – Not in Full after inspection');
  const submitted = input.items;
  if (!Array.isArray(submitted) || submitted.length !== shipment.items.length || new Set(submitted.map(row => Number(row.itemId))).size !== submitted.length) fail('Inspect every material exactly once');
  const items = shipment.items.map(item => {
    const row = submitted.find(row => Number(row.itemId) === item.id);
    const acceptedQuantity = Number(row?.acceptedQuantity);
    if (!row || row.acceptedQuantity === '' || !Number.isFinite(acceptedQuantity) || acceptedQuantity < 0 || acceptedQuantity > item.quantity) fail(`Invalid accepted quantity for ${item.materialCode}`);
    const remainingQuantity = roundQuantity(item.quantity - acceptedQuantity);
    if (remainingQuantity && (!String(row.reason || '').trim() || !validDay(row.date) || !validClock(row.time))) fail(`Provide replacement date, time and reason for ${item.materialCode}`);
    return { itemId: item.id, materialCode: item.materialCode, uom: item.uom, expectedQuantity: item.quantity, acceptedQuantity, remainingQuantity, reason: remainingQuantity ? String(row.reason).trim().slice(0, 1000) : '', date: remainingQuantity ? row.date : null, time: remainingQuantity ? row.time : null };
  });
  const inFull = items.every(row => row.remainingQuantity === 0);
  if ((input.outcome === 'FULL') !== inFull) fail('Receipt outcome must match the inspected quantities');
  const scheduled = new Date(`${shipment.scheduledDate}T${shipment.scheduledTime}:00+08:00`).getTime();
  const onTime = shipment.gateInAt ? new Date(shipment.gateInAt).getTime() <= scheduled + Number(graceMinutes) * 60000 : null;
  return { outcome: input.outcome, inFull, onTime, otif: onTime === null ? null : onTime && inFull, items };
}
export function createReplacements(state, shipment, nextId, nextCode) {
  const groups = new Map();
  for (const row of shipment.receipt.items.filter(row => row.remainingQuantity > 0)) {
    const key = `${row.date} ${row.time}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  let nextItem = Math.max(0, ...state.shipments.flatMap(s => s.items.map(item => item.id))) + 1;
  return [...groups.values()].map(rows => {
    const id = nextId(state.shipments);
    const replacement = { id, shipmentNumber: nextCode('SHP', id, rows[0].date), bookingReceipt: nextCode('BKG', id, rows[0].date), supplier: shipment.supplier, supplierId: shipment.supplierId, vendorCode: shipment.vendorCode, destinationEcosystemId: shipment.destinationEcosystemId || null, replacementForId: shipment.id, scheduledDate: rows[0].date, scheduledTime: rows[0].time, scheduledEndTime: null, status: 'PROPOSED', bookingStatus: 'PENDING_SUPPLIER', truckPlate: '', driverName: '', driverPhone: '', confirmedTruckLoads: [], palletsScanned: 0, palletsTotal: 0, materialWeightKg: 0, items: rows.map(row => ({ ...shipment.items.find(item => item.id === row.itemId), id: nextItem++, quantity: row.remainingQuantity, supplierApprovedAt: null, assignedTruckPlate: null, remarks: row.reason })) };
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
