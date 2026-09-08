import { fail } from './receiving.js';
export function normalizePhone(value) {
  let phone = String(value || '').replace(/[\s().-]/g, '');
  if (/^09\d{9}$/.test(phone)) phone = `+63${phone.slice(1)}`;
  else if (/^9\d{9}$/.test(phone)) phone = `+63${phone}`;
  else if (/^63\d{10}$/.test(phone)) phone = `+${phone}`;
  return phone;
}
export function validateProposedTrucks(proposal, trucks) {
  if (!trucks.length || trucks.length > 2) fail('Choose one or two trucks and complete their details before sending the alternative');
  const ids = trucks.flatMap(truck => truck.itemIds);
  if (ids.length !== proposal.items.length || new Set(ids).size !== ids.length || proposal.items.some(item => !ids.includes(item.id))) fail('Assign every material code to exactly one truck');
  return trucks;
}
export function bookApprovedProposal(state, proposal, trucks, actor, { nextId, nextCode, issueDeliveryCode }) {
  const source = structuredClone(proposal);
  const booked = [];
  for (const truck of trucks) {
    const items = source.items.filter(item => truck.itemIds.includes(item.sourceAllocationItemId || item.id));
    if (!items.length) continue;
    const row = booked.length ? structuredClone(source) : proposal;
    if (booked.length) row.id = nextId(state.shipments);
    row.items = items.map(item => ({ ...item, poNumber: truck.poNumber, dnNumber: truck.drNumber, supplierApprovedAt: new Date().toISOString(), assignedTruckPlate: truck.truckPlate }));
    for (const key of ['truckPlate', 'driverName', 'driverPhone', 'helper1Name', 'helper2Name', 'poNumber', 'drNumber']) row[key] = truck[key] || '';
    row.shipmentNumber = nextCode('SHP', row.id, row.scheduledDate);
    row.bookingReceipt = nextCode('BKG', row.id, row.scheduledDate);
    row.deliveryCode = issueDeliveryCode(state, row.scheduledDate);
    row.bookingStatus = 'APPROVED'; row.status = 'BOOKED';
    row.finalDecisionAt = new Date().toISOString(); row.finalDecisionBy = actor.name;
    row.loadConfirmedAt = row.finalDecisionAt; row.confirmedTruckLoads = [];
    row.proposedTrucks = []; row.supplierResponse = 'ACCEPTED';
    row.palletsTotal = row.items.reduce((sum, item) => sum + Number(item.palletCount || 0), 0);
    row.materialWeightKg = row.items.reduce((sum, item) => sum + (item.uom === 'KG' ? item.quantity : item.uom === 'MT' ? item.quantity * 1000 : 0), 0);
    if (booked.length) state.shipments.push(row);
    booked.push(row);
  }
  if (!booked.length) fail('The saved truck allocation does not cover this delivery');
  return booked;
}
