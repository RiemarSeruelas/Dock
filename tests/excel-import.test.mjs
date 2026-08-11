import assert from "node:assert/strict";
import test from "node:test";
import ExcelJS from "exceljs";
import { importHelpers, parseDeliveryWorkbook } from "../server/excel-import.js";

test("detects RM/PM schedules, enriches PO data, and filters non-operational rows", async () => {
  const workbook = new ExcelJS.Workbook();
  const rm = workbook.addWorksheet("RM");
  rm.addRow(["WEEK", "Site", "Supplier", "Code", "Description", "UOM", "Qty for delivery", "Date", "Time", "End Time", "Received", "Remarks"]);
  rm.addRow([30, "Dressings", "Ajinomoto", "65013575", "Aspartame-Powder", "KG", 300, "13-Aug-2026", "7:10 AM", "8:25 AM", "", ""]);
  rm.addRow([30, "Savoury", "Behn Meyer", "65013507", "Mustard Pure", "KG", 1044, "13-Aug-2026", "9:00 AM", "", "", "CANCELLED"]);
  rm.addRow([30, "Dressings", "Granville", "65013333", "Starch-Cornstarch", "bag", 240, "c/o Chris", "9:00 AM", "", "", ""]);
  const pm = workbook.addWorksheet("PM");
  pm.addRow(["SAP UoM", "Item Code", "MATERIAL DESCRIPTION", "Week", "UOM", "QTY", "for PO", "DATE", "Time", "Supplier", "Remarks"]);
  pm.addRow(["PC", "65013743", "P/CAP DELTA 470/700/940 ML LC", 30, "cs", 55, 18480, "14-Aug-2026", "7:15 PM", "Cybermann", ""]);
  const poValidation = workbook.addWorksheet("PO Validation");
  poValidation.addRow(["Week", "Mtype", "Material Code", "Description", "UOM", "Should be PO quantity", "Supplier", "PO reference", "PO quantity", "PO Balance", "Still to be delivered (qty)", "Remarks"]);
  poValidation.addRow([30, "RM", "65013575", "Aspartame-Powder", "KG", 300, "Ajinomoto", "4530986737", 500, 200, 200, "sent"]);
  workbook.addWorksheet("PO download").addRow(["Purch. Organization", "Vendor/supplying plant", "Net price", "Document Date", "Price unit", "Deletion indicator"]);

  const preview = await parseDeliveryWorkbook(Buffer.from(await workbook.xlsx.writeBuffer()), "wk30.xlsx", { now: new Date("2026-08-11T00:00:00Z") });
  assert.equal(preview.summary.totalRows, 4);
  assert.equal(preview.summary.readyRows, 2);
  assert.equal(preview.summary.skippedRows, 2);
  assert.equal(preview.summary.deliveryGroups, 2);
  assert.equal(preview.rows[0].deliveryTime, "07:10");
  assert.equal(preview.rows[0].endTime, "08:25");
  assert.equal(preview.rows[0].poNumber, "4530986737");
  assert.equal(preview.rows[0].poBalance, 200);
  assert.equal(preview.rows[1].message, "Cancelled in workbook");
  assert.equal(preview.rows[2].message, "Missing valid date");
  assert.equal(preview.rows[3].deliveryTime, "19:15");
  assert.match(preview.detectedSheets.find((sheet) => sheet.name === "PO download").role, /not imported/i);
});

test("keeps arbitrary exact times instead of rounding to slots", () => {
  assert.equal(importHelpers.toTime("12:07 AM"), "00:07");
  assert.equal(importHelpers.toTime("11:53 PM"), "23:53");
  assert.equal(importHelpers.shiftForTime("13:59"), "Morning");
  assert.equal(importHelpers.shiftForTime("14:01"), "Afternoon");
});

test("only de-duplicates an exact delivery row and keeps the same data on another date", async () => {
  const workbook = new ExcelJS.Workbook();
  const rm = workbook.addWorksheet("RM");
  rm.addRow(["Supplier", "Material Code", "Description", "UOM", "Quantity", "Delivery Date", "Delivery Time", "PO Number"]);
  rm.addRow(["Same Supplier", "MAT-001", "Same Material", "KG", 500, "13-Aug-2026", "08:15", "450000001"]);
  rm.addRow(["Same Supplier", "MAT-001", "Same Material", "KG", 500, "14-Aug-2026", "08:15", "450000001"]);
  rm.addRow(["Same Supplier", "MAT-001", "Same Material", "KG", 500, "13-Aug-2026", "08:15", "450000001"]);

  const preview = await parseDeliveryWorkbook(Buffer.from(await workbook.xlsx.writeBuffer()), "dates.xlsx", { now: new Date("2026-08-11T00:00:00Z") });
  assert.equal(preview.summary.totalRows, 3);
  assert.equal(preview.summary.readyRows, 2);
  assert.equal(preview.summary.deliveryGroups, 2);
  assert.equal(preview.rows[0].status, "ready");
  assert.equal(preview.rows[1].status, "ready");
  assert.notEqual(preview.rows[0].sourceKey, preview.rows[1].sourceKey);
  assert.equal(preview.rows[2].status, "skipped");
  assert.match(preview.rows[2].message, /exact duplicate/i);
});
