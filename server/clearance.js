import PDFDocument from 'pdfkit';
import { fileURLToPath } from 'node:url';
import { fail } from './receiving.js';
import { batchRecordKey, distributeActualReceived, storedBatchRows } from './delivery-batches.js';
const template = fileURLToPath(new URL('./assets/inbound-clearance.png', import.meta.url));
const when = value => value ? new Intl.DateTimeFormat('en-PH',{dateStyle:'short',timeStyle:'short',timeZone:'Asia/Manila'}).format(new Date(value)) : '';
export const clearanceFields = ['helperCount','mode','truckType','palletCount','actualReceived','actualUom','remarks','qaSample','vacuum','qaStart','qaEnd','disposition','receivingController','inventoryController','clearedBy','materialType'];
export function clearanceData(shipment, item, sapValues = {}, manual = {}) {
  return { supplier:sapValues.supplierName || shipment.supplier,date:when(shipment.gateInAt).split(',')[0] || shipment.scheduledDate,materialType:item.materialType || '',truckPlate:sapValues.plateNumber || shipment.truckPlate,arrival:sapValues.gateIn || when(shipment.gateInAt),driver:sapValues.driverName || shipment.driverName,dr:sapValues.drNumber || shipment.drNumber || item.dnNumber || '',helperCount:sapValues.helperCount ?? ([shipment.helper1Name,shipment.helper2Name].filter(Boolean).length || ''),code:item.materialCode,description:sapValues.description || item.materialName || '',quantity:sapValues.quantity ?? item.quantity,uom:sapValues.uom || item.uom,actualReceived:sapValues.actualReceived !== undefined && sapValues.actualReceived !== '' ? sapValues.actualReceived : (shipment.receipt?.items.find(row=>row.itemId===item.id)?.acceptedQuantity ?? ''),actualUom:item.uom,po:sapValues.poNumber || shipment.poNumber || item.poNumber || '',lot:sapValues.supplierLot || '',batch:sapValues.batch || item.batchNumber || '',truckType:sapValues.truckType || '',palletCount:sapValues.palletCount || '',remarks:sapValues.warehouseRemarks || '',start:sapValues.startUnloading || when(shipment.unloadingAt),end:sapValues.endUnloading || when(shipment.gateOutAt || shipment.receivedAt),departure:sapValues.gateOut || when(shipment.gateOutAt),qaStart:sapValues.qaStart || '',qaEnd:sapValues.qaEnd || '',disposition:sapValues.qaDisposition || '',receivingController:sapValues.receivingController || '',inventoryController:sapValues.inventoryController || '',...manual };
}
export function makeClearancePdf(shipment, records) {
  const document = new PDFDocument({autoFirstPage:false,margin:0,info:{Title:'Inbound Clearance Form',Author:'DockFlow'}});
  const scale=842.88/1600;
  for(const record of records) {
    document.addPage({size:[842.88,595.92],margin:0}); document.image(template,0,0,{width:842.88,height:595.92});
    for(const shift of [0,704]) {
      const text=(value,x,y,width,height=22)=>{
        const str=String(value ?? ''); if(!str) return;
        let size=8; document.font('Helvetica');
        while(size>5 && document.fontSize(size).widthOfString(str)>width*scale && height<=25) size-=.5;
        document.fontSize(size).fillColor('#14253d').text(str,(x+shift)*scale,y*scale,{width:width*scale,height:height*scale,ellipsis:true,lineGap:0});
      };
      text(record.supplier,326,153,180);text(record.date,665,153,180);
      text(record.materialType,326,194,180);text(record.truckPlate,665,194,180);
      text(record.arrival,326,235,180);text(record.driver,665,235,180);
      text(record.dr,326,276,180);text(record.helperCount,665,276,180);
      text(record.truckType,709,342,135); if(record.mode==='PALLETIZED') text('X',210,340,20);if(record.mode==='MANUAL') text('X',399,340,20);
      text(record.code,393,410,405,35);text(record.description,393,464,405,42);
      text(record.quantity,393,530,157);text(record.uom,560,530,82);text(record.palletCount,728,530,75);
      text(record.actualReceived,393,572,155);text(record.actualUom,560,572,70);text(record.po,707,572,136);
      text(record.lot,285,615,245);text(record.batch,626,615,215);text(record.remarks,201,670,640,20);
      text(record.qaSample,370,757,156);text(record.vacuum,728,757,95);
      text(record.start,370,806,156);text(record.end,370,857,156);text(record.departure,370,907,156);
      text(record.qaStart,728,830,98);text(record.qaEnd,728,857,98);
      if(record.disposition) text('X',{RELEASE:601,HOLD:685,REJECT:770}[record.disposition] || 601,918,16);
      text(record.driver,266,965,250);text(record.clearedBy,600,965,225);
      text(record.receivingController,264,1018,255);text(record.inventoryController,600,1018,230);
    }
  }
  return document;
}
export function registerClearance({app,auth,allow,asyncRoute,store,canAccessShipment,supplierSafeShipment,sap}) {
  const chooseSapRows = (shipment, item, sapData) => {
    const baseKey = `${shipment.id}:${item.id}`;
    const exact = sapData.filter(row => row.key === baseKey || row.key.startsWith(`${baseKey}:batch:`) || (String(row.shipmentId) === String(shipment.id) && row.values?.item === item.materialCode));
    if (exact.length) return exact;
    const drValues = [shipment.drNumber, item.dnNumber].flatMap(value => String(value || '').split(',')).map(value => value.trim()).filter(Boolean);
    const poValues = [shipment.poNumber, item.poNumber].flatMap(value => String(value || '').split(',')).map(value => value.trim()).filter(Boolean);
    const matched = sapData.filter(row => row.values?.item === item.materialCode && (drValues.includes(String(row.values?.drNumber || '').trim()) || poValues.includes(String(row.values?.poNumber || '').trim())));
    return matched.length ? matched : sapData.filter(row => row.values?.item === item.materialCode);
  };
  const materialSapValues = (shipment, item, sapData) => {
    const rows = chooseSapRows(shipment,item,sapData);
    const values = rows[0]?.values || {};
    const join = key => [...new Set(rows.map(row=>String(row.values?.[key]||'').trim()).filter(Boolean))].join(' / ');
    return {...values,quantity:item.quantity,batch:join('batch') || storedBatchRows(item).map(row=>row.batchNumber).filter(Boolean).join(' / '),supplierLot:join('supplierLot') || storedBatchRows(item).map(row=>row.supplierLot).filter(Boolean).join(' / ')};
  };
  const load = async req => {
    const state=await store.read();const shipment=state.shipments.find(row=>row.id===Number(req.params.id));
    if(!shipment||!canAccessShipment(req.user,shipment)) fail('Delivery not found',404);
    if(shipment.bookingStatus!=='APPROVED') fail('Confirm the delivery before preparing clearance',409);
    let sapData=[];
    try { sapData=sap.jsonTrial ? Object.entries(state.sapRows||{}).filter(([key])=>key.startsWith(`${shipment.id}:`)).map(([key,row])=>({key,values:row.values,revision:row.revision||0})) : await sap.forClearance(shipment); } catch {}
    return {shipment,sapData,records:shipment.items.map(item=>({itemId:item.id,...clearanceData(shipment,{...item,materialType:item.materialType || state.materials?.find(material=>material.code===item.materialCode)?.type || ""},materialSapValues(shipment,item,sapData),shipment.clearance?.[item.id])}))};
  };
  app.get('/api/clearance',auth,allow('admin','planner','warehouse','sap'),asyncRoute(async(req,res)=>{const state=await store.read();res.json({shipments:state.shipments.filter(row=>row.bookingStatus==='APPROVED'&&canAccessShipment(req.user,row)).map(supplierSafeShipment)});}));
  app.get('/api/shipments/:id/clearance',auth,allow('admin','warehouse','ecosystem','sap'),asyncRoute(async(req,res)=>{const {shipment,records}=await load(req);res.json({shipment,records});}));
  app.put('/api/shipments/:id/clearance',auth,allow('admin','warehouse','ecosystem'),asyncRoute(async(req,res)=>{
    const {shipment,sapData}=await load(req);const input=req.body.records;
    if(!Array.isArray(input)||input.length!==shipment.items.length||new Set(input.map(row=>row.itemId)).size!==input.length) fail('Complete one clearance entry for each material');
    const sanitized={};
    for(const row of input) {
      if(!shipment.items.some(item=>item.id===Number(row.itemId))) fail('Unknown material');
      sanitized[row.itemId]=Object.fromEntries(clearanceFields.map(key=>[key,String(row[key] ?? '').trim().slice(0,key==='remarks'?300:120)]));
      if(row.mode && !['PALLETIZED','MANUAL'].includes(row.mode)) fail('Choose palletized or manual');
      if(row.disposition && !['RELEASE','HOLD','REJECT'].includes(row.disposition)) fail('Choose release, hold or reject');
      for(const key of ['helperCount','palletCount','actualReceived']) if(row[key]!==''&&row[key]!=null&&(!Number.isFinite(Number(row[key]))||Number(row[key])<0)) fail('Use nonnegative quantities');
    }
    let sapUpdated=false;
    if(!sap.jsonTrial) {
      try {
        const missing=shipment.items.filter(item=>!chooseSapRows(shipment,item,sapData).length);
        if(missing.length) await sap.sync(missing.flatMap(item=>{const hasStored=Array.isArray(item.batches)&&item.batches.length>0;return storedBatchRows(item).map((batch,index)=>({
          key:batchRecordKey(shipment.id,item.id,batch,index,hasStored),shipmentId:shipment.id,supplier:shipment.supplier,
          values:{supplierName:shipment.supplier,plateNumber:shipment.truckPlate,driverName:shipment.driverName,gateIn:when(shipment.gateInAt),gateOut:when(shipment.gateOutAt),destination:item.deliverySite||'',deliveryDate:when(shipment.gateInAt)||`${shipment.scheduledDate} ${shipment.scheduledTime}`,item:item.materialCode,description:item.materialName||'',drNumber:shipment.drNumber||item.dnNumber||'',quantity:batch.quantity,poNumber:shipment.poNumber||item.poNumber||'',batch:batch.batchNumber||'',supplierLot:batch.supplierLot||'',mfgDate:batch.productionDate||'',expDate:batch.expiryDate||''},
        }))}));
        const current=await sap.forClearance(shipment);
        const updates=shipment.items.flatMap(item=>{const sources=chooseSapRows(shipment,item,current);const manual=sanitized[item.id];const received=distributeActualReceived(sources.map(source=>({quantity:Number(source.values?.quantity||0)})),manual.actualReceived);return sources.map((source,index)=>({key:source.key,revision:source.revision,values:{inventoryController:manual.inventoryController,receivingController:manual.receivingController,helperCount:manual.helperCount,truckType:manual.truckType,actualReceived:received[index],palletCount:manual.palletCount,warehouseRemarks:manual.remarks,qaStart:manual.qaStart,qaEnd:manual.qaEnd,qaDisposition:manual.disposition}}));});
        if(updates.length) await sap.save(updates,req.user.name,'warehouse');
        sapUpdated=true;
      } catch {}
    }
    await store.update(state=>{const row=state.shipments.find(row=>row.id===shipment.id);row.clearance=sanitized;row.clearanceUpdatedBy=req.user.name;row.clearanceUpdatedAt=new Date().toISOString();});res.json({ok:true,sapUpdated});
  }));
  app.get('/api/shipments/:id/clearance.pdf',auth,allow('admin','planner','warehouse','ecosystem','sap'),asyncRoute(async(req,res)=>{
    const {shipment,records}=await load(req);res.setHeader('Content-Type','application/pdf');res.setHeader('Content-Disposition',`attachment; filename="inbound-clearance-${shipment.shipmentNumber}.pdf"`);const document=makeClearancePdf(shipment,records);document.pipe(res);document.end();
  }));
}
