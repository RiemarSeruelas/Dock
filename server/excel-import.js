import ExcelJS from "exceljs";
import { createHash } from "node:crypto";

const HEADER_ALIASES = {
  week: ["week", "wk"],
  site: ["site", "plant", "receiving site"],
  supplier: ["supplier", "supplier name", "vendor supplying plant", "vendor supplier", "vendor"],
  materialCode: ["material code", "item code", "code", "material"],
  materialName: ["material description", "description", "item description"],
  uom: ["uom", "unit of measure", "sap uom"],
  quantity: ["qty for delivery", "quantity for delivery", "delivery qty", "qty", "quantity"],
  poQuantity: ["for po", "should be po quantity", "po quantity"],
  deliveryDate: ["delivery date", "scheduled date", "date"],
  deliveryTime: ["delivery time", "scheduled time", "start time", "time"],
  endTime: ["delivery end time", "scheduled end time", "end time", "to time"],
  received: ["received", "receipt status"],
  remarks: ["remarks", "remark", "notes", "note"],
  poNumber: ["po reference", "po number", "purchase order", "po"],
  poBalance: ["po balance", "purchase order balance"],
  stillToBeDelivered: ["still to be delivered qty", "still to be delivered quantity", "still to be delivered"],
  materialType: ["mtype", "material type", "item category"],
};

const normalize = (value) => String(value ?? "")
  .replace(/[\n\r]+/g, " ")
  .replace(/[^a-zA-Z0-9]+/g, " ")
  .trim()
  .toLowerCase();

const displayValue = (cell) => {
  const value = cell?.value;
  if (value == null) return "";
  if (value instanceof Date) return value;
  if (typeof value === "object") {
    if ("result" in value && value.result != null) return value.result;
    if ("text" in value && value.text != null) return value.text;
    if (Array.isArray(value.richText)) return value.richText.map((part) => part.text || "").join("");
  }
  return value;
};

const pad = (value) => String(value).padStart(2, "0");

const toDate = (value, now = new Date()) => {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
  }
  if (typeof value === "number" && value > 20000) {
    const parsed = new Date(Date.UTC(1899, 11, 30) + value * 86400000);
    return `${parsed.getUTCFullYear()}-${pad(parsed.getUTCMonth() + 1)}-${pad(parsed.getUTCDate())}`;
  }
  const raw = String(value ?? "").trim();
  if (!raw || /^c\s*\/\s*o\b/i.test(raw)) return null;
  const iso = raw.match(/^(\d{4})[-/]([01]?\d)[-/]([0-3]?\d)$/);
  if (iso) return `${iso[1]}-${pad(iso[2])}-${pad(iso[3])}`;
  const numeric = raw.match(/^([0-3]?\d)[-/]([01]?\d)(?:[-/](\d{2,4}))?$/);
  if (numeric) {
    const year = numeric[3] ? Number(numeric[3].length === 2 ? `20${numeric[3]}` : numeric[3]) : now.getFullYear();
    return `${year}-${pad(numeric[2])}-${pad(numeric[1])}`;
  }
  const textDate = new Date(`${raw}${/\d{4}/.test(raw) ? "" : ` ${now.getFullYear()}`} 12:00:00`);
  if (!Number.isNaN(textDate.getTime())) return `${textDate.getFullYear()}-${pad(textDate.getMonth() + 1)}-${pad(textDate.getDate())}`;
  return null;
};

const toTime = (value) => {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return `${pad(value.getHours())}:${pad(value.getMinutes())}`;
  if (typeof value === "number" && value >= 0 && value < 1) {
    const minutes = Math.round(value * 24 * 60) % (24 * 60);
    return `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
  }
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const match = raw.match(/^(\d{1,2})(?::(\d{1,2}))?\s*(am|pm)?$/i);
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = Number(match[2] || 0);
  if (minute > 59 || hour > 23 || (match[3] && (hour < 1 || hour > 12))) return null;
  if (match[3]?.toLowerCase() === "pm" && hour !== 12) hour += 12;
  if (match[3]?.toLowerCase() === "am" && hour === 12) hour = 0;
  return `${pad(hour)}:${pad(minute)}`;
};

const toNumber = (value) => {
  const number = Number(String(value ?? "").replaceAll(",", "").trim());
  return Number.isFinite(number) ? number : null;
};

const mapHeaders = (worksheet) => {
  let best = { row: 0, score: 0, headers: [] };
  const max = Math.min(20, worksheet.rowCount);
  for (let rowNumber = 1; rowNumber <= max; rowNumber += 1) {
    const row = worksheet.getRow(rowNumber);
    const headers = [];
    row.eachCell({ includeEmpty: false }, (cell, column) => headers.push({ column, raw: String(displayValue(cell) || "").trim(), normalized: normalize(displayValue(cell)) }));
    const score = headers.filter((header) => Object.values(HEADER_ALIASES).some((aliases) => aliases.includes(header.normalized))).length;
    if (score > best.score) best = { row: rowNumber, score, headers };
  }
  const columns = {};
  for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
    for (const alias of aliases) {
      const match = best.headers.find((header) => header.normalized === alias);
      if (match) { columns[field] = match.column; break; }
    }
  }
  return { ...best, columns };
};

const cellAt = (worksheet, rowNumber, columns, field) => columns[field] ? displayValue(worksheet.getRow(rowNumber).getCell(columns[field])) : "";
const shiftForTime = () => "Flexible date";
const hashParts = (parts) => createHash("sha256").update(parts.map((value) => normalize(value)).join("|")).digest("hex");
const legacySourceKeyFor = (row) => hashParts([
  row.site,
  row.supplier,
  row.deliveryDate,
  row.deliveryTime,
  row.poNumber,
  row.materialCode,
  row.quantity,
  row.uom,
]);
const sourceKeyFor = (row) => hashParts([
  "delivery-row-v2",
  row.site,
  row.supplier,
  row.deliveryDate,
  row.deliveryTime,
  row.endTime,
  row.week,
  row.poNumber,
  row.materialCode,
  row.materialName,
  row.materialType,
  row.quantity,
  row.uom,
]);

export async function parseDeliveryWorkbook(buffer, fileName, options = {}) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const now = options.now || new Date();
  const detectedSheets = [];
  const scheduleSheets = [];
  const poLookups = [];

  for (const worksheet of workbook.worksheets) {
    const mapping = mapHeaders(worksheet);
    const fields = Object.keys(mapping.columns);
    const isPoValidation = fields.includes("materialCode") && fields.includes("poNumber") && (fields.includes("poBalance") || fields.includes("stillToBeDelivered"));
    const isPoDownload = /po\s*download/i.test(worksheet.name);
    const scheduleSignals = ["supplier", "materialCode", "materialName", "quantity", "deliveryDate", "deliveryTime"].filter((field) => fields.includes(field)).length;
    const looksLikeSchedule = /(^|\b)(rm|pm|delivery|schedule)(\b|$)/i.test(worksheet.name);
    const isSchedule = !isPoValidation && !isPoDownload && (scheduleSignals >= 2 || (looksLikeSchedule && mapping.score > 0));
    const role = isSchedule ? "Delivery schedule" : isPoValidation ? "PO validation reference" : isPoDownload ? "PO download reference (not imported)" : "Ignored";
    const ignoredColumns = mapping.headers.filter((header) => !Object.values(mapping.columns).includes(header.column)).map((header) => header.raw).filter(Boolean);
    detectedSheets.push({ name: worksheet.name, role, headerRow: mapping.row || null, dataRows: Math.max(0, worksheet.rowCount - mapping.row), ignoredColumns });
    if (isSchedule) scheduleSheets.push({ worksheet, mapping });
    if (isPoValidation) poLookups.push({ worksheet, mapping });
  }

  if (!scheduleSheets.length) throw new Error("No delivery schedule sheet was found. Keep at least two recognizable headers such as Supplier, Material, Quantity, Date, or Time.");

  const poBySupplierMaterial = new Map();
  const poByMaterial = new Map();
  for (const { worksheet, mapping } of poLookups) {
    for (let rowNumber = mapping.row + 1; rowNumber <= worksheet.rowCount; rowNumber += 1) {
      const materialCode = String(cellAt(worksheet, rowNumber, mapping.columns, "materialCode") || "").trim();
      if (!materialCode) continue;
      const supplier = String(cellAt(worksheet, rowNumber, mapping.columns, "supplier") || "").trim();
      const record = {
        poNumber: String(cellAt(worksheet, rowNumber, mapping.columns, "poNumber") || "").trim(),
        poBalance: toNumber(cellAt(worksheet, rowNumber, mapping.columns, "poBalance")),
        stillToBeDelivered: toNumber(cellAt(worksheet, rowNumber, mapping.columns, "stillToBeDelivered")),
        poQuantity: toNumber(cellAt(worksheet, rowNumber, mapping.columns, "poQuantity")),
      };
      poByMaterial.set(normalize(materialCode), record);
      if (supplier) poBySupplierMaterial.set(`${normalize(supplier)}|${normalize(materialCode)}`, record);
    }
  }

  const rows = [];
  const issues = [];
  for (const { worksheet, mapping } of scheduleSheets) {
    for (let rowNumber = mapping.row + 1; rowNumber <= worksheet.rowCount; rowNumber += 1) {
      const rawSupplier = String(cellAt(worksheet, rowNumber, mapping.columns, "supplier") || "").trim();
      const rawMaterialCode = String(cellAt(worksheet, rowNumber, mapping.columns, "materialCode") || "").trim();
      const rawMaterialName = String(cellAt(worksheet, rowNumber, mapping.columns, "materialName") || "").trim();
      const rawQuantity = cellAt(worksheet, rowNumber, mapping.columns, "quantity");
      const rawDate = cellAt(worksheet, rowNumber, mapping.columns, "deliveryDate");
      const rawTime = cellAt(worksheet, rowNumber, mapping.columns, "deliveryTime");
      const remarks = String(cellAt(worksheet, rowNumber, mapping.columns, "remarks") || "").trim();
      const received = String(cellAt(worksheet, rowNumber, mapping.columns, "received") || "").trim();
      const hasAnyData = [rawSupplier, rawMaterialCode, rawMaterialName, rawQuantity, rawDate, rawTime, remarks].some((value) => String(value ?? "").trim());
      if (!hasAnyData) continue;

      const parsedDate = toDate(rawDate, now);
      const parsedTime = toTime(rawTime);
      const endTime = toTime(cellAt(worksheet, rowNumber, mapping.columns, "endTime"));
      const parsedQuantity = toNumber(rawQuantity);
      const rawUom = String(cellAt(worksheet, rowNumber, mapping.columns, "uom") || "").trim().toUpperCase();
      const site = String(cellAt(worksheet, rowNumber, mapping.columns, "site") || "").trim();
      const week = String(cellAt(worksheet, rowNumber, mapping.columns, "week") || "").trim();
      const cancelled = /cancel/i.test(remarks);
      const alreadyReceived = /^(yes|y|received|done|true|1)$/i.test(received) || received instanceof Date;
      const placeholderFields = [];
      if (!rawSupplier) placeholderFields.push("supplier");
      if (!rawMaterialCode) placeholderFields.push("material code");
      if (!rawMaterialName) placeholderFields.push("description");
      if (!(parsedQuantity >= 0)) placeholderFields.push("quantity");
      if (!rawUom) placeholderFields.push("UOM");
      if (!parsedDate) placeholderFields.push("date");
      if (!parsedTime) placeholderFields.push("time");
      const supplier = rawSupplier || "Supplier to assign";
      const materialCode = rawMaterialCode || `UNSPECIFIED-${normalize(worksheet.name).toUpperCase() || "SHEET"}-${rowNumber}`;
      const materialName = rawMaterialName || "Material to review";
      const quantity = parsedQuantity ?? 0;
      const uom = rawUom || "N/A";
      const deliveryDate = parsedDate || options.fallbackDate || toDate(now, now);
      const deliveryTime = parsedTime || "12:00";

      const po = poBySupplierMaterial.get(`${normalize(supplier)}|${normalize(materialCode)}`) || poByMaterial.get(normalize(materialCode)) || {};
      const poNumber = String(cellAt(worksheet, rowNumber, mapping.columns, "poNumber") || po.poNumber || "").trim();
      const row = {
        sheet: worksheet.name,
        sourceRow: rowNumber,
        week,
        site,
        supplier,
        materialCode,
        materialName,
        materialType: String(cellAt(worksheet, rowNumber, mapping.columns, "materialType") || (/^PM$/i.test(worksheet.name) ? "PM" : "RM")).trim(),
        uom,
        quantity: quantity || 0,
        poQuantity: toNumber(cellAt(worksheet, rowNumber, mapping.columns, "poQuantity")) ?? po.poQuantity ?? null,
        deliveryDate,
        deliveryTime,
        endTime,
        shift: deliveryTime ? shiftForTime(deliveryTime) : "",
        poNumber,
        poBalance: po.poBalance ?? null,
        stillToBeDelivered: po.stillToBeDelivered ?? null,
        remarks: [remarks, placeholderFields.length ? `Needs review: ${placeholderFields.join(", ")} supplied with trial placeholders` : ""].filter(Boolean).join(" · "),
        placeholderFields,
        status: "ready",
        message: placeholderFields.length ? `Accepted with placeholders: ${placeholderFields.join(", ")}` : cancelled ? "Accepted; workbook marks this row cancelled" : alreadyReceived ? "Accepted; workbook marks this row received" : poNumber ? "Ready · PO matched" : "Ready · PO can be added later",
      };
      row.sourceKey = hashParts([fileName, worksheet.name, rowNumber, sourceKeyFor(row)]);
      row.legacySourceKey = legacySourceKeyFor(row);
      if (placeholderFields.length || !row.poNumber || cancelled || alreadyReceived) issues.push({ sheet: worksheet.name, row: rowNumber, severity: "warning", message: row.message });
      rows.push(row);
    }
  }

  const readyRows = rows.filter((row) => row.status === "ready");
  const groups = new Set(readyRows.map((row) => `${normalize(row.supplier)}|${row.deliveryDate}|${row.deliveryTime}|${row.endTime || ""}|${normalize(row.site)}`));
  return {
    fileName,
    detectedSheets,
    rows,
    issues,
    summary: {
      totalRows: rows.length,
      readyRows: readyRows.length,
      skippedRows: 0,
      deliveryGroups: groups.size,
      poMatchedRows: readyRows.filter((row) => row.poNumber).length,
      warningRows: readyRows.filter((row) => !row.poNumber || row.placeholderFields.length).length,
    },
    rules: {
      required: [],
      optional: ["Supplier", "Material Code", "Description", "Quantity", "UOM", "Date", "Time", "Week", "Site", "PO reference", "PO balance", "Remarks", "End time"],
      excluded: ["Net price", "Purchasing organization", "Document date", "Price unit", "Deletion indicator", "SAP export metadata"],
    },
  };
}

export const importHelpers = { normalize, toDate, toTime, shiftForTime, sourceKeyFor, legacySourceKeyFor };
