import { registerClearance } from "./clearance.js";
import { createSapRepository, sapCanFormat, sapColumns, sapEditableColumns, sapNetworkAllowed } from "./sap-postgres.js";
import { registerAdminOperations } from "./admin-operations.js";
import ExcelJS from 'exceljs';
import { randomUUID } from 'node:crypto';
import { calculateKpi, fail } from './receiving.js';
import { encodedByName } from './sap-postgres.js';

const columns = sapColumns;
const manila = date => date ? new Intl.DateTimeFormat('en-PH', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Asia/Manila' }).format(new Date(date)) : '';
export const sapRows = state => [...state.shipments.filter(s => s.bookingStatus === 'APPROVED' && s.gateInAt).flatMap(s => s.items.map(item => {
  const key = `${s.id}:${item.id}`;
  const saved = state.sapRows?.[key];
  const clearance = s.clearance?.[item.id] || {};
  const accepted = s.receipt?.items?.find(row => Number(row.itemId) === Number(item.id))?.acceptedQuantity;
  const defaults = {
    supplierName: s.supplier || '', plateNumber: s.truckPlate || '', driverName: s.driverName || '',
    gateIn: manila(s.gateInAt), gateOut: manila(s.gateOutAt), destination: item.deliverySite || s.originWorkArea || '',
    deliveryDate: manila(s.gateInAt), encodedBy: '', item: item.materialCode, description: item.materialName || '',
    drNumber: s.drNumber || item.dnNumber || '', gatepassNumber: '', quantity: item.quantity, uom: item.uom || '',
    poNumber: s.poNumber || item.poNumber || '', batch: item.batchNumber || '', breakdown: '',
    mfgDate: item.productionDate || '', expDate: item.expiryDate || '', matdoc: '', supplierLot: '', remarks: '',
    inventoryController: clearance.inventoryController || '', receivingController: clearance.receivingController || '',
    helperCount: clearance.helperCount ?? ([s.helper1Name,s.helper2Name].filter(Boolean).length || ''), truckType: clearance.truckType || '',
    actualReceived: clearance.actualReceived ?? accepted ?? '', palletCount: clearance.palletCount || '',
    warehouseRemarks: clearance.remarks || '', startUnloading: manila(s.unloadingAt), endUnloading: manila(s.receivedAt),
    qaStart: clearance.qaStart || '', qaEnd: clearance.qaEnd || '', qaDisposition: clearance.disposition || '',
  };
  return { key, shipmentId: s.id, supplier: s.supplier, revision: saved?.revision || 0, verified: saved?.verified || false, values: { ...defaults, ...saved?.values }, formats: saved?.formats || {}, rowHeight: saved?.rowHeight ?? null, rowHidden: saved?.rowHidden || false };
})), ...(state.sapManualRows || []).map(row=>{const saved=state.sapRows?.[row.key];return saved?{...row,...saved,values:{...row.values,...saved.values}}:row;})];
export function registerExtensions({ app, auth, allow, asyncRoute, store, canAccessShipment, supplierSafeShipment, nextId, nextCode, addNotification, addAudit, emailSender, emailNotifications, publicUser, bcrypt, database }) {
  registerAdminOperations({ app, auth, allow, asyncRoute, store, canAccessShipment, supplierSafeShipment, nextId, nextCode, addNotification, addAudit, emailSender, emailNotifications, publicUser, bcrypt, database });
  const sap = createSapRepository();
  registerClearance({app,auth,allow,asyncRoute,store,canAccessShipment,supplierSafeShipment,sap});
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
  app.get('/api/sap/rows', auth, allow('sap','admin','planner','warehouse'), asyncRoute(async (req,res) => {
    const role=req.user?.role||'sap';const access = { editableColumns: sapEditableColumns(role), canFormat: sapCanFormat(role) };
    if (!sapNetworkAllowed(req)) return res.json({ rows: [], columns, ...access, hasMore: false, available: false, message: 'No data. Connect to the authorized SAP network.' });
    const offset = Math.max(0, Math.min(1000000, Math.floor(Number(req.query.offset)||0)));
    const limit = Math.max(1, Math.min(100, Math.floor(Number(req.query.limit)||25)));
    const search = String(req.query.search || '').trim().slice(0,200);
    const sort = String(req.query.sort || 'desc').toLowerCase() === 'asc' ? 'asc' : 'desc';
    const keys = req.query.keys ? String(req.query.keys).split(",") : null;
    if(keys && (keys.length>50 || keys.some(key=>!key || key.length>200 || /[\u0000-\u001f]/.test(key)))) fail("Refresh at most 50 valid rows");
    try {
      const defaults = sapRows(await store.read());
      if(keys) { if(sap.jsonTrial) return res.json({rows:defaults.filter(row=>keys.includes(row.key)),columns,...access,hasMore:false,available:true}); return res.json({rows:await sap.byKeys(keys),columns,...access,hasMore:false,available:true}); }
      if (sap.jsonTrial) {
        const term=search.toLowerCase();const filtered=term?defaults.filter(row=>Object.values(row.values).some(value=>String(value).toLowerCase().includes(term))):defaults;const sorted=sort==='asc'?[...filtered].reverse():filtered;
        return res.json({ rows: sorted.slice(offset,offset+limit), columns, ...access, hasMore: sorted.length>offset+limit, available:true });
      }
      await sap.sync(defaults); res.json({ ...await sap.page(offset,limit,search,sort), columns, ...access, available:true });
    } catch { res.json({ rows: [], columns, ...access, hasMore:false, available:false, message:'No data. The SAP database is unavailable on this network.' }); }
  }));
  app.post('/api/sap/rows', auth, allow('sap','admin'), asyncRoute(async (req,res) => {
    if (!sapNetworkAllowed(req)) fail('Connect to the authorized SAP network',403);
    const values = req.body?.values && typeof req.body.values === 'object' && !Array.isArray(req.body.values) ? req.body.values : {};
    if (Object.keys(values).some(key=>!columns.some(column=>column[0]===key)) || Object.values(values).some(value=>!['string','number'].includes(typeof value)||String(value).length>2000)) fail('Invalid worksheet cells');
    const encodedBy=encodedByName(req.user?.name);
    let row;
    if(sap.jsonTrial) {
      row={key:`manual:${randomUUID()}`,revision:0,verified:false,values:Object.fromEntries(columns.map(([key])=>[key,key==='encodedBy'?encodedBy:(values[key]??'')])),formats:{},rowHeight:null,rowHidden:false};
      await store.update(state=>{state.sapManualRows ||= [];state.sapManualRows.unshift(row);});
    } else { try { row=await sap.add(values,req.user?.name); } catch { fail('SAP database could not add the worksheet row',503); } }
    res.status(201).json({row});
  }));
  app.put('/api/sap/rows', auth, allow('sap','admin','planner','warehouse'), asyncRoute(async (req,res) => {
    if (!sapNetworkAllowed(req)) fail('Connect to the authorized SAP network',403);
    const rows=req.body.rows;
    if(!Array.isArray(rows)||!rows.length||rows.length>1000||new Set(rows.map(row=>row.key)).size!==rows.length) fail('Choose unique worksheet rows');
    const role=req.user?.role||'sap';const editable=new Set(sapEditableColumns(role));const canFormat=sapCanFormat(role);
    for(const row of rows) {
      if(!row.values || Object.keys(row.values).some(key=>!columns.some(column=>column[0]===key)) || Object.values(row.values).some(value=>!['string','number'].includes(typeof value)||String(value).length>2000)) fail('Invalid worksheet cells');
      for(const key of ['quantity','actualReceived']) if(row.values[key] !== '' && row.values[key] !== undefined && (!Number.isFinite(Number(row.values[key])) || Number(row.values[key])<0)) fail('Quantities must be zero or greater');
      row.values=Object.fromEntries(Object.entries(row.values).filter(([key])=>editable.has(key)));
      if(canFormat&&row.formats!==undefined&&(!row.formats||typeof row.formats!=='object'||Array.isArray(row.formats)||JSON.stringify(row.formats).length>30000)) fail('Invalid worksheet formatting');
      if(!canFormat){delete row.formats;delete row.rowHeight;delete row.rowHidden;}
      if(row.rowHeight!==undefined&&row.rowHeight!==null&&(!Number.isFinite(Number(row.rowHeight))||Number(row.rowHeight)<20||Number(row.rowHeight)>160)) fail('Row height must be between 20 and 160');
    }
    if(sap.jsonTrial) await store.update(state=>{
      const current=sapRows(state);
      for(const row of rows) if(current.find(item=>item.key===row.key)?.revision !== Number(row.revision)) fail('Worksheet changed. Reload before saving.',409);
      state.sapRows ||= {};
      for(const row of rows) {const previous=state.sapRows[row.key]||{};state.sapRows[row.key]={...previous,values:{...previous.values,...row.values,...(['sap','admin'].includes(role)?{encodedBy:encodedByName(req.user?.name)}:{})},formats:row.formats??previous.formats,rowHeight:row.rowHeight??previous.rowHeight,rowHidden:row.rowHidden??previous.rowHidden,revision:Number(row.revision)+1,verified:['sap','admin'].includes(role)?!!row.verified:!!previous.verified,updatedBy:req.user?.id,updatedAt:new Date().toISOString()};}
    });
    else { try { await sap.save(rows,req.user?.name||'SAP Analyst',role); } catch(error) { if(error.status===409||error.status===403) throw error; fail('SAP database could not save the worksheet',503); } }
    res.json({saved:rows.map(row=>({key:row.key,revision:Number(row.revision)+1}))});
  }));
  app.get('/api/sap/export.xlsx', auth, allow('sap','admin','planner','warehouse'), asyncRoute(async (req, res) => {
    if(!sapNetworkAllowed(req)) fail('Connect to the authorized SAP network',403);
    let exportRows;
    try { const defaults=sapRows(await store.read()); if(sap.jsonTrial) exportRows=defaults; else {await sap.sync(defaults);exportRows=await sap.all();} } catch {fail('SAP database is unavailable',503);}
    const workbook = new ExcelJS.Workbook(); const sheet = workbook.addWorksheet('Receiving register', { views: [{ state: 'frozen', ySplit: 1, xSplit: 3 }] });
    const legacyOrder=['deliveryDate','encodedBy','item','description','drNumber','quantity','uom','actualReceived','poNumber','batch','breakdown','mfgDate','expDate','matdoc','supplierLot','remarks'];
    const exportColumns=[...legacyOrder.map(key=>columns.find(column=>column[0]===key)).filter(Boolean),...columns.filter(column=>!legacyOrder.includes(column[0]))];
    sheet.columns = exportColumns.map(([key, header, width]) => ({ key, header, width }));
    for (const data of exportRows) {const excelRow=sheet.addRow(data.values);if(data.rowHeight)excelRow.height=data.rowHeight;for(const [key,format] of Object.entries(data.formats||{})){const column=exportColumns.findIndex(([name])=>name===key)+1;if(!column)continue;const cell=excelRow.getCell(column);const hex=value=>String(value||'').replace('#','').toUpperCase();cell.font={...cell.font,name:format.fontFamily||'Calibri',size:Number(format.fontSize||11),bold:!!format.bold,italic:!!format.italic,underline:!!format.underline,strike:!!format.strike,color:format.color?{argb:`FF${hex(format.color)}`} : undefined};if(format.fill)cell.fill={type:'pattern',pattern:'solid',fgColor:{argb:`FF${hex(format.fill)}`}};cell.alignment={horizontal:format.align||undefined,vertical:format.vertical||'middle',wrapText:!!format.wrap,indent:Number(format.indent||0)};}}
    sheet.getRow(1).height = 34;
    sheet.eachRow((row, number) => row.eachCell({ includeEmpty: true }, (cell, column) => {
      cell.font = { name: 'Calibri', size: 11, bold: number === 1, color: { argb: number === 1 ? 'FFFFFFFF' : column === 14 ? 'FFB42318' : 'FF172B4D' } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: number === 1 ? 'FF08285F' : column === 10 ? 'FF00C663' : number % 2 ? 'FFF1F5F9' : 'FFFFFFFF' } };
      cell.alignment = { vertical: 'middle', wrapText: true };
      cell.border = { bottom: { style: 'hair', color: { argb: 'FFCBD5E1' } } };
    }));
    sheet.autoFilter = { from: {row:1,column:1}, to: {row:1,column:exportColumns.length} }; sheet.pageSetup = { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 };
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
      const clock = `${String(current.getUTCHours()).padStart(2,'0')}:${String(current.getUTCMinutes()).padStart(2,'0')}`;
      const fallback = state.settings.monthlyEmailSchedule || { day: 1, time: '09:00' };
      const recipients = state.users.filter(user => ['admin', 'planner', 'production', 'supplier', 'ecosystem', 'warehouse'].includes(user.role) && user.monthlyPerformanceEnabled !== false && user.email && user.emailVerifiedAt);
      for (const user of recipients) {
        const schedule = { day: Math.min(28, Math.max(1, Number(user.monthlyPerformanceDay || fallback.day || 1))), time: /^([01]\d|2[0-3]):[0-5]\d$/.test(String(user.monthlyPerformanceTime || '')) ? user.monthlyPerformanceTime : fallback.time || '09:00' };
        if(current.getUTCDate()<schedule.day || (current.getUTCDate()===schedule.day && clock<schedule.time)) continue;
        const key = `${month}:${user.id}:${user.email}`;
        if (state.monthlyKpiSent?.[key]) continue;
        const rows = state.shipments.filter(row => canAccessShipment(user, row) && (user.role !== 'ecosystem' || Number(row.supplierId) === Number(user.supplierId)));
        const report = calculateKpi(rows, month);
        const result = await emailNotifications.sendKpi({ sender: emailSender, recipient: user.email, report, name: ['supplier', 'ecosystem'].includes(user.role) ? user.name : 'ULI' });
        if (result.status === 'SENT') await store.update(draft => { draft.monthlyKpiSent ||= {}; draft.monthlyKpiSent[key] = new Date().toISOString(); });
      }
    } catch (error) { console.error('[monthly KPI]', error.message); } finally { running = false; }
  };
  if (process.env.NODE_ENV !== 'test') { setTimeout(() => void monthly(), 10000).unref(); setInterval(() => void monthly(), 60000).unref(); }
}
