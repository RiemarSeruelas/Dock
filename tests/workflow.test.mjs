import assert from "node:assert/strict";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import ExcelJS from "exceljs";

const freePort = () => new Promise((resolve, reject) => {
  const server = createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => { const address = server.address(); server.close(() => resolve(address.port)); });
});

test("SDS import, supplier truck allocation, final approval, and scan journey", async (context) => {
  const testDirectory = await mkdtemp(join(tmpdir(), "dockflow-sds-"));
  const dataFile = join(testDirectory, "trial-data.json");
  await copyFile(new URL("../data/trial-data.json", import.meta.url), dataFile);
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  let serverOutput = "";
  const apiProcess = spawn(process.execPath, ["server/index.js"], {
    cwd: new URL("..", import.meta.url),
    env: { ...process.env, DB_ENABLED: "false", EMAIL_NOTIFICATIONS_ENABLED: "false", API_PORT: String(port), DATA_FILE: dataFile, UPLOAD_DIR: join(testDirectory, "uploads"), JWT_SECRET: "workflow-test-secret", APP_ORIGIN: "http://localhost:3000", TZ: "Asia/Manila" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  apiProcess.stdout.on("data", (chunk) => { serverOutput += chunk; });
  apiProcess.stderr.on("data", (chunk) => { serverOutput += chunk; });
  context.after(async () => { apiProcess.kill("SIGTERM"); await rm(testDirectory, { recursive: true, force: true }); });

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

  const supplier = await login("supplier", "supplier123");
  const admin = await login("admin", "admin123");
  const production = await login("production", "production123");
  const security = await login("security", "security123");
  const warehouse = await login("warehouse", "warehouse123");

  assert.equal((await call("/api/rds", { token: supplier.token, method: "POST", body: {} })).response.status, 410);
  const refreshed = await call("/api/auth/refresh", { method: "POST", headers: { Cookie: admin.refreshCookie } });
  assert.equal(refreshed.response.status, 200);
  assert.notEqual(refreshed.result.accessToken, admin.token);

  const supplierBefore = await call("/api/bootstrap", { token: supplier.token });
  assert.ok(supplierBefore.result.suppliers[0].productPresets.every((preset) => preset.materialCode));
  assert.equal(supplierBefore.result.users.length, 0);
  assert.ok(supplierBefore.result.shipments.every((shipment) => shipment.supplierId === supplier.user.supplierId));
  assert.ok(supplierBefore.result.shipments.every((shipment) => shipment.items.every((item) => !("materialName" in item) && !("poNumber" in item))));

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
  assert.equal(committed.result.notification.status, "DISABLED");

  const duplicatePreview = await uploadPreview(workbook, "same-data-renamed.xlsx");
  const duplicateCommit = await call("/api/imports/excel/commit", { token: admin.token, method: "POST", body: { previewToken: duplicatePreview.result.previewToken } });
  assert.equal(duplicateCommit.response.status, 201);
  assert.equal(duplicateCommit.result.deliveryCount, 0);
  assert.equal(duplicateCommit.result.unchangedProposals, 1);

  sheet.getRow(2).getCell(5).value = 550;
  const changedPreview = await uploadPreview(workbook, "changed-data.xlsx");
  const changedCommit = await call("/api/imports/excel/commit", { token: admin.token, method: "POST", body: { previewToken: changedPreview.result.previewToken } });
  assert.equal(changedCommit.response.status, 201);
  assert.equal(changedCommit.result.updatedProposals, 1);

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
  assert.equal(proposal.deliveryCode, null);
  assert.equal("dppNumber" in proposal, false);
  assert.deepEqual(proposal.items.map((item) => item.materialCode).sort(), ["SDS-1001", "SDS-1002"]);
  assert.equal(proposal.items.find((item) => item.materialCode === "SDS-1001").quantity, 550);
  assert.equal((await call(`/api/shipments/${proposal.id}/qr.svg`, { token: supplier.token })).response.status, 409);

  const incompleteAlternative = await call(`/api/shipments/${proposal.id}/supplier-response`, { token: supplier.token, method: "PATCH", body: { decision: "PROPOSE_ALTERNATIVE", loadConfirmed: true, trucks: [{ truckPlate: "SDS 1001", itemIds: proposal.items.map((item) => item.id) }] } });
  assert.equal(incompleteAlternative.response.status, 400);

  const firstTruckResponse = await call(`/api/shipments/${proposal.id}/supplier-response`, { token: supplier.token, method: "PATCH", body: {
    decision: "PROPOSE_ALTERNATIVE",
    reason: "Two trucks must be loaded on the following shift",
    alternativeDate: "2026-08-29",
    alternativeTime: "13:00",
    alternativeEndTime: "15:00",
    loadConfirmed: true,
    trucks: [{ truckPlate: "SDS 1001", driverName: "Driver One", driverPhone: "09170000001", itemIds: [proposal.items[0].id] }],
  } });
  assert.equal(firstTruckResponse.response.status, 200);
  assert.equal(firstTruckResponse.result.partial, true);
  assert.equal(firstTruckResponse.result.remainingMaterialCount, 1);
  assert.match(firstTruckResponse.result.confirmedLoads[0].deliveryCode, /^DLV-/);

  const partialBootstrap = await call("/api/bootstrap", { token: supplier.token });
  const partialProposal = partialBootstrap.result.shipments.find((shipment) => shipment.id === proposal.id);
  assert.equal(partialProposal.bookingStatus, "PENDING_SUPPLIER");
  assert.equal(partialProposal.items.filter((item) => item.supplierApprovedAt).length, 1);

  const secondTruckResponse = await call(`/api/shipments/${proposal.id}/supplier-response`, { token: supplier.token, method: "PATCH", body: {
    decision: "PROPOSE_ALTERNATIVE",
    reason: "Two trucks must be loaded on the following shift",
    alternativeDate: "2026-08-29",
    alternativeTime: "13:00",
    alternativeEndTime: "15:00",
    loadConfirmed: true,
    trucks: [{ truckPlate: "SDS 1002", driverName: "Driver Two", driverPhone: "09170000002", itemIds: [proposal.items[1].id] }],
  } });
  assert.equal(secondTruckResponse.response.status, 200);
  assert.equal(secondTruckResponse.result.partial, false);
  assert.equal(secondTruckResponse.result.deliveries.length, 2);
  assert.ok(secondTruckResponse.result.deliveries.every((delivery) => /^DLV-/.test(delivery.deliveryCode)));

  const productionQueue = await call("/api/bootstrap", { token: production.token });
  const group = productionQueue.result.shipments.filter((shipment) => shipment.sdsProposalId === proposal.id);
  assert.equal(group.length, 2);
  assert.ok(group.every((shipment) => shipment.bookingStatus === "SUPPLIER_ALTERNATIVE"));
  assert.ok(group.every((shipment) => shipment.supplierResponseReason));
  const final = await call(`/api/shipments/${proposal.id}/final-decision`, { token: production.token, method: "PATCH", body: { decision: "APPROVE" } });
  assert.equal(final.response.status, 200);
  assert.equal(final.result.deliveryCount, 2);

  const approvedBootstrap = await call("/api/bootstrap", { token: supplier.token });
  const approvedGroup = approvedBootstrap.result.shipments.filter((shipment) => shipment.sdsProposalId === proposal.id);
  assert.ok(approvedGroup.every((shipment) => shipment.bookingStatus === "APPROVED" && shipment.scheduledDate === "2026-08-29"));
  const first = approvedGroup[0];
  const qr = await call(`/api/shipments/${first.id}/qr.svg`, { token: supplier.token });
  assert.equal(qr.response.status, 200);
  assert.match(qr.response.headers.get("content-type") || "", /image\/svg\+xml/);
  const pdf = await call(`/api/shipments/${first.id}/booking.pdf`, { token: supplier.token });
  assert.equal(pdf.response.status, 200);
  assert.equal(pdf.result.subarray(0, 4).toString(), "%PDF");
  assert.equal((pdf.result.toString("latin1").match(/\/Type\s*\/Page\b/g) || []).length, 1);

  const scan = (token, stage) => call("/api/shipments/scan-stage", { token, method: "POST", body: { scanValue: first.shipmentNumber, stage } });
  assert.equal((await scan(supplier.token, "TRIP")).result.shipment.status, "IN_TRANSIT");
  assert.equal((await scan(security.token, "GATE")).result.shipment.status, "GATE_IN");
  assert.equal((await scan(warehouse.token, "UNLOADING")).result.shipment.status, "UNLOADING");
  assert.equal((await scan(warehouse.token, "RECEIVED")).result.shipment.status, "RECEIVED");
  assert.equal((await scan(security.token, "GATE")).result.shipment.status, "GATE_OUT");

  const report = await call("/api/reports/export.xlsx?supplierId=1", { token: admin.token });
  assert.equal(report.response.status, 200);
  const reportWorkbook = new ExcelJS.Workbook();
  await reportWorkbook.xlsx.load(report.result);
  assert.equal(reportWorkbook.getWorksheet("Delivery Details").getCell("I7").value, "Delivery code");
  assert.ok(reportWorkbook.getWorksheet("Delivery Details").getColumn("R").values.some((value) => /SDS-/.test(String(value || ""))));

  const missingEmail = await call("/api/users", { token: admin.token, method: "POST", body: { name: "No Email", username: "noemail", password: "password123", role: "supplier", supplierName: "No Email Supplier" } });
  assert.equal(missingEmail.response.status, 400);
  const created = await call("/api/users", { token: admin.token, method: "POST", body: { name: "Fresh Farm", username: "freshfarm", email: "fresh@example.com", password: "freshfarm123", role: "supplier", supplierName: "Fresh Farm Supplier" } });
  assert.equal(created.response.status, 201);
  const presets = await call(`/api/suppliers/${created.result.supplierId}/presets`, { token: admin.token, method: "PATCH", body: { presets: [{ materialCode: "FRESH-001", uom: "KG", defaultAmount: 250 }] } });
  assert.equal(presets.response.status, 200);
  assert.equal(presets.result.presets[0].materialCode, "FRESH-001");
});
