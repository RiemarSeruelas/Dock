import { fail, validDay, validClock } from './receiving.js';
export function nextReportSend(schedule = {}, now = new Date()) {
  const day = Math.min(28, Math.max(1, Number(schedule.day || 1)));
  const time = validClock(schedule.time) ? schedule.time : '09:00';
  const date = new Date(now.getTime() + 8 * 3600000);
  let target = `${date.getUTCFullYear()}-${String(date.getUTCMonth()+1).padStart(2,'0')}-${String(day).padStart(2,'0')}T${time}:00+08:00`;
  if (Date.parse(target) <= now.getTime()) { date.setUTCMonth(date.getUTCMonth()+1, 1); target = `${date.getUTCFullYear()}-${String(date.getUTCMonth()+1).padStart(2,'0')}-${String(day).padStart(2,'0')}T${time}:00+08:00`; }
  return new Date(target).toISOString();
}
export function registerAdminOperations({ app, auth, allow, asyncRoute, store, canAccessShipment, supplierSafeShipment, nextId, nextCode, addNotification, addAudit, emailSender, emailNotifications, publicUser, bcrypt }) {
  const performanceRoles = new Set(['admin','planner','production','supplier','ecosystem','warehouse']);
  const emailPlan = state => {
    const fallback = state.settings.monthlyEmailSchedule || { day: 1, time: '09:00' };
    return {
      configured: Boolean(emailSender),
      accounts: state.users.filter(user => performanceRoles.has(user.role)).map(user => {
        const day = Math.min(28, Math.max(1, Number(user.monthlyPerformanceDay || fallback.day || 1)));
        const time = validClock(user.monthlyPerformanceTime) ? user.monthlyPerformanceTime : validClock(fallback.time) ? fallback.time : '09:00';
        return { id: user.id, name: user.name, email: user.email || '', verified: Boolean(user.emailVerifiedAt), enabled: user.monthlyPerformanceEnabled !== false, day, time, nextSendAt: nextReportSend({ day, time }), lastSentAt: Object.entries(state.monthlyKpiSent || {}).filter(([key]) => key.includes(`:${user.id}:`)).map(([,at]) => at).sort().at(-1) || null };
      }),
    };
  };
  app.post('/api/auth/change-password', auth, asyncRoute(async (req, res) => {
    const password = String(req.body.newPassword || '');
    if (password.length < 8 || password.length > 100) fail('Use a new password of 8–100 characters');
    const user = await store.update(async state => {
      const user = state.users.find(user => user.id === Number(req.user.id));
      if (!user) fail('Account not found', 404);
      const onboardingChange = Boolean(user.onboardingRequired && user.mustChangePassword && user.emailVerifiedAt);
      if (!onboardingChange && !(await bcrypt.compare(String(req.body.currentPassword || ''), user.passwordHash))) fail('Current password is incorrect', 403);
      if (await bcrypt.compare(password, user.passwordHash)) fail('Choose a different password from the initial one');
      user.passwordHash = await bcrypt.hash(password, 10); user.mustChangePassword = false; user.onboardingRequired = false;
      user.passwordChangedAt = new Date().toISOString();
      addAudit(state, req.user, 'PASSWORD_CHANGED', 'Account password updated');
      return publicUser(user);
    }); res.json({ user, signInAgain: false });
  }));
  app.get('/api/admin/email-schedule', auth, allow('admin'), asyncRoute(async (_req, res) => {
    res.json(emailPlan(await store.read()));
  }));
  app.put('/api/admin/email-schedule', auth, allow('admin'), asyncRoute(async (req, res) => {
    const plans = req.body.accounts;
    if (!Array.isArray(plans) || plans.length > 500 || new Set(plans.map(plan => Number(plan.id))).size !== plans.length) fail('Choose unique monthly performance accounts');
    for (const plan of plans) if (!Number.isInteger(Number(plan.day)) || Number(plan.day) < 1 || Number(plan.day) > 28 || !validClock(String(plan.time || '')) || typeof plan.enabled !== 'boolean') fail('Choose day 1–28, a valid Manila time, and an enabled setting for every account');
    const result = await store.update(state => {
      for (const plan of plans) {
        const user = state.users.find(user => Number(user.id) === Number(plan.id) && performanceRoles.has(user.role));
        if (!user) fail('Monthly performance account not found', 404);
        user.monthlyPerformanceEnabled = plan.enabled;
        user.monthlyPerformanceDay = Number(plan.day);
        user.monthlyPerformanceTime = String(plan.time);
      }
      return emailPlan(state);
    });
    res.json(result);
  }));
  app.get('/api/ecosystem', auth, allow('admin','planner','production','ecosystem'), asyncRoute(async (req, res) => {
    const state = await store.read();
    const accounts = state.users.filter(user => user.role === 'ecosystem' && (req.user.role !== 'ecosystem' || user.supplierId === req.user.supplierId));
    res.json({ ecosystems: accounts.map(user => ({ id: user.supplierId, name: user.name })), materials: (state.ecosystemMaterials || []).filter(row => req.user.role !== 'ecosystem' || row.ecosystemId === req.user.supplierId) });
  }));
  app.post('/api/ecosystem/materials', auth, allow('admin','ecosystem'), asyncRoute(async (req, res) => {
    const ecosystemId = req.user.role === 'ecosystem' ? req.user.supplierId : Number(req.body.ecosystemId);
    const code = String(req.body.materialCode || '').trim().toUpperCase(); const description = String(req.body.description || '').trim(); const uom = String(req.body.uom || '').trim().toUpperCase();
    if (!code || code.length > 100 || !description || description.length > 240 || !uom || uom.length > 20) fail('Enter a material code, description, and UOM');
    const row = await store.update(state => {
      if (!state.users.some(user => user.role === 'ecosystem' && user.supplierId === ecosystemId)) fail('Choose an Ecosystem account');
      state.ecosystemMaterials ||= [];
      if (state.ecosystemMaterials.some(row => row.ecosystemId === ecosystemId && row.materialCode === code)) fail('That material code is already in the catalog', 409);
      const row = { id: nextId(state.ecosystemMaterials), ecosystemId, materialCode: code, description, uom }; state.ecosystemMaterials.push(row); return row;
    }); res.status(201).json({ material: row });
  }));
  app.delete('/api/ecosystem/materials/:id', auth, allow('admin','ecosystem'), asyncRoute(async (req,res) => {
    await store.update(state => { const index = (state.ecosystemMaterials || []).findIndex(row => row.id === Number(req.params.id) && (req.user.role === 'admin' || row.ecosystemId === req.user.supplierId)); if (index < 0) fail('Material not found',404); state.ecosystemMaterials.splice(index,1); }); res.json({ok:true});
  }));
  app.patch('/api/shipments/:id/destination', auth, allow('admin','planner','production'), asyncRoute(async (req,res) => {
    await store.update(state => { const row = state.shipments.find(row => row.id === Number(req.params.id)); if (!row || !canAccessShipment(req.user,row)) fail('Delivery not found',404); if (row.bookingStatus !== 'PENDING_SUPPLIER' || row.confirmedTruckLoads?.length) fail('Choose a receiving destination before confirmation',409); const eco = state.users.find(user => user.role === 'ecosystem' && user.supplierId === Number(req.body.ecosystemId)); if (!eco) fail('Choose an Ecosystem account'); row.originWorkArea ||= row.items.find(item => item.deliverySite)?.deliverySite?.toUpperCase(); row.destinationEcosystemId=eco.supplierId; row.items.forEach(item => {item.deliverySite='ECOSYSTEM';}); }); res.json({ok:true});
  }));
  app.post('/api/ecosystem/transfers', auth, allow('admin','planner','production'), asyncRoute(async (req,res) => {
    const result = await store.update(state => {
      const ecosystemId = Number(req.body.ecosystemId); const area = String(req.body.area || ''); const items = req.body.items;
      if (!['DRESSINGS','SAVOURY'].includes(area) || (['DRESSINGS','SAVOURY'].includes(req.user.workArea) && req.user.workArea !== area)) fail('Choose your receiving work area',403);
      if (!validDay(req.body.date) || !validClock(req.body.time)) fail('Choose a date and time');
      if (!Array.isArray(items) || !items.length || items.length > 100 || new Set(items.map(row=>row.id)).size !== items.length) fail('Select material codes once each');
      const owner = state.users.find(user=>user.role==='ecosystem'&&user.supplierId===ecosystemId); const supplier=state.suppliers.find(row=>row.id===ecosystemId);
      if (!owner || !supplier) fail('Ecosystem account not found');
      if (req.body.requestId && state.shipments.some(row=>row.ecosystemRequestId===req.body.requestId && row.requestedBy===req.user.id)) fail('This request has already been submitted',409);
      let itemId=Math.max(0,...state.shipments.flatMap(row=>row.items.map(item=>item.id)))+1;
      const materialItems=items.map(item=>{const material=(state.ecosystemMaterials||[]).find(row=>row.id===Number(item.id)&&row.ecosystemId===ecosystemId); const quantity=Number(item.quantity); if(!material||!Number.isFinite(quantity)||quantity<=0) fail('Select catalog materials with positive quantities'); return {id:itemId++,materialCode:material.materialCode,materialName:String(material.description||''),quantity,uom:material.uom,deliverySite:area,palletCount:0,poNumber:''};});
      const id=nextId(state.shipments); const delivery={id,supplierId:ecosystemId,supplier:supplier.name,vendorCode:supplier.vendorCode,ecosystemRequestId:String(req.body.requestId||''),requestedBy:req.user.id,shipmentNumber:nextCode('SHP',id,req.body.date),bookingReceipt:nextCode('BKG',id,req.body.date),scheduledDate:req.body.date,scheduledTime:req.body.time,status:'PROPOSED',bookingStatus:'PENDING_SUPPLIER',truckPlate:'',driverName:'',driverPhone:'',confirmedTruckLoads:[],items:materialItems,palletsScanned:0,palletsTotal:0,materialWeightKg:0};
      state.shipments.push(delivery); addNotification(state,owner,{title:'Delivery request from ULI',message:`${area} · ${req.body.date} ${req.body.time} · ${materialItems.map(item=>`${item.materialCode}: ${item.quantity} ${item.uom}`).join('; ')}`,shipment:delivery,requiresAction:true}); addAudit(state,req.user,'ECOSYSTEM_DELIVERY_REQUEST','Catalog materials requested',delivery.shipmentNumber);
      return { shipment: supplierSafeShipment(delivery), recipients: owner.emailVerifiedAt && owner.email ? [owner.email] : [] };
    });
    const notification=await emailNotifications.sendEcosystemRequest({sender:emailSender,recipients:result.recipients,shipment:result.shipment});
    res.status(201).json({shipment:result.shipment,notification});
  }));
}
