"use client";

import { AlertTriangle, Check, FileSpreadsheet, Loader2, Upload, X } from "lucide-react";
import { useState } from "react";
import { authenticatedFetch } from "./api-client";

type PreviewRow = {
  sheet: string; sourceRow: number; week: string; site: string; supplier: string; materialCode: string; quantity: number; uom: string;
  deliveryDate: string; deliveryTime: string; placeholderFields: string[]; supplierAccountLinked: boolean; status: "ready"; message: string;
};
type ImportPreview = {
  previewToken: string; fileName: string; detectedSheets: { name: string; role: string; dataRows: number }[]; rows: PreviewRow[];
  missingSupplierAccounts: string[];
  conflicts: { key: string; shipmentNumber: string; supplier: string; materialCodes: string[]; currentDate: string; currentTime: string; proposedDate: string; proposedTime: string; changes: string[] }[];
  summary: { totalRows: number; readyRows: number; skippedRows: number; deliveryGroups: number; poMatchedRows: number; warningRows: number; missingSupplierAccounts: number; conflicts: number };
  rules: { required: string[]; optional: string[]; excluded: string[] };
};
export type ImportResult = { deliveryCount: number; importedRows: number; unchangedRows?: number; createdProposals?: number; updatedProposals?: number; unchangedProposals?: number; skippedRows: number; notification?: { status: string; sent: number; failed: number } };

export function ExcelImportModal({ token, onClose, onImported }: { token: string; onClose: () => void; onImported: (result: ImportResult) => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [error, setError] = useState("");
  const [conflictDecisions, setConflictDecisions] = useState<Record<string, "UPDATE" | "KEEP">>({});
  const [conflictsOpen, setConflictsOpen] = useState(false);

  const previewFile = async () => {
    if (!file) return;
    setLoading(true); setError("");
    try {
      const payload = new FormData(); payload.append("file", file);
      const response = await authenticatedFetch("/api/imports/excel/preview", { method: "POST", body: payload }, token);
      if (!response.ok) throw new Error((await response.json().catch(() => ({}))).message || "Workbook preview failed");
      setPreview(await response.json());
      setConflictDecisions({});
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Workbook preview failed"); } finally { setLoading(false); }
  };
  const commit = async () => {
    if (!preview) return;
    setCommitting(true); setError("");
    try {
      const response = await authenticatedFetch("/api/imports/excel/commit", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ previewToken: preview.previewToken, conflictDecisions }) }, token);
      if (!response.ok) throw new Error((await response.json().catch(() => ({}))).message || "Workbook import failed");
      const result: ImportResult = await response.json();
      onImported(result);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Workbook import failed"); } finally { setCommitting(false); }
  };

  return <><div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><section className="modal modal-wide excel-modal" role="dialog" aria-modal="true" aria-label="Import SDS workbook"><div className="modal-head"><div><h2>Import SDS workbook</h2></div><button className="icon-button" onClick={onClose}><X size={20} /></button></div>
    <div className="excel-body">
      {!preview && <label className="excel-drop"><span className="excel-file-icon"><FileSpreadsheet size={28} /></span><span><b>{file ? file.name : "Choose a spreadsheet"}</b><small>Excel, OpenDocument, CSV, or TSV · maximum 25 MB</small></span><input type="file" accept=".xlsx,.xlsm,.xls,.xlsb,.xltx,.xltm,.ods,.csv,.tsv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,text/csv" onChange={(event) => { setFile(event.target.files?.[0] || null); setError(""); }} /></label>}
      {preview && <><div className="import-summary"><article><span>Delivery groups</span><b>{preview.summary.deliveryGroups}</b></article><article><span>Rows ready</span><b>{preview.summary.readyRows}</b></article><article><span>Accounts missing</span><b>{preview.summary.missingSupplierAccounts}</b></article><article><span>Conflicts</span><b>{preview.summary.conflicts || 0}</b></article></div>{preview.missingSupplierAccounts.length > 0 && <div className="inline-warning account-warning"><AlertTriangle size={17} /><span><b>Supplier account required</b>Create and link an account for: {preview.missingSupplierAccounts.join(", ")}. This import cannot continue until then.</span></div>}{preview.conflicts?.length > 0 && <button type="button" className="import-conflict-launch" onClick={() => setConflictsOpen(true)}><AlertTriangle size={20} /><span><b>Conflicting Existing Schedule</b><small>{Object.keys(conflictDecisions).length} of {preview.conflicts.length} reviewed</small></span><strong>Review conflicts</strong></button>}<div className="table-wrap import-preview-table"><table><thead><tr><th>Week</th><th>Site</th><th>Supplier</th><th>Material code</th><th>UOM</th><th>Quantity</th><th>Date</th><th>Time</th><th>Account</th></tr></thead><tbody>{preview.rows.slice(0, 18).map((row) => <tr key={`${row.sheet}-${row.sourceRow}`}><td>{row.week || "—"}</td><td>{row.site || "—"}</td><td><b>{row.supplier}</b></td><td><b>{row.materialCode}</b></td><td>{row.uom}</td><td>{row.quantity.toLocaleString()}</td><td>{row.deliveryDate}</td><td>{row.deliveryTime}</td><td><span className={`import-result ${row.supplierAccountLinked ? "ready" : "review"}`}>{row.supplierAccountLinked ? <Check size={13} /> : <AlertTriangle size={13} />}{row.supplierAccountLinked ? "Linked" : "Missing"}</span></td></tr>)}</tbody></table></div>{preview.rows.length > 18 && <p className="import-more">Showing 18 of {preview.rows.length} rows.</p>}</>}
      {error && <div className="form-error"><AlertTriangle size={16} />{error}</div>}
    </div><div className="modal-actions excel-actions"><button className="button secondary" onClick={onClose}>Cancel</button>{preview ? <button className="button secondary" onClick={() => { setPreview(null); setConflictDecisions({}); }}>Choose another file</button> : null}{!preview ? <button className="button primary" disabled={!file || loading} onClick={previewFile}>{loading ? <><Loader2 className="spin" size={17} /> Checking workbook</> : <><Upload size={17} /> Preview import</>}</button> : <button className="button primary" disabled={!preview.summary.readyRows || preview.missingSupplierAccounts.length > 0 || preview.conflicts.some((conflict) => !conflictDecisions[conflict.key]) || committing} onClick={commit}>{committing ? <><Loader2 className="spin" size={17} /> Comparing</> : <><Check size={17} /> {preview.conflicts.length ? "Apply choices & import" : "Compare & import"}</>}</button>}</div>
  </section></div>{conflictsOpen && preview && <div className="modal-backdrop conflict-review-backdrop"><section className="modal conflict-review-modal" role="dialog" aria-modal="true" aria-label="Conflicting Existing Schedule"><div className="modal-head"><div><h2>Conflicting Existing Schedule</h2><p>Compare each existing proposal with the uploaded schedule.</p></div><button className="icon-button" onClick={() => setConflictsOpen(false)}><X size={20} /></button></div><div className="conflict-review-body">{preview.conflicts.map((conflict) => <article className="import-conflict-card" key={conflict.key}><div><strong>{conflict.supplier}</strong><small>{conflict.shipmentNumber} · {conflict.materialCodes.join(", ")}</small><span><b>Existing schedule</b>{conflict.currentDate} · {conflict.currentTime}</span><span><b>Uploaded schedule</b>{conflict.proposedDate} · {conflict.proposedTime}</span></div><div className="conflict-choice"><button type="button" className={conflictDecisions[conflict.key] === "KEEP" ? "active" : ""} onClick={() => setConflictDecisions((current) => ({ ...current, [conflict.key]: "KEEP" }))}>Keep existing</button><button type="button" className={conflictDecisions[conflict.key] === "UPDATE" ? "active update" : ""} onClick={() => setConflictDecisions((current) => ({ ...current, [conflict.key]: "UPDATE" }))}>Use uploaded schedule</button></div></article>)}</div><div className="modal-actions"><span>{Object.keys(conflictDecisions).length} of {preview.conflicts.length} reviewed</span><button className="button primary" onClick={() => setConflictsOpen(false)}>Save choices</button></div></section></div>}</>;
}
