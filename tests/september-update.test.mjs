import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePhone, validateProposedTrucks, bookApprovedProposal } from '../server/booking.js';
import { applySplits, normalizeSplits, inspectReceipt, createReplacements } from '../server/receiving.js';
import { sapNetworkAllowed, createSapRepository } from '../server/sap-postgres.js';
import { nextReportSend } from '../server/admin-operations.js';
import { clearanceData, makeClearancePdf } from '../server/clearance.js';
import { clientAddress } from '../server/client-network.js';
import { registerExtensions } from '../server/extensions.js';
import express from 'express';

const nextId = rows => Math.max(0,...rows.map(row=>row.id))+1;
const nextCode = (prefix,id) => `${prefix}-${id}`;
const shipment = () => ({id:1,supplier:'Sample',supplierId:1,scheduledDate:'2026-09-08',scheduledTime:'09:00',gateInAt:'2026-09-08T01:00:00Z',items:[{id:1,materialCode:'00123',quantity:300,uom:'KG'},{id:2,materialCode:'B',quantity:20,uom:'PC'}]});
test('alternative approval preserves split quantities and books distinct QR codes for each truck and date',()=>{
 const row=shipment(),state={shipments:[row]};
 const trucks=validateProposedTrucks(row,[{truckPlate:'AAA',itemIds:[1]},{truckPlate:'BBB',itemIds:[2]}]);
 row.quantityAllocations=normalizeSplits(row,[{itemId:1,quantity:200,date:'2026-09-08',time:'09:00'},{itemId:1,quantity:100,date:'2026-09-09',time:'10:00'},{itemId:2,quantity:20,date:'2026-09-08',time:'09:00'}]);
 let qr=0;
 for(const split of applySplits(state,row,nextId,nextCode)) bookApprovedProposal(state,split,trucks,{name:'Planner'},{nextId,nextCode,issueDeliveryCode:()=>`QR-${++qr}`});
 assert.equal(state.shipments.length,3);
 assert.equal(new Set(state.shipments.map(row=>row.deliveryCode)).size,3);
 assert.ok(state.shipments.every(row=>row.bookingStatus==='APPROVED'&&row.status==='BOOKED'));
 assert.equal(state.shipments.flatMap(row=>row.items).filter(row=>row.materialCode==='00123').reduce((total,row)=>total+row.quantity,0),300);
 assert.throws(()=>validateProposedTrucks(shipment(),[{itemIds:[1]},{itemIds:[1,2]}]),/exactly one/);
 assert.equal(normalizePhone('0917 123-4567'),'+639171234567');
 assert.equal(normalizePhone('+63 (917) 123 4567'),'+639171234567');
});
test('SAP denies unknown networks and ignores forwarded identities from untrusted peers',()=>{
 const saved={allowed:process.env.SAP_ALLOWED_CIDRS,trusted:process.env.SAP_TRUSTED_PROXY_CIDRS};
 try {
  process.env.SAP_ALLOWED_CIDRS='10.20.0.0/16';process.env.SAP_TRUSTED_PROXY_CIDRS='192.168.1.10/32';
  assert.equal(sapNetworkAllowed({socket:{remoteAddress:'203.0.113.1'},headers:{'x-forwarded-for':'10.20.1.2'}}),false);
  assert.equal(clientAddress({socket:{remoteAddress:'203.0.113.1'},headers:{'x-forwarded-for':'10.20.1.2'}}),'203.0.113.1');
  assert.equal(sapNetworkAllowed({socket:{remoteAddress:'::ffff:10.20.1.2'},headers:{}}),true);
  assert.equal(sapNetworkAllowed({socket:{remoteAddress:'192.168.1.10'},headers:{'x-forwarded-for':'10.20.1.2, 203.0.113.1'}}),false);
  assert.equal(sapNetworkAllowed({socket:{remoteAddress:'192.168.1.10'},headers:{'x-forwarded-for':'10.20.1.2'}}),true);
  process.env.SAP_ALLOWED_CIDRS='';assert.equal(sapNetworkAllowed({socket:{remoteAddress:'10.20.1.2'},headers:{}}),false);
 } finally {for(const [key,value] of [['SAP_ALLOWED_CIDRS',saved.allowed],['SAP_TRUSTED_PROXY_CIDRS',saved.trusted]]) if(value===undefined)delete process.env[key];else process.env[key]=value;}
});
test('SAP API pages 25 records, refreshes loaded rows and returns no data outside the allowed network',async()=>{
 const saved=Object.fromEntries(['SAP_STORAGE','SAP_ALLOWED_CIDRS','SAP_TRUSTED_PROXY_CIDRS'].map(key=>[key,process.env[key]]));
 process.env.SAP_STORAGE='json';process.env.SAP_ALLOWED_CIDRS='127.0.0.1/32';process.env.SAP_TRUSTED_PROXY_CIDRS='';
 const state={shipments:Array.from({length:60},(_,i)=>({...shipment(),id:i+1,bookingStatus:'APPROVED',items:[{id:i+1,materialCode:`MAT-${i}`,quantity:1,uom:'KG'}]}))};
 const app=express();
 registerExtensions({app,auth:(_req,_res,next)=>next(),allow:()=> (_req,_res,next)=>next(),asyncRoute:fn=>(req,res,next)=>Promise.resolve(fn(req,res)).catch(next),store:{read:async()=>state},emailSender:null});
 const server=await new Promise(resolve=>{const server=app.listen(0,'127.0.0.1',()=>resolve(server));});
 const url=`http://127.0.0.1:${server.address().port}`;
 try {
  const first=await (await fetch(`${url}/api/sap/rows`)).json();
  const second=await (await fetch(`${url}/api/sap/rows?offset=25`)).json();
  assert.equal(first.rows.length,25);assert.equal(second.rows.length,25);assert.equal(first.hasMore,true);
  assert.equal(new Set([...first.rows,...second.rows].map(row=>row.key)).size,50);
  state.sapRows={'30:30':{revision:1,values:{actualReceived:'0',matdoc:'00042'}}};
  const refresh=await (await fetch(`${url}/api/sap/rows?keys=30:30`)).json();
  assert.equal(refresh.rows[0].values.matdoc,'00042');assert.equal(refresh.rows[0].values.actualReceived,'0');
  process.env.SAP_ALLOWED_CIDRS='10.0.0.0/8';
  const denied=await (await fetch(`${url}/api/sap/rows`,{headers:{'x-forwarded-for':'10.0.0.2'}})).json();
  assert.equal(denied.available,false);assert.deepEqual(denied.rows,[]);
 } finally {await new Promise(resolve=>server.close(resolve));for(const [key,value] of Object.entries(saved))if(value===undefined)delete process.env[key];else process.env[key]=value;}
});
test('missing PostgreSQL configuration fails closed',async()=>{
 const prior=process.env.POSTGRES_HOST;process.env.POSTGRES_HOST='your_postgres_host';
 try {await assert.rejects(()=>createSapRepository().page(0,25),/not configured/);} finally {if(prior===undefined)delete process.env.POSTGRES_HOST;else process.env.POSTGRES_HOST=prior;}
});
test('Not OTIF supports full quantities and partial receipts without inventing a replacement date',()=>{
 const row=shipment();
 row.receipt=inspectReceipt(row,{outcome:'NOT_OTIF',reason:'Quality rejected',items:[{itemId:1,acceptedQuantity:280,reason:'Damaged bag'},{itemId:2,acceptedQuantity:20}]});
 assert.equal(row.receipt.otif,false);assert.equal(row.receipt.items[0].remainingQuantity,20);
 assert.deepEqual(createReplacements({shipments:[row]},row,nextId,nextCode),[]);
 const full=inspectReceipt(row,{outcome:'NOT_OTIF',reason:'Missing documents',items:row.items.map(item=>({itemId:item.id,acceptedQuantity:item.quantity}))});
 assert.equal(full.inFull,true);assert.equal(full.otif,false);
});
test('monthly send dates use Manila time across year boundaries',()=>{
 assert.equal(nextReportSend({day:7,time:'08:30'},new Date('2026-12-08T00:00:00Z')),'2027-01-07T00:30:00.000Z');
 assert.equal(nextReportSend({day:7,time:'08:30'},new Date('2026-12-06T00:00:00Z')),'2026-12-07T00:30:00.000Z');
});
test('clearance retains leading zero codes and zero actual receipt; creates both copies',async()=>{
 const row=shipment();row.receipt={items:[{itemId:1,acceptedQuantity:0}]};
 const data=clearanceData(row,row.items[0],{batch:'000456'});
 assert.equal(data.actualReceived,0);assert.equal(data.code,'00123');assert.equal(data.batch,'000456');
 const doc=makeClearancePdf(row,[data]),chunks=[];
 const completed=new Promise((resolve,reject)=>{doc.on('data',chunk=>chunks.push(chunk));doc.on('end',resolve);doc.on('error',reject);});doc.end();await completed;
 assert.equal(Buffer.concat(chunks).subarray(0,4).toString(),'%PDF');
});
