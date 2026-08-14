import assert from "node:assert/strict";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

const freePort = () => new Promise((resolve, reject) => {
  const server = createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    server.close(() => resolve(address.port));
  });
});

test("supplier booking, approval, PDF, and QR journey", async (context) => {
  const testDirectory = await mkdtemp(join(tmpdir(), "dockflow-workflow-"));
  const dataFile = join(testDirectory, "trial-data.json");
  await copyFile(new URL("../data/trial-data.json", import.meta.url), dataFile);
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  let serverOutput = "";
  const apiProcess = spawn(process.execPath, ["server/index.js"], {
    cwd: new URL("..", import.meta.url),
    env: { ...process.env, API_PORT: String(port), DATA_FILE: dataFile, UPLOAD_DIR: join(testDirectory, "uploads"), JWT_SECRET: "workflow-test-secret", APP_ORIGIN: "http://localhost:3000", TZ: "Asia/Manila" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  apiProcess.stdout.on("data", (chunk) => { serverOutput += chunk; });
  apiProcess.stderr.on("data", (chunk) => { serverOutput += chunk; });
  context.after(async () => {
    apiProcess.kill("SIGTERM");
    await rm(testDirectory, { recursive: true, force: true });
  });

  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const health = await fetch(`${baseUrl}/api/health`);
      if (health.ok) break;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
    if (attempt === 79) assert.fail(`API did not start:\n${serverOutput}`);
  }

  const call = async (path, { token, method = "GET", body } = {}) => {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const contentType = response.headers.get("content-type") || "";
    const result = contentType.includes("application/json") ? await response.json() : Buffer.from(await response.arrayBuffer());
    return { response, result };
  };
  const login = async (username, password) => {
    const { response, result } = await call("/api/auth/login", { method: "POST", body: { username, password } });
    assert.equal(response.status, 200);
    return result;
  };

  const supplier = await login("supplier", "supplier123");
  const admin = await login("admin", "admin123");
  const security = await login("security", "security123");
  const warehouse = await login("warehouse", "warehouse123");

  const supplierBootstrap = await call("/api/bootstrap", { token: supplier.token });
  assert.equal(supplierBootstrap.result.suppliers.length, 1);
  assert.ok(supplierBootstrap.result.suppliers[0].productPresets.some((preset) => preset.name === "Eggs"));
  assert.ok(supplierBootstrap.result.shipments.every((shipment) => shipment.supplierId === supplier.user.supplierId));
  assert.equal(supplierBootstrap.result.users.length, 0);

  const requestBody = {
    dppNumber: "DPP-WORKFLOW-001",
    scheduledDate: "2026-08-14",
    scheduledTime: "08:30",
    scheduledEndTime: "10:30",
    truckPlate: "UAT 1101",
    driverName: "Workflow Driver",
    driverPhone: "09171234567",
    products: [{ presetId: 1, amount: 425 }, { presetId: 2, amount: 175 }],
  };
  const created = await call("/api/rds", { token: supplier.token, method: "POST", body: requestBody });
  assert.equal(created.response.status, 201);
  const duplicate = await call("/api/rds", { token: supplier.token, method: "POST", body: requestBody });
  assert.equal(duplicate.response.status, 409);

  const adminBootstrap = await call("/api/bootstrap", { token: admin.token });
  const pending = adminBootstrap.result.shipments.find((shipment) => shipment.id === created.result.id);
  assert.equal(pending.bookingStatus, "PENDING_APPROVAL");
  assert.equal(pending.items.length, 2);

  const approved = await call(`/api/shipments/${pending.id}/booking-approval`, { token: admin.token, method: "PATCH", body: { decision: "APPROVE" } });
  assert.equal(approved.response.status, 200);

  const supplierMove = await call(`/api/shipments/${pending.id}/schedule`, { token: supplier.token, method: "PATCH", body: { scheduledDate: "2026-08-14", scheduledTime: "10:15", scheduledEndTime: "12:15" } });
  assert.equal(supplierMove.response.status, 403);
  const moved = await call(`/api/shipments/${pending.id}/schedule`, { token: admin.token, method: "PATCH", body: { scheduledDate: "2026-08-14", scheduledTime: "10:15", scheduledEndTime: "12:15" } });
  assert.equal(moved.response.status, 200);
  assert.equal(moved.result.shipment.scheduledTime, "10:15");
  assert.equal(moved.result.shipment.availabilitySlotId, null);

  const pdf = await call(`/api/shipments/${pending.id}/booking.pdf`, { token: supplier.token });
  assert.equal(pdf.response.status, 200);
  assert.equal(pdf.result.subarray(0, 4).toString(), "%PDF");
  assert.equal((pdf.result.toString("latin1").match(/\/Type\s*\/Page\b/g) || []).length, 1);

  const scan = (token, stage) => call("/api/shipments/scan-stage", { token, method: "POST", body: { scanValue: pending.shipmentNumber, stage } });
  assert.equal((await scan(supplier.token, "TRIP")).result.shipment.status, "IN_TRANSIT");
  assert.equal((await scan(security.token, "GATE")).result.shipment.status, "GATE_IN");
  assert.equal((await scan(warehouse.token, "UNLOADING")).result.shipment.status, "UNLOADING");
  assert.equal((await scan(warehouse.token, "RECEIVED")).result.shipment.status, "RECEIVED");
  const completed = await scan(security.token, "GATE");
  assert.equal(completed.result.shipment.status, "GATE_OUT");
  assert.ok(completed.result.shipment.tripAt);
  assert.ok(completed.result.shipment.gateInAt);
  assert.ok(completed.result.shipment.unloadingAt);
  assert.ok(completed.result.shipment.receivedAt);
  assert.ok(completed.result.shipment.gateOutAt);

  const second = await call("/api/rds", { token: supplier.token, method: "POST", body: { ...requestBody, dppNumber: "DPP-WORKFLOW-002", scheduledTime: "09:00", scheduledEndTime: "11:00", truckPlate: "UAT 1102" } });
  assert.equal(second.response.status, 201);
  const missingReason = await call(`/api/shipments/${second.result.id}/booking-approval`, { token: admin.token, method: "PATCH", body: { decision: "REJECT" } });
  assert.equal(missingReason.response.status, 400);
  const rejected = await call(`/api/shipments/${second.result.id}/booking-approval`, { token: admin.token, method: "PATCH", body: { decision: "REJECT", reason: "Requested receiving crew is unavailable" } });
  assert.equal(rejected.response.status, 200);

  const newAccount = await call("/api/users", { token: admin.token, method: "POST", body: { name: "Fresh Farm User", username: "freshfarm", password: "freshfarm123", role: "supplier", supplierName: "Fresh Farm Supplier" } });
  assert.equal(newAccount.response.status, 201);
  const presetUpdate = await call(`/api/suppliers/${newAccount.result.supplierId}/presets`, { token: admin.token, method: "PATCH", body: { presets: [{ name: "Fresh Eggs", uom: "KG", defaultAmount: 250 }] } });
  assert.equal(presetUpdate.response.status, 200);
  const freshFarm = await login("freshfarm", "freshfarm123");
  const freshBootstrap = await call("/api/bootstrap", { token: freshFarm.token });
  assert.equal(freshBootstrap.result.suppliers.length, 1);
  assert.equal(freshBootstrap.result.suppliers[0].productPresets[0].name, "Fresh Eggs");
  assert.equal(freshBootstrap.result.shipments.length, 0);
});
