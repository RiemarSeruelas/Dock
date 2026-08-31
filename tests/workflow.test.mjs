import assert from "node:assert/strict";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
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
  await copyFile(new URL("../data/trial-data.json", import.meta.url), dataFile);
  const port = await freePort();
  const etaPort = await freePort();
  const etaServer = createHttpServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url?.startsWith("/search")) response.end(JSON.stringify([{ lat: "14.3000", lon: "120.9000", display_name: "Mock address" }]));
    else response.end(JSON.stringify({ routes: [{ distance: 12300, duration: 2520 }] }));
  });
  await new Promise((resolve) => etaServer.listen(etaPort, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${port}`;
  let serverOutput = "";
  const apiProcess = spawn(process.execPath, ["server/index.js"], {
    cwd: new URL("..", import.meta.url),
    env: { ...process.env, NODE_ENV: "test", DB_ENABLED: "false", API_PORT: String(port), DATA_FILE: dataFile, UPLOAD_DIR: join(testDirectory, "uploads"), JWT_SECRET: "workflow-test-secret", APP_ORIGIN: "http://localhost:3000", TZ: "Asia/Manila", EMAIL_NOTIFICATIONS_ENABLED: "true", SMTP_USER: "dockflow.notifications@gmail.com", SMTP_APP_PASSWORD: "abcdefghijklmnop", GEOCODING_API_URL: `http://127.0.0.1:${etaPort}/search`, ROUTING_API_URL: `http://127.0.0.1:${etaPort}/route/v1/driving` },
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
    return { ...result, refreshCookie: response.headers.get("set-cookie")?.split(";")[0] };
  };

  const lanCors = await fetch(`${baseUrl}/api/auth/login`, { method: "OPTIONS", headers: { Origin: baseUrl, "Access-Control-Request-Method": "POST" } });
  assert.equal(lanCors.status, 204);
  assert.equal(lanCors.headers.get("access-control-allow-origin"), baseUrl);
  const blockedCors = await fetch(`${baseUrl}/api/auth/login`, { method: "OPTIONS", headers: { Origin: "http://evil.example", "Access-Control-Request-Method": "POST" } });
  assert.equal(blockedCors.status, 403);

  const supplier = await login("supplier", "supplier123");
  const admin = await login("admin", "admin123");
  const planner = await login("planner", "planner123");
  const production = await login("production", "production123");
  const driver = await login("driver", "driver123");
  const security = await login("security", "security123");
  const warehouse = await login("warehouse", "warehouse123");

  assert.equal((await call("/api/admin/email-sender", { token: admin.token, method: "PATCH", body: { email: "attacker@example.com", appPassword: "do-not-store-this" } })).response.status, 410);
  const placeholderRecipient = await call(`/api/users/${admin.user.id}/email/send-code`, { token: admin.token, method: "POST", body: {} });
  assert.equal(placeholderRecipient.response.status, 409);
  assert.match(placeholderRecipient.result.message, /trial placeholder/i);
  for (const account of [supplier.user, planner.user, admin.user, production.user, driver.user, security.user, warehouse.user]) {
    const accountEmail = `${account.username}.dockflow.test@gmail.com`;
    assert.equal((await call(`/api/users/${account.id}/email`, { token: admin.token, method: "PATCH", body: { email: accountEmail } })).response.status, 200);
    const sent = await call(`/api/users/${account.id}/email/send-code`, { token: admin.token, method: "POST", body: {} });
    assert.equal(sent.response.status, 200);
    assert.match(sent.result.testCode, /^\d{6}$/);
    assert.equal((await call(`/api/users/${account.id}/email/verify`, { token: admin.token, method: "POST", body: { code: sent.result.testCode } })).response.status, 200);
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
  const driverBootstrap = await call("/api/bootstrap", { token: driver.token });
  assert.ok(driverBootstrap.result.shipments.every((shipment) => shipment.supplierId === driver.user.supplierId));
  assert.equal(driverBootstrap.result.importBatches.length, 0);
  assert.equal((await call("/api/availability", { token: production.token, method: "POST", body: { date: "2026-08-28", startTime: "12:00", endTime: "13:00" } })).response.status, 403);

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("SDS Schedule");
  sheet.addRow(["Supplier", "Material Code", "Description", "UOM", "Quantity", "Delivery Date", "Delivery Time", "End Time"]);
  sheet.addRow(["Trial Ingredients Supplier", "SDS-1001", "Protected ingredient A", "KG", 500, "28-Aug-2026", "09:00", "11:00"]);
  sheet.addRow(["Trial Ingredients Supplier", "SDS-1002", "Protected ingredient B", "KG", 300, "28-Aug-2026", "09:00", "11:00"]);
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
  const proposal = supplierAfterImport.result.shipments.find((shipment) => shipment.items.some((item) => item.materialCode === "SDS-1001"));
  assert.equal(proposal.bookingStatus, "PENDING_SUPPLIER");
  assert.equal(proposal.status, "PROPOSED");
  assert.equal(proposal.deliveryCode, null);
  assert.equal("dppNumber" in proposal, false);
  assert.deepEqual(proposal.items.map((item) => item.materialCode).sort(), ["SDS-1001", "SDS-1002"]);
  assert.equal(proposal.items.find((item) => item.materialCode === "SDS-1001").quantity, 550);
  assert.equal((await call(`/api/shipments/${proposal.id}/qr.svg`, { token: supplier.token })).response.status, 409);

  const incompleteAlternative = await call(`/api/shipments/${proposal.id}/supplier-response`, { token: supplier.token, method: "PATCH", body: { decision: "PROPOSE_ALTERNATIVE", loadConfirmed: true, trucks: [{ truckPlate: "SDS 1001", itemIds: proposal.items.map((item) => item.id) }] } });
  assert.equal(incompleteAlternative.response.status, 400);

  const invalidPhone = await call(`/api/shipments/${proposal.id}/supplier-response`, { token: supplier.token, method: "PATCH", body: { decision: "ACCEPT", loadConfirmed: true, trucks: [{ truckPlate: "SDS 1001", driverName: "Driver One", driverPhone: "09170000001", itemIds: [proposal.items[0].id] }] } });
  assert.equal(invalidPhone.response.status, 400);

  const firstTruckResponse = await call(`/api/shipments/${proposal.id}/supplier-response`, { token: supplier.token, method: "PATCH", body: {
    decision: "ACCEPT",
    loadConfirmed: true,
    trucks: [{ truckPlate: "SDS 1001", driverName: "Driver One", driverPhone: "+639170000001", itemIds: [proposal.items[0].id] }],
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

  const secondTruckResponse = await call(`/api/shipments/${proposal.id}/supplier-response`, { token: supplier.token, method: "PATCH", body: {
    decision: "ACCEPT",
    loadConfirmed: true,
    trucks: [{ truckPlate: "SDS 1002", driverName: "Driver Two", driverPhone: "+639170000002", itemIds: [proposal.items[1].id] }],
  } });
  assert.equal(secondTruckResponse.response.status, 200);
  assert.equal(secondTruckResponse.result.partial, false);
  assert.equal(secondTruckResponse.result.deliveries.length, 2);
  assert.ok(secondTruckResponse.result.deliveries.every((delivery) => /^DLV-/.test(delivery.deliveryCode)));

  const productionQueue = await call("/api/bootstrap", { token: production.token });
  assert.ok(productionQueue.result.shipments.every((shipment) => shipment.items.every((item) => !("materialName" in item))));
  assert.equal(productionQueue.result.materials.length, 0);
  const group = productionQueue.result.shipments.filter((shipment) => shipment.sdsProposalId === proposal.id);
  assert.equal(group.length, 2);
  assert.ok(group.every((shipment) => shipment.bookingStatus === "APPROVED"));
  assert.ok(group.every((shipment) => shipment.status === "BOOKED"));
  assert.ok(group.every((shipment) => shipment.supplierResponse === "ACCEPTED"));
  assert.equal((await call(`/api/shipments/${proposal.id}/final-decision`, { token: production.token, method: "PATCH", body: { decision: "APPROVE" } })).response.status, 404);

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

  const siteRoute = await call("/api/settings/site-address", { token: admin.token, method: "PATCH", body: { siteAddress: "Mock receiving site, Cavite" } });
  assert.equal(siteRoute.response.status, 200);
  const supplierRoute = await call(`/api/suppliers/${supplier.user.supplierId}/route`, { token: admin.token, method: "PATCH", body: { originAddress: "Mock supplier origin, Manila" } });
  assert.equal(supplierRoute.response.status, 200);
  assert.equal(supplierRoute.result.supplier.routeDistanceKm, 12.3);
  assert.equal(supplierRoute.result.supplier.routeDurationMinutes, 42);

  const rejectionWorkbook = new ExcelJS.Workbook();
  const rejectionSheet = rejectionWorkbook.addWorksheet("SDS Schedule");
  rejectionSheet.addRow(["Supplier", "Material Code", "UOM", "Quantity", "Delivery Date", "Delivery Time", "End Time"]);
  rejectionSheet.addRow(["Trial Ingredients Supplier", "SDS-REJECT-1", "KG", 100, "30-Aug-2026", "15:00", "16:00"]);
  rejectionSheet.addRow(["Trial Ingredients Supplier", "SDS-APPROVE-ALT-1", "KG", 120, "30-Aug-2026", "17:00", "18:00"]);
  const rejectionPreview = await uploadPreview(rejectionWorkbook, "supplier-rejection.xlsx");
  const rejectionCommit = await call("/api/imports/excel/commit", { token: admin.token, method: "POST", body: { previewToken: rejectionPreview.result.previewToken } });
  assert.equal(rejectionCommit.response.status, 201);
  const beforeReject = await call("/api/bootstrap", { token: supplier.token });
  const rejectionProposal = beforeReject.result.shipments.find((shipment) => shipment.items.some((item) => item.materialCode === "SDS-REJECT-1"));
  const rejectedResponse = await call(`/api/shipments/${rejectionProposal.id}/supplier-response`, { token: supplier.token, method: "PATCH", body: { decision: "PROPOSE_ALTERNATIVE", reason: "Truck is unavailable", alternativeDate: "2026-08-31", alternativeTime: "10:00", alternativeEndTime: "11:00", loadConfirmed: false, trucks: [] } });
  assert.equal(rejectedResponse.response.status, 200);
  assert.equal(rejectedResponse.result.alternativeProposed, true);
  assert.equal(rejectedResponse.result.notification.status, "SENT");
  const companyReview = await call("/api/bootstrap", { token: production.token });
  assert.equal(companyReview.result.shipments.find((shipment) => shipment.id === rejectionProposal.id).bookingStatus, "PENDING_COMPANY");
  assert.equal(companyReview.result.audit.length, 0);
  assert.ok(companyReview.result.notifications.some((notification) => notification.shipmentId === rejectionProposal.id && notification.type === "WARNING"));
  const companyReject = await call(`/api/shipments/${rejectionProposal.id}/company-decision`, { token: production.token, method: "PATCH", body: { decision: "REJECT", reason: "Receiving capacity is full" } });
  assert.equal(companyReject.response.status, 200);
  assert.equal(companyReject.result.notification.status, "SENT");
  const afterReject = await call("/api/bootstrap", { token: admin.token });
  assert.equal(afterReject.result.shipments.find((shipment) => shipment.id === rejectionProposal.id).bookingStatus, "REJECTED");
  assert.equal(afterReject.result.audit.find((entry) => entry.shipmentNumber === rejectionProposal.shipmentNumber).action, "COMPANY_ALTERNATIVE_REJECTED");
  const supplierAfterCompanyReject = await call("/api/bootstrap", { token: supplier.token });
  assert.ok(supplierAfterCompanyReject.result.notifications.some((notification) => notification.shipmentId === rejectionProposal.id && notification.type === "ERROR"));
  assert.equal((await call(`/api/shipments/${rejectionProposal.id}/qr.svg`, { token: supplier.token })).response.status, 409);

  const approvalProposal = beforeReject.result.shipments.find((shipment) => shipment.items.some((item) => item.materialCode === "SDS-APPROVE-ALT-1"));
  const approvalAlternative = await call(`/api/shipments/${approvalProposal.id}/supplier-response`, { token: supplier.token, method: "PATCH", body: { decision: "PROPOSE_ALTERNATIVE", reason: "A truck is available later", alternativeDate: "2026-09-01", alternativeTime: "08:00", alternativeEndTime: "09:00", loadConfirmed: false, trucks: [] } });
  assert.equal(approvalAlternative.response.status, 200);
  const companyApprove = await call(`/api/shipments/${approvalProposal.id}/company-decision`, { token: planner.token, method: "PATCH", body: { decision: "APPROVE" } });
  assert.equal(companyApprove.response.status, 200);
  assert.equal(companyApprove.result.notification.status, "SENT");
  const supplierAfterCompanyApprove = await call("/api/bootstrap", { token: supplier.token });
  const approvedAlternative = supplierAfterCompanyApprove.result.shipments.find((shipment) => shipment.id === approvalProposal.id);
  assert.equal(approvedAlternative.bookingStatus, "PENDING_SUPPLIER");
  assert.equal(approvedAlternative.scheduledDate, "2026-09-01");
  assert.equal(approvedAlternative.scheduledTime, "08:00");
  assert.ok(supplierAfterCompanyApprove.result.notifications.some((notification) => notification.shipmentId === approvalProposal.id && notification.type === "SUCCESS"));

  const scan = (token, stage) => call("/api/shipments/scan-stage", { token, method: "POST", body: { scanValue: first.shipmentNumber, stage } });
  const tripScan = await scan(supplier.token, "TRIP");
  assert.equal(tripScan.result.shipment.status, "IN_TRANSIT");
  assert.equal(tripScan.result.shipment.estimatedTravelMinutes, 42);
  assert.ok(tripScan.result.shipment.estimatedArrivalAt);
  assert.equal((await scan(security.token, "GATE")).result.shipment.status, "GATE_IN");
  assert.equal((await scan(warehouse.token, "UNLOADING")).result.shipment.status, "UNLOADING");
  assert.equal((await scan(warehouse.token, "RECEIVED")).result.shipment.status, "RECEIVED");
  assert.equal((await scan(security.token, "GATE")).result.shipment.status, "GATE_OUT");

  const report = await call("/api/reports/export.xlsx?supplierId=1", { token: admin.token });
  assert.equal(report.response.status, 200);
  const reportWorkbook = new ExcelJS.Workbook();
  await reportWorkbook.xlsx.load(report.result);
  assert.equal(reportWorkbook.getWorksheet("Deliveries").getCell("I7").value, "Delivery code");
  assert.equal(reportWorkbook.getWorksheet("Material Codes").getCell("G7").value, "Material code");
  assert.ok(reportWorkbook.getWorksheet("Material Codes").getColumn("G").values.some((value) => /SDS-/.test(String(value || ""))));

  const missingEmail = await call("/api/users", { token: admin.token, method: "POST", body: { name: "No Email", username: "noemail", password: "password123", role: "supplier", supplierName: "No Email Supplier" } });
  assert.equal(missingEmail.response.status, 400);
  const created = await call("/api/users", { token: admin.token, method: "POST", body: { name: "Fresh Farm", username: "freshfarm", email: "fresh@example.com", password: "freshfarm123", role: "supplier", supplierName: "Fresh Farm Supplier" } });
  assert.equal(created.response.status, 201);
  const presets = await call(`/api/suppliers/${created.result.supplierId}/presets`, { token: admin.token, method: "PATCH", body: { presets: [{ materialCode: "FRESH-001", uom: "KG", defaultAmount: 250 }] } });
  assert.equal(presets.response.status, 200);
  assert.equal(presets.result.presets[0].materialCode, "FRESH-001");
});
