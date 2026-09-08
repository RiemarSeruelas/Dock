import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import ExcelJS from "exceljs";
import { buildSdsChangeEmail } from "../server/mailer.js";

test("supplier schedule emails contain only that supplier's detailed changes", () => {
  const message = buildSdsChangeEmail({ supplier: "Trial Ingredients Supplier", changes: [{
    kind: "RESCHEDULE",
    shipmentNumber: "SHP-001",
    before: { date: "2026-08-28", time: "09:00", endTime: "11:00", site: "Dressings", items: [{ materialCode: "SDS-1001", quantity: 500, uom: "KG" }] },
    after: { date: "2026-08-29", time: "10:00", endTime: "12:00", site: "Dressings", items: [{ materialCode: "SDS-1001", quantity: 550, uom: "KG" }] },
  }] });
  assert.match(message.subject, /DockFlow delivery changes/);
  assert.match(message.text, /Dear Supplier/);
  assert.match(message.text, /Before[\s\S]*2026-08-28[\s\S]*After[\s\S]*2026-08-29/);
  assert.match(message.text, /SDS-1001: 550 KG/);
  assert.doesNotMatch(message.text, /SDS summary|Other Supplier|\.csv/i);
});

const freePort = () => new Promise((resolve, reject) => {
  const server = createTcpServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => { const address = server.address(); server.close(() => resolve(address.port)); });
});

test("SDS import, conflict review, supplier confirmation, and scan journey", async (context) => {
  const testDirectory = await mkdtemp(join(tmpdir(), "dockflow-sds-"));
  const dataFile = join(testDirectory, "trial-data.json");
  const port = await freePort();
  const etaPort = await freePort();
  const etaServer = createHttpServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url?.startsWith("/blocked")) { response.statusCode = 403; response.end(JSON.stringify({ message: "Provider blocked" })); }
    else if (request.url?.startsWith("/search")) response.end(JSON.stringify(request.url.includes("Unfindable") ? [] : [{ lat: "14.3000", lon: "120.9000", display_name: "Mock address" }]));
    else response.end(JSON.stringify({ routes: [{ distance: 12300, duration: 2520 }] }));
  });
  await new Promise((resolve) => etaServer.listen(etaPort, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${port}`;
  let serverOutput = "";
  const apiProcess = spawn(process.execPath, ["server/index.js"], {
    cwd: new URL("..", import.meta.url),
    env: { ...process.env, NODE_ENV: "test", SAP_STORAGE: "json", SAP_ALLOWED_CIDRS: "127.0.0.1/32", API_RATE_LIMIT_MAX: "2000", DB_ENABLED: "false", API_PORT: String(port), DATA_FILE: dataFile, UPLOAD_DIR: join(testDirectory, "uploads"), JWT_SECRET: "workflow-test-secret", APP_ORIGIN: "http://localhost:3000", TZ: "Asia/Manila", EMAIL_NOTIFICATIONS_ENABLED: "true", SMTP_USER: "dockflow.notifications@gmail.com", SMTP_APP_PASSWORD: "abcdefghijklmnop", GEOCODING_API_URL: `http://127.0.0.1:${etaPort}/blocked`, GEOCODING_FALLBACK_API_URL: `http://127.0.0.1:${etaPort}/search`, ROUTING_API_URL: `http://127.0.0.1:${etaPort}/route/v1/driving` },
    stdio: ["ignore", "pipe", "pipe"],
  });
  apiProcess.stdout.on("data", (chunk) => { serverOutput += chunk; });
  apiProcess.stderr.on("data", (chunk) => { serverOutput += chunk; });
  context.after(async () => { apiProcess.kill("SIGTERM"); etaServer.close(); await rm(testDirectory, { recursive: true, force: true }); });

  for (let attempt = 0; attempt < 80; attempt += 1) {
    try { if ((await fetch(`${baseUrl}/api/health`)).ok) break; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
    if (attempt === 79) assert.fail(`API did not start:\n${serverOutput}`);
  }

  const call = async (path, { token, method = "GET", body, headers = {} } = {}) => {
    const response = await fetch(`${baseUrl}${path}`, { method, headers: { ...headers, ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const contentType = response.headers.get("content-type") || "";
    const result = contentType.includes("application/json") ? await response.json() : Buffer.from(await response.arrayBuffer());
    return { response, result };
  };
  const login = async (username, password) => {
    const { response, result } = await call("/api/auth/login", { method: "POST", body: { username, password } });
    assert.equal(response.status, 200);
    if(result.user.onboardingRequired && result.user.mustChangePassword) {
      assert.equal((await call('/api/shipments/lookup?code=1',{token:result.token})).response.status,403);
      const email=`${username}.dockflow.test@gmail.com`;
      await call(`/api/users/${result.user.id}/email`,{token:result.token,method:'PATCH',body:{email}});
      const sent=await call(`/api/users/${result.user.id}/email/send-code`,{token:result.token,method:'POST',body:{}});
      assert.equal(sent.response.status,200,JSON.stringify(sent.result));
      const verified=await call(`/api/users/${result.user.id}/email/verify`,{token:result.token,method:'POST',body:{code:sent.result.testCode}});
      assert.equal(verified.response.status,200);
      const changed=await call('/api/auth/change-password',{token:result.token,method:'POST',body:{currentPassword:password,newPassword:password+'Changed!'}});
      assert.equal(changed.response.status,200,JSON.stringify(changed.result));
      return login(username,password+'Changed!');
    }
    return { ...result, refreshCookie: response.headers.get("set-cookie")?.split(";")[0] };
  };

  const lanCors = await fetch(`${baseUrl}/api/auth/login`, { method: "OPTIONS", headers: { Origin: baseUrl, "Access-Control-Request-Method": "POST" } });
  assert.equal(lanCors.status, 204);
  assert.equal(lanCors.headers.get("access-control-allow-origin"), baseUrl);
  const blockedCors = await fetch(`${baseUrl}/api/auth/login`, { method: "OPTIONS", headers: { Origin: "http://evil.example", "Access-Control-Request-Method": "POST" } });
  assert.equal(blockedCors.status, 403);

  const admin = await login("admin", "admin123");
  const createAccount = async (body) => {
    const created = await call("/api/users", { token: admin.token, method: "POST", body: {email:`${body.username}.dockflow.test@gmail.com`,...body} });
    assert.equal(created.response.status, 201);
    return created.result;
  };
  const supplierAccount = await createAccount({ name: "Supplier User", username: "supplier", email: "supplier@dockflow.local", password: "supplier123", role: "supplier", supplierName: "Trial Ingredients Supplier" });
  assert.equal((await call(`/api/suppliers/${supplierAccount.supplierId}/presets`, { token: admin.token, method: "PATCH", body: { presets: [{ materialCode: "65013575", uom: "KG", defaultAmount: 300 }, { materialCode: "65013507", uom: "KG", defaultAmount: 500 }] } })).response.status, 200);
  await createAccount({ name: "Planner Dressings", username: "planner", email: "planner@dockflow.local", password: "planner123", role: "planner", workArea: "DRESSINGS" });
  await createAccount({ name: "Security User", username: "security", email: "security@dockflow.local", password: "security123", role: "security" });
  await createAccount({ name: "Warehouse Dressings", username: "warehouse", email: "warehouse@dockflow.local", password: "warehouse123", role: "warehouse", workArea: "DRESSINGS" });
  const supplier = await login("supplier", "supplier123");
  const planner = await login("planner", "planner123");
  const security = await login("security", "security123");
  const warehouse = await login("warehouse", "warehouse123");

  assert.equal((await call("/api/admin/email-sender", { token: admin.token, method: "PATCH", body: { email: "attacker@example.com", appPassword: "do-not-store-this" } })).response.status, 410);
  assert.ok(admin.user.email !== undefined);
  assert.match(security.user.email, /@/);
  assert.match(warehouse.user.email, /@/);
  for (const [account, accountToken] of [[supplier.user, supplier.token], [planner.user, planner.token]]) {
    const accountEmail = `${account.username}.dockflow.test@gmail.com`;
    assert.equal((await call(`/api/users/${account.id}/email`, { token: accountToken, method: "PATCH", body: { email: accountEmail } })).response.status, 200);
    const sent = await call(`/api/users/${account.id}/email/send-code`, { token: accountToken, method: "POST", body: {} });
    assert.equal(sent.response.status, 200);
    assert.match(sent.result.testCode, /^\d{6}$/);
    assert.equal((await call(`/api/users/${account.id}/email/verify`, { token: accountToken, method: "POST", body: { code: sent.result.testCode } })).response.status, 200);
  }

  assert.equal((await call("/api/rds", { token: supplier.token, method: "POST", body: {} })).response.status, 410);
  const refreshed = await call("/api/auth/refresh", { method: "POST", headers: { Cookie: admin.refreshCookie } });
  assert.equal(refreshed.response.status, 200);
  assert.notEqual(refreshed.result.accessToken, admin.token);

  const supplierBefore = await call("/api/bootstrap", { token: supplier.token });
  assert.ok(supplierBefore.result.suppliers[0].productPresets.every((preset) => preset.materialCode));
  assert.equal(supplierBefore.result.users.length, 0);
  assert.ok(supplierBefore.result.shipments.every((shipment) => shipment.supplierId === supplier.user.supplierId));
  assert.ok(supplierBefore.result.shipments.every((shipment) => shipment.items.every((item) => !("materialName" in item) && !("poNumber" in item))));
  assert.equal(supplierBefore.result.settings.emailNotifications.configured, true);
  assert.equal(supplierBefore.result.settings.emailNotifications.senderEmail, "");
  assert.equal(JSON.stringify(supplierBefore.result).includes("abcdefghijklmnop"), false);
  assert.equal(JSON.stringify(supplierBefore.result.settings).includes("encryptedAppPassword"), false);
  assert.equal(planner.user.workArea, "DRESSINGS");
  assert.equal(warehouse.user.workArea, "DRESSINGS");
  assert.equal((await call("/api/availability", { token: warehouse.token, method: "POST", body: { date: "2026-08-28", startTime: "12:00", endTime: "13:00" } })).response.status, 403);

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("SDS Schedule");
  sheet.addRow(["Supplier", "Material Code", "Description", "UOM", "Quantity", "Delivery Date", "Delivery Time", "End Time", "Site"]);
  sheet.addRow(["Trial Ingredients Supplier", "SDS-1001", "Protected ingredient A", "KG", 500, "28-Aug-2026", "09:00", "11:00", "Dressings"]);
  sheet.addRow(["Trial Ingredients Supplier", "SDS-1002", "Protected ingredient B", "KG", 300, "28-Aug-2026", "09:00", "11:00", "Dressings"]);
  const uploadPreview = async (sourceWorkbook, fileName = "supplier-sds.xlsx") => {
    const form = new FormData();
    form.append("file", new Blob([Buffer.from(await sourceWorkbook.xlsx.writeBuffer())]), fileName);
    const response = await fetch(`${baseUrl}/api/imports/excel/preview`, { method: "POST", headers: { Authorization: `Bearer ${admin.token}` }, body: form });
    return { response, result: await response.json() };
  };
  const { response: previewResponse, result: preview } = await uploadPreview(workbook);
  assert.equal(previewResponse.status, 200);
  assert.equal(preview.summary.readyRows, 2);
  assert.equal(preview.summary.missingSupplierAccounts, 0);
  const committed = await call("/api/imports/excel/commit", { token: admin.token, method: "POST", body: { previewToken: preview.previewToken } });
  assert.equal(committed.response.status, 201);
  assert.equal(committed.result.deliveryCount, 1);
  assert.equal(committed.result.notification.status, "SENT");
  assert.deepEqual(committed.result.notification.supplierNotifications[0].changeTypes, ["NEW"]);
  assert.equal(committed.result.notification.supplierNotifications[0].supplier, "Trial Ingredients Supplier");

  const duplicatePreview = await uploadPreview(workbook, "same-data-renamed.xlsx");
  const duplicateCommit = await call("/api/imports/excel/commit", { token: admin.token, method: "POST", body: { previewToken: duplicatePreview.result.previewToken } });
  assert.equal(duplicateCommit.response.status, 201);
  assert.equal(duplicateCommit.result.deliveryCount, 0);
  assert.equal(duplicateCommit.result.unchangedProposals, 1);

  sheet.getRow(2).getCell(5).value = 550;
  const changedPreview = await uploadPreview(workbook, "changed-data.xlsx");
  assert.equal(changedPreview.result.conflicts.length, 1);
  const unresolvedCommit = await call("/api/imports/excel/commit", { token: admin.token, method: "POST", body: { previewToken: changedPreview.result.previewToken } });
  assert.equal(unresolvedCommit.response.status, 409);
  const changedCommit = await call("/api/imports/excel/commit", { token: admin.token, method: "POST", body: { previewToken: changedPreview.result.previewToken, conflictDecisions: { [changedPreview.result.conflicts[0].key]: "UPDATE" } } });
  assert.equal(changedCommit.response.status, 201);
  assert.equal(changedCommit.result.updatedProposals, 1);
  assert.deepEqual(changedCommit.result.notification.supplierNotifications[0].changeTypes, ["RESCHEDULE"]);

  const missingAccountWorkbook = new ExcelJS.Workbook();
  const missingSheet = missingAccountWorkbook.addWorksheet("SDS Schedule");
  missingSheet.addRow(["Week", "Site", "Supplier", "Code", "UOM", "Qty for delivery", "Date", "Time"]);
  missingSheet.addRow([30, "Dressings", "Supplier Without Account", "NO-ACCOUNT-1", "KG", 10, "28-Aug-2026", "09:00"]);
  const missingPreview = await uploadPreview(missingAccountWorkbook, "missing-account.xlsx");
  assert.deepEqual(missingPreview.result.missingSupplierAccounts, ["Supplier Without Account"]);
  const missingCommit = await call("/api/imports/excel/commit", { token: admin.token, method: "POST", body: { previewToken: missingPreview.result.previewToken } });
  assert.equal(missingCommit.response.status, 409);

  const supplierAfterImport = await call("/api/bootstrap", { token: supplier.token });
  assert.deepEqual(supplierAfterImport.result.settings.availableSlots, []);
  const proposal = supplierAfterImport.result.shipments.find((shipment) => shipment.items.some((item) => item.materialCode === "SDS-1001"));
  assert.equal(proposal.bookingStatus, "PENDING_SUPPLIER");
  assert.equal(proposal.status, "PROPOSED");
  assert.equal(proposal.deliveryCode, null);
  assert.equal("dppNumber" in proposal, false);
  assert.deepEqual(proposal.items.map((item) => item.materialCode).sort(), ["SDS-1001", "SDS-1002"]);
  assert.equal(proposal.items.find((item) => item.materialCode === "SDS-1001").quantity, 550);
  assert.equal((await call(`/api/shipments/${proposal.id}/qr.svg`, { token: supplier.token })).response.status, 409);

  const pendingScheduleNotification = supplierAfterImport.result.notifications.find((notification) => notification.shipmentId === proposal.id && notification.requiresAction && !notification.resolvedAt);
  assert.ok(pendingScheduleNotification, "The supplier must keep an active notification until the imported schedule is resolved");
  assert.equal((await call(`/api/notifications/${pendingScheduleNotification.id}/read`, { token: supplier.token, method: "PATCH" })).response.status, 200);
  const readButUnresolved = await call("/api/bootstrap", { token: supplier.token });
  const readNotification = readButUnresolved.result.notifications.find((notification) => notification.id === pendingScheduleNotification.id);
  assert.ok(readNotification.readAt);
  assert.equal(readNotification.resolvedAt, null, "Opening an actionable notification must not clear its badge");

  const incompleteAlternative = await call(`/api/shipments/${proposal.id}/supplier-response`, { token: supplier.token, method: "PATCH", body: { decision: "PROPOSE_ALTERNATIVE", alternativeDate: "invalid", loadConfirmed: true, trucks: [{ truckPlate: "SDS 1001", itemIds: proposal.items.map((item) => item.id) }] } });
  assert.equal(incompleteAlternative.response.status, 400);

  const invalidPhone = await call(`/api/shipments/${proposal.id}/supplier-response`, { token: supplier.token, method: "PATCH", body: { decision: "ACCEPT", loadConfirmed: true, trucks: [{ truckPlate: "SDS 1001", driverName: "Driver One", driverPhone: "09170000001", itemIds: [proposal.items[0].id] }] } });
  assert.equal(invalidPhone.response.status, 400);

  const firstTruckResponse = await call(`/api/shipments/${proposal.id}/supplier-response`, { token: supplier.token, method: "PATCH", body: {
    decision: "ACCEPT",
    loadConfirmed: true,
    trucks: [{ truckPlate: "SDS 1001", driverName: "Driver One", driverPhone: "+639170000001", poNumber: "PO-100", drNumber: "DR-100", itemIds: [proposal.items[0].id] }],
  } });
  assert.equal(firstTruckResponse.response.status, 200);
  assert.equal(firstTruckResponse.result.partial, true);
  assert.equal(firstTruckResponse.result.remainingMaterialCount, 1);
  assert.match(firstTruckResponse.result.confirmedLoads[0].deliveryCode, /^DLV-/);

  const partialBootstrap = await call("/api/bootstrap", { token: supplier.token });
  const partialProposal = partialBootstrap.result.shipments.find((shipment) => shipment.id === proposal.id);
  assert.equal(partialProposal.bookingStatus, "PENDING_SUPPLIER");
  assert.equal(partialProposal.status, "PROPOSED");
  assert.equal(partialProposal.items.filter((item) => item.supplierApprovedAt).length, 1);
  assert.equal(partialBootstrap.result.notifications.find((notification) => notification.id === pendingScheduleNotification.id).resolvedAt, null);

  const secondTruckResponse = await call(`/api/shipments/${proposal.id}/supplier-response`, { token: supplier.token, method: "PATCH", body: {
    decision: "ACCEPT",
    loadConfirmed: true,
    trucks: [{ truckPlate: "SDS 1002", driverName: "Driver Two", driverPhone: "+639170000002", poNumber: "PO-200", drNumber: "DR-200", itemIds: [proposal.items[1].id] }],
  } });
  assert.equal(secondTruckResponse.response.status, 200);
  assert.equal(secondTruckResponse.result.partial, false);
  assert.equal(secondTruckResponse.result.deliveries.length, 2);
  assert.ok(secondTruckResponse.result.deliveries.every((delivery) => /^DLV-/.test(delivery.deliveryCode)));
  const supplierAfterConfirmation = await call("/api/bootstrap", { token: supplier.token });
  assert.ok(supplierAfterConfirmation.result.notifications.find((notification) => notification.id === pendingScheduleNotification.id).resolvedAt);

  const plannerQueue = await call("/api/bootstrap", { token: planner.token });
  assert.ok(plannerQueue.result.shipments.every((shipment) => shipment.items.every((item) => !("materialName" in item))));
  assert.equal(plannerQueue.result.materials.length, 0);
  const group = plannerQueue.result.shipments.filter((shipment) => shipment.sdsProposalId === proposal.id);
  assert.equal(group.length, 2);
  assert.ok(group.every((shipment) => shipment.bookingStatus === "APPROVED"));
  assert.ok(group.every((shipment) => shipment.status === "BOOKED"));
  assert.ok(group.every((shipment) => shipment.supplierResponse === "ACCEPTED"));
  assert.equal((await call(`/api/shipments/${proposal.id}/final-decision`, { token: planner.token, method: "PATCH", body: { decision: "APPROVE" } })).response.status, 404);

  const approvedBootstrap = await call("/api/bootstrap", { token: supplier.token });
  const approvedGroup = approvedBootstrap.result.shipments.filter((shipment) => shipment.sdsProposalId === proposal.id);
  assert.ok(approvedGroup.every((shipment) => shipment.bookingStatus === "APPROVED" && shipment.scheduledDate === "2026-08-28"));
  const first = approvedGroup[0];
  const qr = await call(`/api/shipments/${first.id}/qr.svg`, { token: supplier.token });
  assert.equal(qr.response.status, 200);
  assert.match(qr.response.headers.get("content-type") || "", /image\/svg\+xml/);
  const pdf = await call(`/api/shipments/${first.id}/booking.pdf`, { token: supplier.token });
  assert.equal(pdf.response.status, 200);
  assert.equal(pdf.result.subarray(0, 4).toString(), "%PDF");
  assert.equal((pdf.result.toString("latin1").match(/\/Type\s*\/Page\b/g) || []).length, 1);

  const siteAccess = await call("/api/settings/site-address/access", { token: admin.token, method: "POST", body: { adminPassword: "admin123" } });
  assert.equal(siteAccess.response.status, 200);
  assert.equal((await call("/api/settings/site-address/access", { token: admin.token, method: "POST", body: { adminPassword: "wrong-password" } })).response.status, 401);
  const siteRoute = await call("/api/settings/site-address", { token: admin.token, method: "PATCH", body: { siteAddress: "Mock receiving site, Cavite", adminPassword: "admin123" } });
  assert.equal(siteRoute.response.status, 200);
  const unresolvedSite = await call("/api/settings/site-address", { token: admin.token, method: "PATCH", body: { siteAddress: "Unfindable private receiving building", adminPassword: "admin123" } });
  assert.equal(unresolvedSite.response.status, 200);
  assert.equal(unresolvedSite.result.geocoded, false);
  assert.equal(unresolvedSite.result.siteAddress, "Unfindable private receiving building");
  const coordinateSite = await call("/api/settings/site-address", { token: admin.token, method: "PATCH", body: { siteAddress: "Exact private Google Maps place", mapReference: "14.3000, 120.9000", adminPassword: "admin123" } });
  assert.equal(coordinateSite.response.status, 200);
  assert.equal(coordinateSite.result.geocoded, true);
  const supplierRoute = await call(`/api/suppliers/${supplier.user.supplierId}/route`, { token: admin.token, method: "PATCH", body: { originAddress: "Mock supplier origin, Manila" } });
  assert.equal(supplierRoute.response.status, 200);
  assert.equal(supplierRoute.result.supplier.routeDistanceKm, 12.3);
  assert.equal(supplierRoute.result.supplier.routeStaticDurationMinutes, 42);
  assert.ok(supplierRoute.result.supplier.routeDurationMinutes > 42);
  assert.equal(supplierRoute.result.supplier.routeTrafficDelayMinutes, supplierRoute.result.supplier.routeDurationMinutes - 42);
  assert.equal(supplierRoute.result.trafficModel, "TIME_OF_DAY");

  const rejectionWorkbook = new ExcelJS.Workbook();
  const rejectionSheet = rejectionWorkbook.addWorksheet("SDS Schedule");
  rejectionSheet.addRow(["Supplier", "Material Code", "UOM", "Quantity", "Delivery Date", "Delivery Time", "End Time", "Site"]);
  rejectionSheet.addRow(["Trial Ingredients Supplier", "SDS-REJECT-1", "KG", 100, "30-Aug-2026", "15:00", "16:00", "Dressings"]);
  rejectionSheet.addRow(["Trial Ingredients Supplier", "SDS-APPROVE-ALT-1", "KG", 120, "30-Aug-2026", "17:00", "18:00", "Dressings"]);
  const rejectionPreview = await uploadPreview(rejectionWorkbook, "supplier-rejection.xlsx");
  const rejectionCommit = await call("/api/imports/excel/commit", { token: admin.token, method: "POST", body: { previewToken: rejectionPreview.result.previewToken } });
  assert.equal(rejectionCommit.response.status, 201);
  const beforeReject = await call("/api/bootstrap", { token: supplier.token });
  const rejectionProposal = beforeReject.result.shipments.find((shipment) => shipment.items.some((item) => item.materialCode === "SDS-REJECT-1"));
  const rejectedResponse = await call(`/api/shipments/${rejectionProposal.id}/supplier-response`, { token: supplier.token, method: "PATCH", body: { decision: "PROPOSE_ALTERNATIVE", reason: "Truck is unavailable", alternativeDate: "2026-08-31", alternativeTime: "10:00", alternativeEndTime: "11:00", loadConfirmed: true, trucks: [{truckPlate:"ALT 123",driverName:"Driver",driverPhone:"09170000001",poNumber:"PO-ALT",drNumber:"DR-ALT",itemIds:rejectionProposal.items.map(item=>item.id)}] } });
  assert.equal(rejectedResponse.response.status, 200);
  assert.equal(rejectedResponse.result.alternativeProposed, true);
  assert.equal(rejectedResponse.result.notification.status, "SENT");
  const companyReview = await call("/api/bootstrap", { token: planner.token });
  assert.equal(companyReview.result.shipments.find((shipment) => shipment.id === rejectionProposal.id).bookingStatus, "PENDING_COMPANY");
  const plannerDecisionNotification = companyReview.result.notifications.find((notification) => notification.shipmentId === rejectionProposal.id && notification.type === "WARNING" && notification.requiresAction);
  assert.ok(plannerDecisionNotification);
  assert.equal(plannerDecisionNotification.resolvedAt, null);
  const companyReject = await call(`/api/shipments/${rejectionProposal.id}/company-decision`, { token: planner.token, method: "PATCH", body: { decision: "REJECT", reason: "Receiving capacity is full" } });
  assert.equal(companyReject.response.status, 200);
  assert.equal(companyReject.result.notification.status, "SENT");
  const afterReject = await call("/api/bootstrap", { token: admin.token });
  assert.equal(afterReject.result.shipments.find((shipment) => shipment.id === rejectionProposal.id).bookingStatus, "REJECTED");
  assert.equal(afterReject.result.audit.find((entry) => entry.shipmentNumber === rejectionProposal.shipmentNumber).action, "COMPANY_ALTERNATIVE_REJECTED");
  const plannerAfterReject = await call("/api/bootstrap", { token: planner.token });
  assert.ok(plannerAfterReject.result.notifications.find((notification) => notification.id === plannerDecisionNotification.id).resolvedAt);
  const supplierAfterCompanyReject = await call("/api/bootstrap", { token: supplier.token });
  assert.ok(supplierAfterCompanyReject.result.notifications.some((notification) => notification.shipmentId === rejectionProposal.id && notification.type === "ERROR"));
  assert.equal((await call(`/api/shipments/${rejectionProposal.id}/qr.svg`, { token: supplier.token })).response.status, 409);

  const approvalProposal = beforeReject.result.shipments.find((shipment) => shipment.items.some((item) => item.materialCode === "SDS-APPROVE-ALT-1"));
  const approvalAlternative = await call(`/api/shipments/${approvalProposal.id}/supplier-response`, { token: supplier.token, method: "PATCH", body: { decision: "PROPOSE_ALTERNATIVE", reason: "A truck is available later", alternativeDate: "2026-09-01", alternativeTime: "08:00", alternativeEndTime: "09:00", loadConfirmed: true, trucks: [{truckPlate:"ALT 123",driverName:"Driver",driverPhone:"09170000001",poNumber:"PO-ALT",drNumber:"DR-ALT",itemIds:approvalProposal.items.map(item=>item.id)}] } });
  assert.equal(approvalAlternative.response.status, 200);
  const companyApprove = await call(`/api/shipments/${approvalProposal.id}/company-decision`, { token: planner.token, method: "PATCH", body: { decision: "APPROVE" } });
  assert.equal(companyApprove.response.status, 200);
  assert.equal(companyApprove.result.notification.status, "SENT");
  const supplierAfterCompanyApprove = await call("/api/bootstrap", { token: supplier.token });
  const approvedSchedule = supplierAfterCompanyApprove.result.shipments.find((shipment) => shipment.id === approvalProposal.id);
  assert.equal(approvedSchedule.bookingStatus, "PENDING_SUPPLIER");
  assert.equal((await call(`/api/shipments/${approvalProposal.id}/qr.svg`,{token:supplier.token})).response.status,409);
  const finalAlternative = await call(`/api/shipments/${approvalProposal.id}/supplier-response`, { token: supplier.token, method: "PATCH", body: { decision: "ACCEPT", loadConfirmed: true, trucks: [{truckPlate:"ALT 1234",driverName:"Driver",driverPhone:"09170000001",poNumber:"PO-ALT",drNumber:"DR-ALT",itemIds:approvedSchedule.items.map(item=>item.id)}] } });
  assert.equal(finalAlternative.response.status, 200, JSON.stringify(finalAlternative.result));
  const approvedAlternative = (await call("/api/bootstrap", { token: supplier.token })).result.shipments.find((shipment) => shipment.id === approvalProposal.id);
  assert.equal(approvedAlternative.bookingStatus, "APPROVED");
  assert.ok(approvedAlternative.deliveryCode);
  assert.equal((await call(`/api/shipments/${approvalProposal.id}/qr.svg`,{token:supplier.token})).response.status,200);
  assert.equal(approvedAlternative.scheduledDate, "2026-09-01");
  assert.equal(approvedAlternative.scheduledTime, "08:00");
  assert.ok(supplierAfterCompanyApprove.result.notifications.some((notification) => notification.shipmentId === approvalProposal.id && notification.type === "SUCCESS"));

  const scan = (token, stage) => call("/api/shipments/scan-stage", { token, method: "POST", body: { scanValue: first.shipmentNumber, stage, ...(stage === "RECEIVED" ? { receipt: { outcome: "FULL", items: first.items.map(item => ({ itemId: item.id, acceptedQuantity: item.quantity })) } } : {}) } });
  const tripScan = await scan(supplier.token, "TRIP");
  assert.equal(tripScan.response.status, 200);
  assert.equal(tripScan.result.shipment.status, "IN_TRANSIT");
  assert.ok(tripScan.result.shipment.estimatedArrivalAt);
  assert.equal((await scan(supplier.token, "GATE")).response.status, 403);
  const gateInScan = await scan(security.token, "GATE");
  assert.equal(gateInScan.result.shipment.status, "GATE_IN");
  assert.equal(gateInScan.result.shipment.estimatedArrivalAt, null);
  assert.equal(gateInScan.result.shipment.estimatedTravelMinutes, null);
  const unloadingScan = await scan(warehouse.token, "UNLOADING");
  assert.equal(unloadingScan.result.shipment.status, "UNLOADING");
  assert.match(unloadingScan.result.shipment.dock, /^Dock [12]$/);
  assert.equal(unloadingScan.result.shipment.scanHistory.at(-1).actor, "Warehouse Dressings");
  const receivedScan = await scan(warehouse.token, "RECEIVED");
  assert.equal(receivedScan.result.shipment.status, "RECEIVED");
  assert.equal(receivedScan.result.notification.status, "SENT");
  assert.equal(receivedScan.result.shipment.dock, unloadingScan.result.shipment.dock);
  const gateOutScan = await scan(security.token, "GATE");
  assert.equal(gateOutScan.result.shipment.status, "GATE_OUT");
  assert.equal(gateOutScan.result.shipment.dock, null);
  assert.deepEqual(gateOutScan.result.shipment.scanHistory.map((record) => record.actor), ["Supplier User", "Security User", "Warehouse Dressings", "Warehouse Dressings", "Security User"]);


  // Inspection and lookup are scoped; repeated receipt scans cannot create duplicates.
  const second = approvedGroup.find(row => row.id !== first.id);
  const secondScan = (stage, receipt) => call('/api/shipments/scan-stage', { token: admin.token, method: 'POST', body: { scanValue: second.shipmentNumber, stage, receipt } });
  assert.equal((await secondScan('RECEIVED')).response.status, 400);
  assert.equal((await secondScan('TRIP')).response.status, 200);
  assert.equal((await secondScan('GATE')).response.status, 200);
  assert.equal((await secondScan('UNLOADING')).response.status, 200);
  const partial = await secondScan('RECEIVED', { outcome: 'NOT_IN_FULL', items: second.items.map(item => ({ itemId: item.id, acceptedQuantity: item.quantity - 10, reason: 'Damaged packaging', date: '2026-09-10', time: '10:00' })) });
  assert.equal(partial.response.status, 200, JSON.stringify(partial.result));
  assert.equal(partial.result.shipment.receipt.inFull, false);
  assert.equal(partial.result.shipment.replacementIds.length, 1);
  assert.equal((await secondScan('RECEIVED')).result.alreadyRecorded, true);
  assert.equal((await secondScan('GATE')).response.status, 200);
  const replacementState = (await call('/api/bootstrap', { token: supplier.token })).result;
  assert.equal(replacementState.shipments.filter(s => s.replacementForId === second.id).length, 1);
  assert.equal((await call(`/api/shipments/${second.id}/status`, { token: admin.token, method: 'PATCH', body: { status: 'RECEIVED' } })).response.status, 410);
  assert.equal((await call(`/api/shipments/lookup?code=${first.deliveryCode}`, { token: supplier.token })).response.status, 200);

  await createAccount({ name: 'SAP Analyst', username: 'saptest', password: 'saptest123', role: 'sap' });
  const sap = await login('saptest', 'saptest123');
  assert.equal((await call('/api/sap/rows', { token: supplier.token })).response.status, 403);
  assert.equal((await call('/api/sap/rows', { token: admin.token })).response.status, 200);
  assert.equal((await call('/api/reports/kpi', { token: sap.token })).response.status, 403);
  assert.equal((await call('/api/bootstrap', { token: sap.token })).result.shipments.length, 0);
  const register = await call('/api/sap/rows', { token: sap.token });
  assert.equal(register.response.status, 200);
  const sapRow = register.result.rows[0];
  sapRow.values.matdoc = '001234567';
  sapRow.formats = { matdoc: { bold: true, fill: '#fff2cc' } };
  assert.equal((await call('/api/sap/rows', { token: sap.token, method: 'PUT', body: { rows: [sapRow] } })).response.status, 200);
  assert.equal((await call('/api/sap/rows', { token: sap.token, method: 'PUT', body: { rows: [sapRow] } })).response.status, 409);
  const plannerAccess = await call('/api/sap/rows', { token: planner.token });
  assert.deepEqual(plannerAccess.result.editableColumns, ['destination']);
  const plannerRow = plannerAccess.result.rows.find(row=>row.key===sapRow.key);
  plannerRow.values.destination='DRESSINGS';plannerRow.values.matdoc='MUST-NOT-SAVE';
  assert.equal((await call('/api/sap/rows',{token:planner.token,method:'PUT',body:{rows:[plannerRow]}})).response.status,200);
  const warehouseRegister = await call('/api/sap/rows', { token: warehouse.token });
  assert.ok(warehouseRegister.result.editableColumns.includes('actualReceived'));
  assert.equal(warehouseRegister.result.canFormat,false);
  const warehouseRow=warehouseRegister.result.rows.find(row=>row.key===sapRow.key);
  assert.equal(warehouseRow.values.matdoc,'001234567');
  warehouseRow.values.actualReceived='777';warehouseRow.values.description='MUST-NOT-SAVE';
  assert.equal((await call('/api/sap/rows',{token:warehouse.token,method:'PUT',body:{rows:[warehouseRow]}})).response.status,200);
  const controlledRow=(await call('/api/sap/rows',{token:sap.token})).result.rows.find(row=>row.key===sapRow.key);
  assert.equal(controlledRow.values.actualReceived,'777');
  assert.notEqual(controlledRow.values.description,'MUST-NOT-SAVE');
  assert.equal(controlledRow.formats.matdoc.bold,true);
  const sapExport = await call('/api/sap/export.xlsx', { token: sap.token });
  assert.equal(sapExport.response.status, 200);
  const sapWorkbook = new ExcelJS.Workbook(); await sapWorkbook.xlsx.load(sapExport.result);
  assert.equal(sapWorkbook.worksheets[0].getCell('N2').value, '001234567');
  assert.equal(sapWorkbook.worksheets[0].getCell('A1').fill.fgColor.argb, 'FF08285F');
  assert.equal(sapWorkbook.worksheets[0].getCell('J2').fill.fgColor.argb, 'FF00C663');
  if (process.env.DOCKFLOW_SAP_ARTIFACT) await writeFile(process.env.DOCKFLOW_SAP_ARTIFACT, sapExport.result);
  const kpi = await call('/api/reports/kpi?month=2026-08', { token: supplier.token });
  assert.equal(kpi.result.evaluated, 2); assert.equal(kpi.result.inFullPercent, 50);

  const ecoAccount = await createAccount({ name: 'Ecosystem Warehouse', username: 'ecotest', password: 'ecotest123', email: 'eco@example.com', role: 'ecosystem' });
  const eco = await login('ecotest', 'ecotest123');
  const inboundId = replacementState.shipments.find(s=>s.replacementForId===second.id).id;
  assert.equal((await call(`/api/shipments/${inboundId}/destination`, { token: admin.token, method: 'PATCH', body: { ecosystemId: ecoAccount.supplierId } })).response.status, 200);
  const ecoInbound = (await call('/api/bootstrap', { token: supplier.token })).result.shipments.find(s => s.id === inboundId);
  assert.equal((await call(`/api/shipments/${inboundId}/supplier-response`, { token: eco.token, method: 'PATCH', body: { decision: 'ACCEPT', loadConfirmed: true, trucks: [{ truckPlate: 'ECO 1001', driverName: 'Test', driverPhone: '+639170000003', poNumber: 'PO-E', drNumber: 'DR-E', itemIds: ecoInbound.items.map(item => item.id) }] } })).response.status, 403);
  assert.equal((await call(`/api/shipments/${inboundId}/supplier-response`, { token: supplier.token, method: 'PATCH', body: { decision: 'ACCEPT', loadConfirmed: true, trucks: [{ truckPlate: 'ECO 1001', driverName: 'Test', driverPhone: '+639170000003', poNumber: 'PO-E', drNumber: 'DR-E', itemIds: ecoInbound.items.map(item => item.id) }] } })).response.status, 200);
  const inbound = (await call('/api/bootstrap', { token: eco.token })).result.shipments.find(s => s.id === inboundId);
  const ecoScan = (token, stage, receipt) => call('/api/shipments/scan-stage', { token, method: 'POST', body: { scanValue: inbound.shipmentNumber, stage, receipt } });
  assert.equal((await ecoScan(supplier.token, 'TRIP')).response.status, 200);
  assert.equal((await ecoScan(security.token, 'GATE')).response.status, 200);
  assert.equal((await ecoScan(eco.token, 'UNLOADING')).response.status, 200);
  assert.equal((await ecoScan(eco.token, 'RECEIVED', { outcome: 'FULL', items: inbound.items.map(item => ({ itemId: item.id, acceptedQuantity: item.quantity })) })).response.status, 200);
  const added=await call('/api/ecosystem/materials',{token:eco.token,method:'POST',body:{materialCode:'ECO-100',uom:'KG'}});
  assert.equal(added.response.status,201);
  const added2=await call('/api/ecosystem/materials',{token:admin.token,method:'POST',body:{ecosystemId:ecoAccount.supplierId,materialCode:'ECO-200',uom:'PC'}});
  assert.equal(added2.response.status,201);
  const transfer={ecosystemId:ecoAccount.supplierId,items:[{id:added.result.material.id,quantity:9999},{id:added2.result.material.id,quantity:20}],date:'2026-09-12',time:'09:00',area:'DRESSINGS',requestId:'request-test-1'};
  const requested=await call('/api/ecosystem/transfers',{token:planner.token,method:'POST',body:transfer});
  assert.equal(requested.response.status,201,JSON.stringify(requested.result));
  assert.equal(requested.result.shipment.items.length,2);
  assert.equal(requested.result.shipment.supplierId,ecoAccount.supplierId);
  assert.equal(requested.result.notification.status,'SENT');
  assert.equal((await call('/api/ecosystem/transfers',{token:planner.token,method:'POST',body:transfer})).response.status,409);
  assert.equal((await call(`/api/shipments/${first.id}/clearance.pdf`,{token:supplier.token})).response.status,403);
  const clearance=await call(`/api/shipments/${first.id}/clearance`,{token:warehouse.token});
  assert.equal(clearance.response.status,200);
  assert.equal(clearance.result.records[0].truckPlate,first.truckPlate);
  const clearancePdf=await call(`/api/shipments/${first.id}/clearance.pdf`,{token:warehouse.token});
  assert.equal(clearancePdf.response.status,200);
  assert.equal(clearancePdf.result.subarray(0,4).toString(),'%PDF');
  const currentEmailPlan=(await call('/api/admin/email-schedule',{token:admin.token})).result;
  const emailPlan=await call('/api/admin/email-schedule',{token:admin.token,method:'PUT',body:{accounts:currentEmailPlan.accounts.map(account=>({id:account.id,enabled:account.id!==eco.user.id,day:7,time:'08:30'}))}});
  assert.equal(emailPlan.response.status,200);
  const savedEmailPlan=(await call('/api/admin/email-schedule',{token:admin.token})).result;
  assert.ok(savedEmailPlan.accounts.every(account=>account.day===7&&account.time==='08:30'));
  assert.equal(savedEmailPlan.accounts.find(account=>account.id===eco.user.id).enabled,false);
  assert.equal((await call('/api/bootstrap', { token: eco.token })).result.shipments.some(s => s.id === first.id), false);

  const report = await call("/api/reports/export.xlsx?supplierId=1", { token: admin.token });
  assert.equal(report.response.status, 200);
  if (process.env.DOCKFLOW_REPORT_ARTIFACT) await writeFile(process.env.DOCKFLOW_REPORT_ARTIFACT, report.result);
  const reportWorkbook = new ExcelJS.Workbook();
  await reportWorkbook.xlsx.load(report.result);
  assert.equal(reportWorkbook.getWorksheet("Deliveries").getCell("I4").value, "Delivery code");
  assert.equal(reportWorkbook.getWorksheet("Material Codes").getCell("G4").value, "Material code");
  assert.ok(reportWorkbook.getWorksheet("Material Codes").getColumn("G").values.some((value) => /SDS-/.test(String(value || ""))));

  const missingEmail = await call("/api/users", { token: admin.token, method: "POST", body: { name: "No Email", username: "noemail", password: "password123", role: "supplier", supplierName: "No Email Supplier" } });
  assert.equal(missingEmail.response.status, 400);
  const created = await call("/api/users", { token: admin.token, method: "POST", body: { name: "Fresh Farm", username: "freshfarm", email: "fresh@example.com", password: "freshfarm123", role: "supplier", supplierName: "Fresh Farm Supplier" } });
  assert.equal(created.response.status, 201);
  const presets = await call(`/api/suppliers/${created.result.supplierId}/presets`, { token: admin.token, method: "PATCH", body: { presets: [{ materialCode: "FRESH-001", uom: "KG", defaultAmount: 250 }] } });
  assert.equal(presets.response.status, 200);
  assert.equal(presets.result.presets[0].materialCode, "FRESH-001");
});
