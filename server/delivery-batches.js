import { fail, roundQuantity, validDay } from './receiving.js';

const cleanText = (value, length = 120) => String(value || '').trim().slice(0, length);

export function storedBatchRows(item) {
  if (Array.isArray(item?.batches) && item.batches.length) return item.batches;
  return [{
    id: 1,
    batchNumber: cleanText(item?.batchNumber),
    supplierLot: cleanText(item?.supplierLot),
    quantity: Number(item?.quantity || 0),
    productionDate: cleanText(item?.productionDate),
    expiryDate: cleanText(item?.expiryDate),
    legacy: true,
  }];
}

export function batchRecordKey(shipmentId, itemId, batch, index, hasStoredBatches = true) {
  return hasStoredBatches ? `${shipmentId}:${itemId}:batch:${Number(batch?.id) || index + 1}` : `${shipmentId}:${itemId}`;
}

export function normalizeSupplierBatches(item, input, expectedQuantity) {
  if (!Array.isArray(input) || !input.length) fail(`Add at least one batch for ${item.materialCode}`);
  if (input.length > 100) fail(`${item.materialCode} has too many batches`);
  const rows = input.map((row, index) => {
    const batchNumber = cleanText(row?.batchNumber);
    const supplierLot = cleanText(row?.supplierLot);
    const quantity = Number(row?.quantity);
    const productionDate = cleanText(row?.productionDate, 10);
    const expiryDate = cleanText(row?.expiryDate, 10);
    if (!batchNumber || !supplierLot) fail(`${item.materialCode} batch ${index + 1}: enter the batch number and supplier lot`);
    if (!Number.isFinite(quantity) || quantity <= 0) fail(`${item.materialCode} batch ${index + 1}: enter a positive quantity`);
    if (!validDay(productionDate) || !validDay(expiryDate)) fail(`${item.materialCode} batch ${index + 1}: enter valid production and expiration dates`);
    if (expiryDate < productionDate) fail(`${item.materialCode} batch ${index + 1}: expiration date cannot be before production date`);
    return { id: Number(row?.id) || index + 1, batchNumber, supplierLot, quantity: roundQuantity(quantity), productionDate, expiryDate };
  });
  const total = roundQuantity(rows.reduce((sum, row) => sum + row.quantity, 0));
  if (Math.abs(total - Number(expectedQuantity)) > 0.000001) fail(`Batches for ${item.materialCode} must total ${expectedQuantity} ${item.uom}`);
  return rows;
}

export function distributeActualReceived(batches, actualReceived) {
  if (actualReceived === '' || actualReceived == null || !Number.isFinite(Number(actualReceived))) return batches.map(() => '');
  let remaining = Math.max(0, Number(actualReceived));
  return batches.map(batch => {
    const received = roundQuantity(Math.min(Number(batch.quantity || 0), remaining));
    remaining = roundQuantity(Math.max(0, remaining - received));
    return received;
  });
}
