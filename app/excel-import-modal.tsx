"use client";

import { AlertTriangle, Check, FileSpreadsheet, Loader2, Upload, X } from "lucide-react";
import { useState } from "react";

type PreviewRow = {
  sheet: string; sourceRow: number; supplier: string; materialCode: string; materialName: string; quantity: number; uom: string;
  deliveryDate: string | null; deliveryTime: string | null; poNumber: string; status: "ready" | "skipped" | "duplicate"; message: string;
};
type ImportPreview = {
  previewToken: string; fileName: string; detectedSheets: { name: string; role: string; dataRows: number }[]; rows: PreviewRow[];
  summary: { totalRows: number; readyRows: number; skippedRows: number; deliveryGroups: number; poMatchedRows: number; warningRows: number };
  rules: { required: string[]; optional: string[]; excluded: string[] };
};
export type ImportResult = { deliveryCount: number; importedRows: number; skippedRows: number };

export function ExcelImportModal({ token, onClose, onImported }: { token: string; onClose: () => void; onImported: (result: ImportResult) => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [error, setError] = useState("");

  const previewFile = async () => {
    if (!file) return;
    setLoading(true); setError("");
    try {
      const payload = new FormData(); payload.append("file", file);
      const response = await fetch("/api/imports/excel/preview", { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: payload });
      if (!response.ok) throw new Error((await response.json().catch(() => ({}))).message || "Workbook preview failed");
      setPreview(await response.json());
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Workbook preview failed"); } finally { setLoading(false); }
  };
  const commit = async () => {
    if (!preview) return;
    setCommitting(true); setError("");
    try {
      const response = await fetch("/api/imports/excel/commit", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify({ previewToken: preview.previewToken }) });
      if (!response.ok) throw new Error((await response.json().catch(() => ({}))).message || "Workbook import failed");
      const result: ImportResult = await response.json();
      onImported(result);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Workbook import failed"); } finally { setCommitting(false); }
  };

  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><section className="modal modal-wide excel-modal" role="dialog" aria-modal="true" aria-label="Import delivery workbook"><div className="modal-head"><div><h2>Import delivery workbook</h2><p>Preview, validate and automate the RM/PM schedule before anything is saved.</p></div><button className="icon-button" onClick={onClose}><X size={20} /></button></div>
    <div className="excel-body">
      {!preview && <><label className="excel-drop"><span className="excel-file-icon"><FileSpreadsheet size={28} /></span><span><b>{file ? file.name : "Choose an Excel workbook"}</b><small>.xlsx or .xlsm · maximum 10 MB</small></span><input type="file" accept=".xlsx,.xlsm,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={(event) => { setFile(event.target.files?.[0] || null); setError(""); }} /></label><div className="import-rule-grid"><article><b>Required</b><p>Supplier, material code, description, quantity, UOM, date and exact time.</p></article><article><b>Used when available</b><p>Week, site, PO reference/balance, remarks and optional end time.</p></article><article><b>Exact duplicate rule</b><p>A row is skipped only when supplier, date, time, PO, material, quantity and UOM all match an imported row.</p></article></div></>}
      {preview && <><div className="import-summary"><article><span>Delivery groups</span><b>{preview.summary.deliveryGroups}</b></article><article><span>Rows ready</span><b>{preview.summary.readyRows}</b></article><article><span>Skipped / duplicate</span><b>{preview.summary.skippedRows}</b></article><article><span>PO matched</span><b>{preview.summary.poMatchedRows}</b></article></div><div className="sheet-detection">{preview.detectedSheets.map((sheet) => <span key={sheet.name}><b>{sheet.name}</b><small>{sheet.role} · {sheet.dataRows} rows</small></span>)}</div>{preview.summary.warningRows > 0 && <div className="inline-warning"><AlertTriangle size={17} />{preview.summary.warningRows} valid row{preview.summary.warningRows === 1 ? "" : "s"} have no PO match. They can still be imported and reviewed later.</div>}<div className="table-wrap import-preview-table"><table><thead><tr><th>Source</th><th>Supplier</th><th>Material</th><th>Qty</th><th>Date & time</th><th>PO</th><th>Result</th></tr></thead><tbody>{preview.rows.slice(0, 18).map((row) => <tr key={`${row.sheet}-${row.sourceRow}`}><td>{row.sheet} · {row.sourceRow}</td><td><b>{row.supplier || "—"}</b></td><td>{row.materialCode}<small>{row.materialName}</small></td><td>{row.quantity.toLocaleString()} {row.uom}</td><td>{row.deliveryDate || "—"}<small>{row.deliveryTime || "—"}</small></td><td>{row.poNumber || "—"}</td><td><span className={`import-result ${row.status}`}>{row.status === "ready" ? <Check size={13} /> : <AlertTriangle size={13} />}{row.message}</span></td></tr>)}</tbody></table></div>{preview.rows.length > 18 && <p className="import-more">Showing 18 of {preview.rows.length} rows. All rows will follow the same validation rules.</p>}</>}
      {error && <div className="form-error"><AlertTriangle size={16} />{error}</div>}
    </div><div className="modal-actions excel-actions"><button className="button secondary" onClick={onClose}>Cancel</button>{preview ? <button className="button secondary" onClick={() => setPreview(null)}>Choose another file</button> : null}{!preview ? <button className="button primary" disabled={!file || loading} onClick={previewFile}>{loading ? <><Loader2 className="spin" size={17} /> Checking workbook</> : <><Upload size={17} /> Preview import</>}</button> : <button className="button primary" disabled={!preview.summary.readyRows || committing} onClick={commit}>{committing ? <><Loader2 className="spin" size={17} /> Importing</> : <><Check size={17} /> Import {preview.summary.readyRows} rows</>}</button>}</div>
  </section></div>;
}
