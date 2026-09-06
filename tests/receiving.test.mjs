import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSplits, applySplits, inspectReceipt, createReplacements, calculateKpi } from '../server/receiving.js';
import { sapRows } from '../server/extensions.js';
const proposal = () => ({ id: 1, supplierId: 7, supplier: 'Supplier', scheduledDate: '2026-09-06', scheduledTime: '09:00', gateInAt: '2026-09-06T01:00:00Z', bookingStatus: 'APPROVED', items: [{ id: 1, materialCode: 'A', materialName: 'Internal name', quantity: 60, uom: 'KG' }, { id: 2, materialCode: 'B', quantity: 5, uom: 'PC' }] });
const nextId = rows => Math.max(0, ...rows.map(row => row.id)) + 1;
const nextCode = (prefix, id) => `${prefix}-${id}`;
test('splits conserve each material and unit, preserving approved schedules', () => {
  const s = proposal();
  const input = [{ itemId: 1, quantity: 30, date: '2026-09-06', time: '09:00' }, { itemId: 1, quantity: 30, date: '2026-09-07', time: '10:00' }, { itemId: 2, quantity: 5, date: '2026-09-06', time: '09:00' }];
  s.quantityAllocations = normalizeSplits(s, input);
  const state = { shipments: [s] };
  const groups = applySplits(state, s, nextId, nextCode);
  assert.equal(groups.length, 2); assert.equal(groups[0].items.length, 2);
  assert.equal(groups[1].scheduledDate, '2026-09-07');
  assert.equal(groups.flatMap(row => row.items).filter(item => item.materialCode === "A").reduce((sum, item) => sum + item.quantity, 0), 60);
  assert.throws(() => normalizeSplits(proposal(), input.map((row, i) => i === 0 ? { ...row, quantity: 31 } : row)), /must total/);
  assert.throws(() => normalizeSplits(proposal(), [{ itemId: 9, quantity: 60 }]), /valid material/);
  assert.throws(() => normalizeSplits(proposal(), [{ itemId: 1, quantity: -1 }]), /positive quantity/);
});
test('optional alternative fields inherit the original schedule', () => {
  assert.deepEqual(normalizeSplits(proposal()).map(row => [row.date, row.time]), [['2026-09-06', '09:00'], ['2026-09-06', '09:00']]);
});
test('inspection records an on-time partial receipt and creates only shortage quantities', () => {
  const s = proposal();
  s.receipt = inspectReceipt(s, { outcome: 'NOT_IN_FULL', items: [{ itemId: 1, acceptedQuantity: 40, reason: 'Quality rejected', date: '2026-09-08', time: '11:00' }, { itemId: 2, acceptedQuantity: 5 }] });
  assert.equal(s.receipt.onTime, true); assert.equal(s.receipt.inFull, false); assert.equal(s.receipt.otif, false);
  const state = { shipments: [s] }; const replacements = createReplacements(state, s, nextId, nextCode);
  assert.equal(replacements.length, 1); assert.equal(replacements[0].items[0].quantity, 20);
  assert.equal(replacements[0].replacementForId, 1); assert.equal(replacements[0].bookingStatus, 'PENDING_SUPPLIER');
  assert.equal(replacements[0].gateInAt, undefined);
  assert.throws(() => inspectReceipt(s, { outcome: 'FULL', items: [{ itemId: 1, acceptedQuantity: 70 }, { itemId: 2, acceptedQuantity: 5 }] }), /Invalid accepted/);
  assert.throws(() => inspectReceipt(s, { outcome: 'NOT_IN_FULL', items: [{ itemId: 1, acceptedQuantity: 40 }, { itemId: 2, acceptedQuantity: 5 }] }), /replacement date/);
});
test('late full receipt is not OTIF and missing inspection is not counted as success', () => {
  const s = proposal(); s.gateInAt = '2026-09-06T02:00:00Z';
  s.receipt = inspectReceipt(s, { outcome: 'FULL', items: s.items.map(item => ({ itemId: item.id, acceptedQuantity: item.quantity })) }, 30);
  assert.equal(s.receipt.inFull, true); assert.equal(s.receipt.otif, false);
  const result = calculateKpi([s, { ...proposal(), id: 2 }, { ...s, id: 3, replacementForId: 1 }], '2026-09');
  assert.equal(result.confirmed, 2); assert.equal(result.evaluated, 1); assert.equal(result.otifPercent, 0); assert.equal(result.awaitingInspection, 1);
});
test('SAP uses accepted quantities, leaves unknown fields blank, and preserves saved encoding', () => {
  const s = proposal(); s.receipt = { items: [{ itemId: 1, acceptedQuantity: 40 }] };
  const state = { shipments: [s], sapRows: { '1:1': { revision: 1, values: { matdoc: '001234' } } } };
  const row = sapRows(state)[0]; assert.equal(row.values.quantity, 40); assert.equal(row.values.matdoc, '001234'); assert.equal(row.values.breakdown, ''); assert.equal(row.values.description, 'Internal name');
});
