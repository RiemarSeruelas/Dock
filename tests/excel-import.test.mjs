import assert from "node:assert/strict";
import test from "node:test";
import ExcelJS from "exceljs";
import * as XLSX from "xlsx";
import { importHelpers, parseDeliveryWorkbook } from "../server/excel-import.js";

test("detects RM/PM schedules, enriches PO data, and accepts every nonblank row", async () => {
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

  const preview = await parseDeliveryWorkbook(Buffer.from(await workbook.xlsx.writeBuffer()), "wk30.xlsx", { now: new Date("2026-08-11T00:00:00Z"), fallbackDate: "2026-08-18" });
  assert.equal(preview.summary.totalRows, 4);
  assert.equal(preview.summary.readyRows, 4);
  assert.equal(preview.summary.skippedRows, 0);
  assert.equal(preview.summary.deliveryGroups, 4);
  assert.equal(preview.rows[0].deliveryTime, "07:10");
  assert.equal(preview.rows[0].endTime, "08:25");
  assert.equal(preview.rows[0].poNumber, "4530986737");
  assert.equal(preview.rows[0].poBalance, 200);
  assert.match(preview.rows[1].message, /accepted.*cancelled/i);
  assert.equal(preview.rows[2].deliveryDate, "2026-08-18");
  assert.match(preview.rows[2].message, /placeholders.*date/i);
  assert.equal(preview.rows[3].deliveryTime, "19:15");
  assert.match(preview.detectedSheets.find((sheet) => sheet.name === "PO download").role, /not imported/i);
});

test("keeps arbitrary exact times and does not assign shift labels", () => {
  assert.equal(importHelpers.toTime("12:07 AM"), "00:07");
  assert.equal(importHelpers.toTime("11:53 PM"), "23:53");
  assert.equal(importHelpers.shiftForTime("13:59"), "Flexible date");
  assert.equal(importHelpers.shiftForTime("23:41"), "Flexible date");
});

test("accepts repeated-looking rows, different materials, different dates, and missing values", async () => {
  const workbook = new ExcelJS.Workbook();
  const rm = workbook.addWorksheet("RM");
  rm.addRow(["Supplier", "Material Code", "Description", "UOM", "Quantity", "Delivery Date", "Delivery Time", "PO Number"]);
  rm.addRow(["Same Supplier", "MAT-001", "Same Material", "KG", 500, "13-Aug-2026", "08:15", "450000001"]);
  rm.addRow(["Same Supplier", "MAT-001", "Same Material", "KG", 500, "14-Aug-2026", "08:15", "450000001"]);
  rm.addRow(["Same Supplier", "MAT-001", "Same Material", "KG", 500, "13-Aug-2026", "08:15", "450000001"]);
  rm.addRow(["Same Supplier", "MAT-002", "Another Material", "", "", "", "", ""]);

  const preview = await parseDeliveryWorkbook(Buffer.from(await workbook.xlsx.writeBuffer()), "dates.xlsx", { now: new Date("2026-08-11T00:00:00Z"), fallbackDate: "2026-08-20" });
  assert.equal(preview.summary.totalRows, 4);
  assert.equal(preview.summary.readyRows, 4);
  assert.equal(preview.summary.skippedRows, 0);
  assert.equal(preview.summary.deliveryGroups, 3);
  assert.equal(preview.rows[0].status, "ready");
  assert.equal(preview.rows[1].status, "ready");
  assert.notEqual(preview.rows[0].sourceKey, preview.rows[1].sourceKey);
  assert.equal(preview.rows[2].status, "ready");
  assert.equal(preview.rows[3].deliveryDate, "2026-08-20");
  assert.equal(preview.rows[3].deliveryTime, "12:00");
  assert.equal(preview.rows[3].uom, "N/A");
  assert.match(preview.rows[3].message, /placeholders/i);
});

test("accepts legacy Excel and delimited spreadsheet formats", async () => {
  const sourceRows = [
    ["Supplier", "Material Code", "Description", "UOM", "Quantity", "Delivery Date", "Delivery Time"],
    ["Legacy Supplier", "LEG-001", "Legacy product", "KG", 25, "26-Aug-2026", "13:45"],
  ];
  const legacyWorkbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(legacyWorkbook, XLSX.utils.aoa_to_sheet(sourceRows), "Schedule");
  const legacy = await parseDeliveryWorkbook(XLSX.write(legacyWorkbook, { type: "buffer", bookType: "biff8" }), "legacy.xls", { fallbackDate: "2026-08-26" });
  assert.equal(legacy.summary.readyRows, 1);
  assert.equal(legacy.rows[0].materialCode, "LEG-001");
  assert.equal(legacy.rows[0].deliveryTime, "13:45");

  const csv = Buffer.from("Supplier,Material Code,Description,UOM,Quantity,Delivery Date,Delivery Time\nCSV Supplier,CSV-001,CSV product,PC,12,27-Aug-2026,09:20\n");
  const delimited = await parseDeliveryWorkbook(csv, "schedule.csv", { fallbackDate: "2026-08-27" });
  assert.equal(delimited.summary.readyRows, 1);
  assert.equal(delimited.rows[0].supplier, "CSV Supplier");
});
