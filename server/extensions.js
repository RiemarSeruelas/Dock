import ExcelJS from 'exceljs';
import { calculateKpi, fail, validDay, validClock } from './receiving.js';

const columns = [
  ['deliveryDate', 'DELIVERY DATE', 24, 'DockFlow Gate in · Manila'], ['encodedBy', 'ENCODED BY', 22, 'SAP analyst'],
  ['item', 'ITEM', 18, 'DockFlow material code'], ['description', 'DESCRIPTION', 42, 'Internal material description'],
  ['drNumber', 'DR No', 20, 'Truck confirmation'], ['quantity', 'QUANTITY', 16, 'Accepted quantity after inspection'],
  ['poNumber', 'PO NUMBER', 20, 'Truck confirmation'], ['batch', 'BATCH', 20, 'SAP analyst'],
  ['breakdown', 'BREAKDOWN', 24, 'SAP analyst / DR'], ['mfgDate', 'MFG. DATE', 18, 'Material record / SAP analyst'],
  ['expDate', 'EXP DATE', 18, 'Material record / SAP analyst'], ['matdoc', 'MATDOC', 22, 'SAP analyst'],
  ['supplierLot', "Supplier’s LOT", 22, 'SAP analyst / DR'], ['remarks', 'REMARKS', 35, 'SAP analyst'],
];
const manila = date => date ? new Intl.DateTimeFormat('en-PH', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Asia/Manila' }).format(new Date(date)) : '';
export const sapRows = state => state.shipments.filter(s => s.bookingStatus === 'APPROVED' && s.gateInAt).flatMap(s => s.items.map(item => {
  const key = `${s.id}:${item.id}`;
  const saved = state.sapRows?.[key];
  const defaults = { deliveryDate: manila(s.gateInAt), encodedBy: '', item: item.materialCode, description: item.materialName || '', drNumber: s.drNumber || item.dnNumber || '', quantity: s.receipt?.items.find(row => row.itemId === item.id)?.acceptedQuantity ?? item.quantity, poNumber: s.poNumber || item.poNumber || '', batch: item.batchNumber || '', breakdown: '', mfgDate: item.productionDate || '', expDate: item.expiryDate || '', matdoc: '', supplierLot: '', remarks: '' };
  return { key, shipmentId: s.id, supplier: s.supplier, revision: saved?.revision || 0, verified: saved?.verified || false, values: { ...defaults, ...saved?.values } };
}));
export function registerExtensions({ app, auth, allow, asyncRoute, store, canAccessShipment, supplierSafeShipment, nextId, nextCode, addNotification, addAudit, emailSender, emailNotifications }) {
  app.get('/api/shipments/lookup', auth, asyncRoute(async (req, res) => {
    const state = await store.read();
    const raw = String(req.query.code || '').trim();
    let code = raw;
    try { const url = new URL(raw); code = url.searchParams.get('shipment') || url.pathname.split('/').pop() || raw; } catch {}
    try { const json = JSON.parse(raw); code = json.shipmentNumber || json.deliveryCode || raw; } catch {}
    const s = state.shipments.find(s => [s.shipmentNumber, s.deliveryCode, String(s.id)].includes(code));
    if (!s || !canAccessShipment(req.user, s) || s.bookingStatus !== 'APPROVED') return res.status(404).json({ message: 'Confirmed delivery not found' });
    res.json({ shipment: supplierSafeShipment(s) });
  }));
  app.get('/api/sap/rows', auth, allow('sap'), asyncRoute(async (_req, res) => res.json({ rows: sapRows(await store.read()), columns, storage: 'JSON_TRIAL' })));
  app.put('/api/sap/rows', auth, allow('sap'), asyncRoute(async (req, res) => {
    const rows = req.body?.rows;
    if (!Array.isArray(rows) || rows.length > 1000 || new Set(rows.map(row => row.key)).size !== rows.length) fail('Choose up to 1,000 unique worksheet rows');
    await store.update(state => {
      const current = sapRows(state);
      for (const row of rows) {
        const existing = current.find(item => item.key === row.key);
        if (!existing || existing.revision !== Number(row.revision)) fail('Worksheet changed. Reload before saving.', 409);
        if (!row.values || Object.keys(row.values).some(key => !columns.some(column => column[0] === key))) fail('Unknown worksheet column');
        if (Object.values(row.values).some(value => !['string', 'number'].includes(typeof value) || String(value).length > 2000)) fail('Worksheet cell is invalid or too long');
        if (row.values.quantity !== '' && (!Number.isFinite(Number(row.values.quantity)) || Number(row.values.quantity) < 0)) fail('Quantity must be zero or greater');
      }
      state.sapRows ||= {};
      for (const row of rows) state.sapRows[row.key] = { values: { ...row.values, encodedBy: req.user.name }, revision: Number(row.revision) + 1, verified: Boolean(row.verified), updatedBy: req.user.id, updatedAt: new Date().toISOString() };
      addAudit(state, req.user, 'SAP_WORKSHEET_SAVED', `${rows.length} receiving rows saved`);
    });
    res.json({ rows: sapRows(await store.read()) });
  }));
  app.get('/api/sap/export.xlsx', auth, allow('sap'), asyncRoute(async (_req, res) => {
    const workbook = new ExcelJS.Workbook(); const sheet = workbook.addWorksheet('Receiving register', { views: [{ state: 'frozen', ySplit: 2, xSplit: 3 }] });
    sheet.columns = columns.map(([key, header, width]) => ({ key, header, width }));
    sheet.addRow(columns.map(column => column[3]));
    for (const row of sapRows(await store.read())) sheet.addRow(row.values);
    sheet.getRow(1).height = 36; sheet.getRow(2).height = 34;
    sheet.eachRow((row, number) => row.eachCell({ includeEmpty: true }, (cell, column) => {
      cell.font = { name: 'Calibri', size: number === 2 ? 9 : 11, bold: number === 1, color: { argb: number <= 2 ? 'FFFFFFFF' : column === 12 ? 'FFB42318' : 'FF172B4D' } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: number === 1 ? 'FF08285F' : number === 2 ? 'FF164E63' : column === 8 ? 'FFCCF2DB' : number % 2 ? 'FFF1F5F9' : 'FFFFFFFF' } };
      cell.alignment = { vertical: 'middle', wrapText: true };
      cell.border = { bottom: { style: 'hair', color: { argb: 'FFCBD5E1' } } };
    }));
    sheet.autoFilter = { from: 'A1', to: 'N1' }; sheet.pageSetup = { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 };
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="dockflow-sap-receiving.xlsx"');
    await workbook.xlsx.write(res); res.end();
  }));
  app.get('/api/reports/kpi', auth, allow('admin', 'planner', 'production', 'supplier', 'ecosystem'), asyncRoute(async (req, res) => {
    const state = await store.read(); const month = String(req.query.month || new Date().toISOString().slice(0, 7));
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) fail('Choose a valid report month');
    const supplierId = ['supplier', 'ecosystem'].includes(req.user.role) ? Number(req.user.supplierId) : Number(req.query.supplierId || 0);
    res.json(calculateKpi(state.shipments.filter(row => canAccessShipment(req.user, row) && (!supplierId || Number(row.supplierId) === supplierId)), month));
  }));
  app.get('/api/ecosystem', auth, allow('admin', 'planner', 'ecosystem'), asyncRoute(async (req, res) => {
    const state = await store.read();
    const users = state.users.filter(user => user.role === 'ecosystem' && (req.user.role !== 'ecosystem' || Number(user.supplierId) === Number(req.user.supplierId)));
    const inventory = state.shipments.filter(s => s.destinationEcosystemId && s.receipt && canAccessShipment(req.user, s)).flatMap(s => s.receipt.items.map(row => {
      const reserved = state.shipments.filter(x => x.transferFromId === s.id && x.bookingStatus !== 'REJECTED').flatMap(x => x.items).filter(x => x.sourceItemId === row.itemId).reduce((sum, x) => sum + x.quantity, 0);
      return { sourceShipmentId: s.id, itemId: row.itemId, ecosystemId: s.destinationEcosystemId, materialCode: row.materialCode, uom: row.uom, available: Math.max(0, row.acceptedQuantity - reserved) };
    }));
    res.json({ ecosystems: users.map(user => ({ id: user.supplierId, name: user.name })), inventory });
  }));
  app.patch('/api/shipments/:id/destination', auth, allow('admin', 'planner'), asyncRoute(async (req, res) => {
    await store.update(state => {
      const s = state.shipments.find(s => s.id === Number(req.params.id));
      if (!s || !canAccessShipment(req.user, s)) fail('Proposal not found', 404);
      if (s.bookingStatus !== 'PENDING_SUPPLIER' || s.confirmedTruckLoads?.length) fail('Set the destination before truck confirmation', 409);
      const id = Number(req.body.ecosystemId);
      if (!state.users.some(user => user.role === 'ecosystem' && Number(user.supplierId) === id)) fail('Choose an Ecosystem account');
      s.originWorkArea ||= s.items.find(item => item.deliverySite)?.deliverySite?.toUpperCase();
      s.destinationEcosystemId = id;
      s.items.forEach(item => { item.deliverySite = 'ECOSYSTEM'; });
      addAudit(state, req.user, 'ECOSYSTEM_DESTINATION', 'Receiving destination set to Ecosystem warehouse', s.shipmentNumber);
    }); res.json({ ok: true });
  }));
  app.post('/api/ecosystem/transfers', auth, allow('admin', 'planner'), asyncRoute(async (req, res) => {
    const result = await store.update(state => {
      const source = state.shipments.find(s => s.id === Number(req.body.sourceShipmentId));
      const area = String(req.body.area || '');
      if (!source || !source.destinationEcosystemId || !source.receipt || !canAccessShipment(req.user, source)) fail('Received inventory not found', 404);
      if (!['DRESSINGS', 'SAVOURY'].includes(area) || (req.user.role === 'planner' && req.user.workArea !== area)) fail('Choose your receiving work area', 403);
      if (!validDay(req.body.date) || !validClock(req.body.time)) fail('Choose a delivery date and time');
      const received = source.receipt.items.find(row => row.itemId === Number(req.body.itemId));
      const reserved = state.shipments.filter(s => s.transferFromId === source.id && s.bookingStatus !== 'REJECTED').flatMap(s => s.items).filter(item => item.sourceItemId === Number(req.body.itemId)).reduce((sum, item) => sum + item.quantity, 0);
      const quantity = Number(req.body.quantity);
      if (!received || !Number.isFinite(quantity) || quantity <= 0 || quantity > received.acceptedQuantity - reserved) fail('Requested quantity exceeds available inventory');
      const supplier = state.suppliers.find(s => Number(s.id) === Number(source.destinationEcosystemId));
      if (!supplier) fail('Ecosystem supplier account is unavailable');
      const id = nextId(state.shipments);
      const delivery = { id, supplierId: supplier.id, supplier: supplier.name, vendorCode: supplier.vendorCode, shipmentNumber: nextCode('SHP', id, req.body.date), bookingReceipt: nextCode('BKG', id, req.body.date), transferFromId: source.id, scheduledDate: req.body.date, scheduledTime: req.body.time, bookingStatus: 'PENDING_SUPPLIER', status: 'PROPOSED', truckPlate: '', driverName: '', driverPhone: '', confirmedTruckLoads: [], palletsScanned: 0, palletsTotal: 0, materialWeightKg: 0, items: [{ ...source.items.find(item => item.id === received.itemId), id: Math.max(0, ...state.shipments.flatMap(s => s.items.map(item => item.id))) + 1, sourceItemId: received.itemId, quantity, deliverySite: area, supplierApprovedAt: null, assignedTruckPlate: null }] };
      state.shipments.push(delivery);
      state.users.filter(user => user.role === 'ecosystem' && user.supplierId === supplier.id).forEach(user => addNotification(state, user, { title: 'ULI stock transfer request', message: `${quantity} ${received.uom} of ${received.materialCode} to ${area}`, shipment: delivery, requiresAction: true }));
      addAudit(state, req.user, 'ECOSYSTEM_TRANSFER_REQUEST', `${quantity} ${received.uom} requested`, delivery.shipmentNumber);
      return { shipment: supplierSafeShipment(delivery) };
    }); res.status(201).json(result);
  }));
  // Single-instance trial scheduler. Successful recipient/month sends are stored;
  // failures retry hourly. A crash between SMTP acceptance and saving can resend.
  let running = false;
  const monthly = async () => {
    if (running || !emailSender) return;
    running = true;
    try {
      const current = new Date(Date.now() + 8 * 3600000);
      const month = new Date(Date.UTC(current.getUTCFullYear(), current.getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
      const state = await store.read();
      const recipients = state.users.filter(user => ['admin', 'planner', 'supplier', 'ecosystem'].includes(user.role) && user.email && user.emailVerifiedAt);
      for (const user of recipients) {
        const key = `${month}:${user.id}:${user.email}`;
        if (state.monthlyKpiSent?.[key]) continue;
        const rows = state.shipments.filter(row => canAccessShipment(user, row) && (user.role !== 'ecosystem' || Number(row.supplierId) === Number(user.supplierId)));
        const report = calculateKpi(rows, month);
        const result = await emailNotifications.sendKpi({ sender: emailSender, recipient: user.email, report, name: ['supplier', 'ecosystem'].includes(user.role) ? user.name : 'ULI' });
        if (result.status === 'SENT') await store.update(draft => { draft.monthlyKpiSent ||= {}; draft.monthlyKpiSent[key] = new Date().toISOString(); });
      }
    } catch (error) { console.error('[monthly KPI]', error.message); } finally { running = false; }
  };
  if (process.env.NODE_ENV !== 'test') { setTimeout(() => void monthly(), 10000).unref(); setInterval(() => void monthly(), 3600000).unref(); }
}
