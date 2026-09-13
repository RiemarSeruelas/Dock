"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties, MouseEvent as ReactMouseEvent } from "react";
import { apiRequest, authenticatedFetch } from "./api-client";

type CellFormat = {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  fontSize?: number;
  fontFamily?: string;
  color?: string;
  fill?: string;
  align?: "left" | "center" | "right";
  vertical?: "top" | "middle" | "bottom";
  wrap?: boolean;
  indent?: number;
  border?: "none" | "all" | "bottom";
  borderColor?: string;
  borderWidth?: number;
  numberFormat?: "general" | "number" | "currency" | "percent" | "date" | "time";
  decimals?: number;
  thousands?: boolean;
};

type SheetRow = {
  key: string;
  revision: number;
  verified: boolean;
  values: Record<string, string | number>;
  formats?: Record<string, CellFormat>;
  rowHeight?: number | null;
  rowHidden?: boolean;
};

type SheetColumn = [string, string, number, string, string?];
type Snapshot = { rows: SheetRow[]; dirty: string[] };
type CellCoordinate = { row: SheetRow; rowIndex: number; column: SheetColumn; columnIndex: number };

const cellId = (row: string, column: string) => row + "\u001f" + column;
const copyRows = (rows: SheetRow[]) => rows.map((row) => ({
  ...row,
  values: { ...row.values },
  formats: Object.fromEntries(Object.entries(row.formats || {}).map(([key, value]) => [key, { ...value }])),
}));
const color = (value: string | undefined, fallback: string) => /^#[0-9a-f]{6}$/i.test(value || "") ? value! : fallback;
const savedLayout = () => {
  if (typeof window === "undefined") return {} as { hidden?: string[]; widths?: Record<string, number> };
  try { return JSON.parse(localStorage.getItem("dockflow-sap-layout") || "{}"); }
  catch { return {} as { hidden?: string[]; widths?: Record<string, number> }; }
};

function displayValue(value: string | number, format?: CellFormat) {
  const raw = String(value ?? "");
  if (!raw || !format?.numberFormat || format.numberFormat === "general") return raw;
  if (format.numberFormat === "date") {
    const date = new Date(raw);
    return Number.isNaN(date.getTime()) ? raw : new Intl.DateTimeFormat("en-PH", { dateStyle: "medium" }).format(date);
  }
  if (format.numberFormat === "time") {
    const date = new Date(raw.includes("T") ? raw : "1970-01-01T" + raw);
    return Number.isNaN(date.getTime()) ? raw : new Intl.DateTimeFormat("en-PH", { timeStyle: "short" }).format(date);
  }
  const numeric = Number(raw.replaceAll(",", ""));
  if (!Number.isFinite(numeric)) return raw;
  const digits = Math.max(0, Math.min(8, Number(format.decimals ?? (format.numberFormat === "currency" ? 2 : 0))));
  if (format.numberFormat === "currency") return new Intl.NumberFormat("en-PH", { style: "currency", currency: "PHP", minimumFractionDigits: digits, maximumFractionDigits: digits }).format(numeric);
  if (format.numberFormat === "percent") return new Intl.NumberFormat("en-PH", { style: "percent", minimumFractionDigits: digits, maximumFractionDigits: digits }).format(numeric);
  return new Intl.NumberFormat("en-PH", { useGrouping: format.thousands !== false, minimumFractionDigits: digits, maximumFractionDigits: digits }).format(numeric);
}

export function SapPage({ token }: { token: string }) {
  const [rows, setRows] = useState<SheetRow[]>([]);
  const [columns, setColumns] = useState<SheetColumn[]>([]);
  const [editable, setEditable] = useState<string[]>([]);
  const [canFormat, setCanFormat] = useState(false);
  const [dirty, setDirty] = useState<string[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [selectionMode, setSelectionMode] = useState<"cells" | "row" | "column">("cells");
  const [hiddenColumns, setHiddenColumns] = useState<string[]>(() => {
    const saved = savedLayout();
    return Array.isArray(saved.hidden) ? saved.hidden : [];
  });
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>(() => {
    const saved = savedLayout();
    return saved.widths && typeof saved.widths === "object" ? saved.widths : {};
  });
  const [editingCell, setEditingCell] = useState("");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<"asc" | "desc">("desc");
  const [message, setMessage] = useState("");
  const [available, setAvailable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const rowsRef = useRef(rows);
  const dirtyRef = useRef(dirty);
  const offsetRef = useRef(0);
  const loadingRef = useRef(false);
  const queryRef = useRef("");
  const sortRef = useRef<"asc" | "desc">("desc");
  const loadedQueryRef = useRef("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const loadMoreRef = useRef<HTMLDivElement>(null);
  const anchorRef = useRef<{ row: number; column: number } | null>(null);
  const undoRef = useRef<Snapshot[]>([]);
  const redoRef = useRef<Snapshot[]>([]);
  const copiedFormat = useRef<CellFormat | null>(null);

  useEffect(() => { rowsRef.current = rows; }, [rows]);
  useEffect(() => { dirtyRef.current = dirty; }, [dirty]);
  useEffect(() => { queryRef.current = query; }, [query]);
  useEffect(() => { sortRef.current = sort; }, [sort]);
  useEffect(() => {
    if (columns.length) localStorage.setItem("dockflow-sap-layout", JSON.stringify({ hidden: hiddenColumns, widths: columnWidths }));
  }, [hiddenColumns, columnWidths, columns.length]);

  const visibleColumns = columns.filter(([key]) => !hiddenColumns.includes(key));
  const visibleRows = rows;

  const remember = () => {
    undoRef.current = [...undoRef.current.slice(-39), { rows: copyRows(rowsRef.current), dirty: [...dirtyRef.current] }];
    redoRef.current = [];
  };
  const commit = (next: SheetRow[], keys: string[]) => {
    const nextDirty = [...new Set([...dirtyRef.current, ...keys])];
    rowsRef.current = next;
    dirtyRef.current = nextDirty;
    setRows(next);
    setDirty(nextDirty);
  };
  const restore = (snapshot: Snapshot) => {
    const restored = copyRows(snapshot.rows);
    rowsRef.current = restored;
    dirtyRef.current = [...snapshot.dirty];
    setRows(restored);
    setDirty(snapshot.dirty);
    setSelected(new Set());
    setSelectionMode("cells");
  };
  const undo = () => {
    const previous = undoRef.current.pop();
    if (!previous) return;
    redoRef.current.push({ rows: copyRows(rowsRef.current), dirty: [...dirtyRef.current] });
    restore(previous);
  };
  const redo = () => {
    const next = redoRef.current.pop();
    if (!next) return;
    undoRef.current.push({ rows: copyRows(rowsRef.current), dirty: [...dirtyRef.current] });
    restore(next);
  };

  const fetchRows = useCallback(async (more = false, search = "", order = sortRef.current) => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    if (more) setLoadingMore(true);
    const start = more ? offsetRef.current : 0;
    try {
      const path = "/api/sap/rows?offset=" + start + "&limit=50&search=" + encodeURIComponent(search) + "&sort=" + order;
      const result = await apiRequest<{ rows: SheetRow[]; columns: SheetColumn[]; editableColumns: string[]; canFormat: boolean; hasMore: boolean; available: boolean; message?: string }>(token, path, "GET");
      setColumns(result.columns || []);
      setEditable(result.editableColumns || []);
      setCanFormat(Boolean(result.canFormat));
      setAvailable(result.available);
      setMessage(result.message || "");
      if (!result.available) {
        if (!dirtyRef.current.length) { rowsRef.current = []; setRows([]); }
        setHasMore(false);
        return;
      }
      const changedQuery = search !== loadedQueryRef.current;
      setRows((current) => {
        let next: SheetRow[];
        if (more) {
          const known = new Set(current.map((row) => row.key));
          next = [...current, ...result.rows.filter((row) => !known.has(row.key))];
        } else if (changedQuery) {
          const incoming = new Set(result.rows.map((row) => row.key));
          next = [...result.rows.map((row) => dirtyRef.current.includes(row.key) ? current.find((saved) => saved.key === row.key) || row : row), ...current.filter((row) => dirtyRef.current.includes(row.key) && !incoming.has(row.key))];
        } else {
          const incoming = new Set(result.rows.map((row) => row.key));
          next = [
            ...result.rows.map((row) => dirtyRef.current.includes(row.key) ? current.find((saved) => saved.key === row.key) || row : row),
            ...current.filter((row) => !incoming.has(row.key)),
          ];
        }
        rowsRef.current = next;
        return next;
      });
      loadedQueryRef.current = search;
      offsetRef.current = more
        ? start + result.rows.length
        : changedQuery
          ? result.rows.length
          : Math.max(offsetRef.current, result.rows.length);
      setHasMore(result.hasMore);
    } catch (error) {
      setAvailable(false);
      setMessage(error instanceof Error ? error.message : "No data");
      if (!dirtyRef.current.length) { rowsRef.current = []; setRows([]); }
      setHasMore(false);
    } finally {
      loadingRef.current = false;
      if (more) setLoadingMore(false);
    }
  }, [token]);

  useEffect(() => {
    offsetRef.current = 0;
    const timer = setTimeout(() => void fetchRows(false, query, sort), query ? 350 : 0);
    return () => clearTimeout(timer);
  }, [query, sort, fetchRows]);
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void fetchRows(false, queryRef.current);
    }, 10000);
    return () => clearInterval(timer);
  }, [fetchRows]);
  useEffect(() => {
    const sentinel = loadMoreRef.current;
    const root = scrollRef.current;
    if (!sentinel || !root || !hasMore || !available) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) void fetchRows(true, queryRef.current, sortRef.current);
    }, { root, rootMargin: "0px 0px 240px 0px", threshold: 0.01 });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [available, fetchRows, hasMore, rows.length]);

  const selectedCells = (): CellCoordinate[] => {
    const result: CellCoordinate[] = [];
    visibleRows.forEach((row, rowIndex) => visibleColumns.forEach((column, columnIndex) => {
      if (selected.has(cellId(row.key, column[0]))) result.push({ row, rowIndex, column, columnIndex });
    }));
    return result;
  };
  const selectCell = (rowIndex: number, columnIndex: number, event: ReactMouseEvent) => {
    setSelectionMode("cells");
    const id = cellId(visibleRows[rowIndex].key, visibleColumns[columnIndex][0]);
    if (event.shiftKey && anchorRef.current) {
      const next = new Set<string>();
      const minRow = Math.min(rowIndex, anchorRef.current.row);
      const maxRow = Math.max(rowIndex, anchorRef.current.row);
      const minColumn = Math.min(columnIndex, anchorRef.current.column);
      const maxColumn = Math.max(columnIndex, anchorRef.current.column);
      for (let row = minRow; row <= maxRow; row++) for (let column = minColumn; column <= maxColumn; column++) next.add(cellId(visibleRows[row].key, visibleColumns[column][0]));
      setSelected(next);
    } else if (event.ctrlKey || event.metaKey) {
      setSelected((current) => {
        const next = new Set(current);
        if (next.has(id)) next.delete(id); else next.add(id);
        return next;
      });
    } else {
      setSelected(new Set([id]));
    }
    anchorRef.current = { row: rowIndex, column: columnIndex };
  };
  const selectRow = (row: SheetRow) => { setSelectionMode("row"); setSelected(new Set(visibleColumns.map(([key]) => cellId(row.key, key)))); };
  const selectColumn = (column: string) => { setSelectionMode("column"); setSelected(new Set(visibleRows.map((row) => cellId(row.key, column)))); };

  const updateCells = (
    operation: (value: string | number, format: CellFormat, row: SheetRow, column: string) => { value?: string | number; format?: CellFormat } | void,
    formatting = false,
  ) => {
    const chosen = selectedCells();
    if (!chosen.length || (formatting && !canFormat)) return;
    remember();
    const touched = new Set<string>();
    const next = rowsRef.current.map((row) => {
      let changed = false;
      let values = row.values;
      let formats = row.formats || {};
      for (const cell of chosen.filter((item) => item.row.key === row.key)) {
        const key = cell.column[0];
        if (!formatting && !editable.includes(key)) continue;
        const result = operation(values[key] ?? "", formats[key] || {}, row, key);
        if (!result) continue;
        if (result.value !== undefined) { values = { ...values, [key]: result.value }; changed = true; }
        if (result.format !== undefined) { formats = { ...formats, [key]: result.format }; changed = true; }
      }
      if (!changed) return row;
      touched.add(row.key);
      return { ...row, values, formats };
    });
    if (touched.size) commit(next, [...touched]);
  };
  const editValue = (rowKey: string, column: string, value: string) => {
    if (!editable.includes(column)) return;
    commit(rowsRef.current.map((row) => row.key === rowKey ? { ...row, values: { ...row.values, [column]: value } } : row), [rowKey]);
  };
  const applyFormat = (change: Partial<CellFormat>) => updateCells((value, format) => ({ format: { ...format, ...change } }), true);
  const clearContents = () => updateCells(() => ({ value: "" }));

  const selectionText = () => {
    const cells = selectedCells();
    if (!cells.length) return "";
    const rowIndexes = cells.map((cell) => cell.rowIndex);
    const columnIndexes = cells.map((cell) => cell.columnIndex);
    const minRow = Math.min(...rowIndexes), maxRow = Math.max(...rowIndexes);
    const minColumn = Math.min(...columnIndexes), maxColumn = Math.max(...columnIndexes);
    return visibleRows.slice(minRow, maxRow + 1).map((row) =>
      visibleColumns.slice(minColumn, maxColumn + 1).map(([key]) => String(row.values[key] ?? "")).join("\t")
    ).join("\n");
  };
  const copy = async () => {
    try { await navigator.clipboard.writeText(selectionText()); setMessage("Copied selected cells."); }
    catch { setMessage("Clipboard access was blocked by the browser."); }
  };
  const cut = async () => { await copy(); clearContents(); };
  const paste = async () => {
    const origin = selectedCells()[0];
    if (!origin) return;
    try {
      const grid = (await navigator.clipboard.readText()).replace(/\r/g, "").split("\n").map((line) => line.split("\t"));
      remember();
      const touched = new Set<string>();
      const next = rowsRef.current.map((row) => {
        const viewRow = visibleRows.findIndex((item) => item.key === row.key);
        if (viewRow < origin.rowIndex || viewRow >= origin.rowIndex + grid.length) return row;
        let values = row.values;
        grid[viewRow - origin.rowIndex].forEach((value, index) => {
          const column = visibleColumns[origin.columnIndex + index]?.[0];
          if (column && editable.includes(column)) { values = { ...values, [column]: value }; touched.add(row.key); }
        });
        return values === row.values ? row : { ...row, values };
      });
      if (touched.size) commit(next, [...touched]);
    } catch { setMessage("Clipboard access was blocked by the browser."); }
  };
  const copyFormatting = () => {
    const first = selectedCells()[0];
    if (first) { copiedFormat.current = { ...(first.row.formats?.[first.column[0]] || {}) }; setMessage("Cell formatting copied."); }
  };
  const pasteFormatting = () => {
    if (!copiedFormat.current) { setMessage("Copy formatting from a cell first."); return; }
    const format = { ...copiedFormat.current };
    updateCells(() => ({ format }), true);
  };
  const setRowHeight = (height: number) => {
    if (!canFormat || !Number.isFinite(height)) return;
    const nextHeight = Math.max(24, Math.min(120, height));
    const keys = new Set(selectedCells().map((cell) => cell.row.key));
    if (!keys.size) return;
    remember();
    commit(rowsRef.current.map((row) => keys.has(row.key) ? { ...row, rowHeight: nextHeight } : row), [...keys]);
  };

  const save = async () => {
    if (!dirtyRef.current.length) return;
    setBusy(true);
    setMessage("");
    try {
      const changed = rowsRef.current.filter((row) => dirtyRef.current.includes(row.key));
      const result = await apiRequest<{ saved: { key: string; revision: number }[] }>(token, "/api/sap/rows", "PUT", { rows: changed });
      const next = rowsRef.current.map((row) => {
        const saved = result.saved.find((item) => item.key === row.key);
        return saved ? { ...row, revision: saved.revision } : row;
      });
      rowsRef.current = next;
      dirtyRef.current = [];
      setRows(next);
      setDirty([]);
      undoRef.current = [];
      redoRef.current = [];
      setMessage(String(result.saved.length) + " row" + (result.saved.length === 1 ? "" : "s") + " saved to PostgreSQL.");
      await fetchRows(false, queryRef.current);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Save failed");
    } finally {
      setBusy(false);
    }
  };
  const addRow = async () => {
    if (!available || busy) return;
    setBusy(true);
    setMessage("");
    try {
      const result = await apiRequest<{ row: SheetRow }>(token, "/api/sap/rows", "POST", { values: {} });
      rowsRef.current = [result.row, ...rowsRef.current];
      setRows(rowsRef.current);
      setSelected(new Set());
      setMessage("New PostgreSQL row added. Select a cell to enter its values.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to add a row");
    } finally {
      setBusy(false);
    }
  };
  const download = async () => {
    try {
      const response = await authenticatedFetch("/api/sap/export.xlsx", {}, token);
      if (!response.ok) throw new Error("The workbook is unavailable");
      const url = URL.createObjectURL(await response.blob());
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "dockflow-sap-receiving.xlsx";
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Download failed");
    }
  };

  const currentSelection = selectedCells();
  const firstCell = currentSelection[0];
  const selectedRowKeys = selectionMode === "column" ? new Set<string>() : new Set(currentSelection.map(cell => cell.row.key));
  const selectedColumnKeys = selectionMode === "row" ? new Set<string>() : new Set(currentSelection.map(cell => cell.column[0]));
  const firstFormat = firstCell?.row.formats?.[firstCell.column[0]] || {};
  const activeColumn = firstCell?.column[0] || visibleColumns[0]?.[0] || "";
  const cellBorder = (format?: CellFormat): CSSProperties => format?.border && format.border !== "none" ? {
    border: format.border === "bottom" ? undefined : String(format.borderWidth || 1) + "px solid " + color(format.borderColor, "#64748b"),
    borderBottom: String(format.borderWidth || 1) + "px solid " + color(format.borderColor, "#64748b"),
  } : {};
  const cellText = (format?: CellFormat): CSSProperties => ({
    fontWeight: format?.bold ? 700 : 400,
    fontStyle: format?.italic ? "italic" : "normal",
    textDecoration: [format?.underline ? "underline" : "", format?.strike ? "line-through" : ""].filter(Boolean).join(" ") || "none",
    fontSize: format?.fontSize || 11,
    fontFamily: format?.fontFamily || "Calibri, sans-serif",
    color: color(format?.color, "#111111"),
    backgroundColor: color(format?.fill, "transparent"),
    textAlign: format?.align || "left",
    whiteSpace: format?.wrap ? "normal" : "nowrap",
    paddingLeft: 6 + (format?.indent || 0) * 12,
  });

  return <div className="page-stack sap-page">
    {!available && message && <div className="sap-network-alert" role="alert">{message}</div>}
    <div className="hero-row">
      <div><span className="eyebrow">SAP Analysis</span><h1>Unified receiving worksheet</h1></div>
      <div className="sap-actions">
        {editable.includes("item") && <button className="button primary" disabled={busy || !available} onClick={() => void addRow()}>+ Add row</button>}
        <button className="button secondary" disabled={busy} onClick={() => void fetchRows(false, query)}>Refresh</button>
        <button className="button primary" disabled={busy || !dirty.length || !available} onClick={() => void save()}>Save {dirty.length || ""}</button>
        <button className="button secondary" disabled={busy || !available} onClick={() => void download()}>Download Excel</button>
      </div>
    </div>
    <div className="sap-search-row">
      <label className="sap-search-field">Search all PostgreSQL rows<input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="DR, batch, material, supplier…"/></label>
      <div className="sap-search-meta">
        <button type="button" className="button secondary sap-sort-button" onClick={() => setSort((current) => current === "desc" ? "asc" : "desc")}>{sort === "desc" ? "Newest first ↓" : "Oldest first ↑"}</button>
        <details className="sap-column-config sap-column-filter">
          <summary>Columns <span>{visibleColumns.length}/{columns.length}</span></summary>
          <div className="worksheet-options">{columns.map(([key, label]) => <label key={key}><input type="checkbox" checked={!hiddenColumns.includes(key)} onChange={(event) => setHiddenColumns(event.target.checked ? hiddenColumns.filter((item) => item !== key) : [...hiddenColumns, key])}/><button type="button" onClick={() => selectColumn(key)}>{label}</button></label>)}</div>
        </details>
      </div>
    </div>
    <div className="sap-toolbar" aria-label="Worksheet formatting and editing">
      <div className="sap-tool-group">
        <button onClick={undo} title="Undo">↶</button><button onClick={redo} title="Redo">↷</button>
      </div>
      <div className="sap-tool-group">
        <select aria-label="Font family" value={firstFormat.fontFamily || "Calibri"} disabled={!canFormat} onChange={(event) => applyFormat({ fontFamily: event.target.value })}>{["Calibri","Arial","Segoe UI","Georgia","Courier New"].map((font) => <option key={font}>{font}</option>)}</select>
        <input aria-label="Font size" type="number" min="8" max="36" value={firstFormat.fontSize || 11} disabled={!canFormat} onChange={(event) => applyFormat({ fontSize: Number(event.target.value) })}/>
        <button className={firstFormat.bold ? "active" : ""} disabled={!canFormat} onClick={() => applyFormat({ bold: !firstFormat.bold })}><b>B</b></button>
        <button className={firstFormat.italic ? "active" : ""} disabled={!canFormat} onClick={() => applyFormat({ italic: !firstFormat.italic })}><i>I</i></button>
        <button className={firstFormat.underline ? "active" : ""} disabled={!canFormat} onClick={() => applyFormat({ underline: !firstFormat.underline })}><u>U</u></button>
        <button className={firstFormat.strike ? "active" : ""} disabled={!canFormat} onClick={() => applyFormat({ strike: !firstFormat.strike })}><s>S</s></button>
        <label className="sap-color-tool" title="Text color"><span>A</span><input aria-label="Text color" type="color" value={color(firstFormat.color, "#111111")} disabled={!canFormat} onChange={(event) => applyFormat({ color: event.target.value })}/></label>
        <label className="sap-color-tool" title="Fill color"><span>Fill</span><input aria-label="Fill color" type="color" value={color(firstFormat.fill, "#ffffff")} disabled={!canFormat} onChange={(event) => applyFormat({ fill: event.target.value })}/></label>
      </div>
      <div className="sap-tool-group">
        <button disabled={!canFormat} onClick={() => applyFormat({ align: "left" })}>Left</button><button disabled={!canFormat} onClick={() => applyFormat({ align: "center" })}>Center</button><button disabled={!canFormat} onClick={() => applyFormat({ align: "right" })}>Right</button>
        <select aria-label="Vertical alignment" disabled={!canFormat} value={firstFormat.vertical || "middle"} onChange={(event) => applyFormat({ vertical: event.target.value as CellFormat["vertical"] })}><option value="top">Top</option><option value="middle">Middle</option><option value="bottom">Bottom</option></select>
        <button disabled={!canFormat} className={firstFormat.wrap ? "active" : ""} onClick={() => applyFormat({ wrap: !firstFormat.wrap })}>Wrap</button>
        <button disabled={!canFormat} onClick={() => applyFormat({ indent: Math.max(0, (firstFormat.indent || 0) - 1) })}>Outdent</button><button disabled={!canFormat} onClick={() => applyFormat({ indent: Math.min(8, (firstFormat.indent || 0) + 1) })}>Indent</button>
      </div>
      <div className="sap-tool-group">
        <div className="sap-border-controls" aria-label="Cell border controls">
          <span className="sap-border-icon" aria-hidden="true">▦</span>
          <select aria-label="Borders" disabled={!canFormat} value={firstFormat.border || "none"} onChange={(event) => applyFormat({ border: event.target.value as CellFormat["border"] })}><option value="none">None</option><option value="all">All</option><option value="bottom">Bottom</option></select>
          <label className="sap-border-color" title="Border color"><input aria-label="Border color" type="color" value={color(firstFormat.borderColor, "#64748b")} disabled={!canFormat} onChange={(event) => applyFormat({ borderColor: event.target.value })}/></label>
          <select aria-label="Border thickness" disabled={!canFormat} value={firstFormat.borderWidth || 1} onChange={(event) => applyFormat({ borderWidth: Number(event.target.value) })}><option value="1">Thin</option><option value="2">Medium</option><option value="3">Thick</option></select>
        </div>
      </div>
      <div className="sap-tool-group">
        <label className="sap-size-tool">Row height<input key={firstCell?.row.key || "no-row"} type="number" min="24" max="120" defaultValue={firstCell?.row.rowHeight || 34} disabled={!canFormat} onBlur={(event) => setRowHeight(Number(event.target.value))}/><span>px</span></label>
        <label>Column width<input type="range" min="70" max="420" value={columnWidths[activeColumn] || Math.max(70, (columns.find(([key]) => key === activeColumn)?.[2] || 18) * 8)} onChange={(event) => activeColumn && setColumnWidths((current) => ({ ...current, [activeColumn]: Number(event.target.value) }))}/></label>
      </div>
    </div>
    {message && available && <p className="sap-message" role="status">{message}{dirty.length ? " Unsaved edits are kept locally." : ""}</p>}
    <div
      className="sap-scroll"
      ref={scrollRef}
      tabIndex={0}
      aria-keyshortcuts="Control+C Meta+C Control+X Meta+X Control+V Meta+V Control+Shift+C Meta+Shift+C Control+Shift+V Meta+Shift+V"
      onKeyDown={(event) => {
        const command = event.ctrlKey || event.metaKey;
        const key = event.key.toLowerCase();
        const target = event.target;
        const hasTextSelection = target instanceof HTMLInputElement
          && target.selectionStart !== null
          && target.selectionEnd !== null
          && target.selectionStart !== target.selectionEnd;

        if (command && key === "z") {
          event.preventDefault();
          if (event.shiftKey) redo(); else undo();
        } else if (command && key === "c" && event.shiftKey && selected.size && canFormat) {
          event.preventDefault();
          copyFormatting();
        } else if (command && key === "v" && event.shiftKey && selected.size && canFormat) {
          event.preventDefault();
          pasteFormatting();
        } else if (command && key === "c" && selected.size && !hasTextSelection) {
          event.preventDefault();
          void copy();
        } else if (command && key === "x" && selected.size && !hasTextSelection) {
          event.preventDefault();
          void cut();
        } else if (command && key === "v" && selected.size) {
          event.preventDefault();
          void paste();
        } else if (event.key === "Delete" && selected.size) {
          event.preventDefault();
          clearContents();
        }
      }}
    >
      <table className="sap-table sap-workbook">
        <colgroup><col style={{ width: 44 }}/>{visibleColumns.map(([key, , width]) => <col key={key} style={{ width: columnWidths[key] || width * 8 }}/>)}</colgroup>
        <thead><tr><th className="sap-row-number">#</th>{visibleColumns.map(([key, label, , , section]) => <th key={key} className={`sap-section-${section || "sap"} ${selectedColumnKeys.has(key) ? "selected-axis" : ""}`} onClick={() => selectColumn(key)}>{label}<small>{editable.includes(key) ? "Edit" : "View"}</small></th>)}</tr></thead>
        <tbody>{visibleRows.map((row, rowIndex) => <tr key={row.key} className={(dirty.includes(row.key) ? "edited " : "") + (row.rowHidden ? "hidden-record " : "") + (selectedRowKeys.has(row.key) ? "selected-axis-row" : "")} style={{ height: row.rowHeight || 34 }}>
          <th className={`sap-row-number ${selectedRowKeys.has(row.key) ? "selected-axis" : ""}`} onClick={() => selectRow(row)}>{rowIndex + 1}</th>
          {visibleColumns.map((column, columnIndex) => {
            const key = column[0], label = column[1], id = cellId(row.key, key), format = row.formats?.[key];
            const canEdit = available && !busy && editable.includes(key);
            const selectionEdges = selected.has(id) ? [
              rowIndex === 0 || !selected.has(cellId(visibleRows[rowIndex - 1].key, key)) ? "selection-top" : "",
              rowIndex === visibleRows.length - 1 || !selected.has(cellId(visibleRows[rowIndex + 1].key, key)) ? "selection-bottom" : "",
              columnIndex === 0 || !selected.has(cellId(row.key, visibleColumns[columnIndex - 1][0])) ? "selection-left" : "",
              columnIndex === visibleColumns.length - 1 || !selected.has(cellId(row.key, visibleColumns[columnIndex + 1][0])) ? "selection-right" : "",
            ].filter(Boolean).join(" ") : "";
            return <td key={key} style={{ ...cellBorder(format), verticalAlign: format?.vertical === "top" ? "top" : format?.vertical === "bottom" ? "bottom" : "middle" }} className={(selected.has(id) ? `selected ${selectionEdges} ` : "") + (!canEdit ? "readonly " : "") + (key === "batch" ? "sap-batch " : "") + (key === "matdoc" ? "sap-matdoc " : "") + (key === "actualReceived" ? "sap-actual" : "")}>
              <input data-sap-cell={id} aria-label={label + " " + row.key} value={editingCell === id ? String(row.values[key] ?? "") : displayValue(row.values[key] ?? "", format)} readOnly={!canEdit} style={cellText(format)} onMouseDown={(event) => selectCell(rowIndex, columnIndex, event)} onFocus={() => { setEditingCell(id); if (canEdit) remember(); }} onBlur={() => setEditingCell("")} onChange={(event) => editValue(row.key, key, event.target.value)}/>
            </td>;
          })}
        </tr>)}</tbody>
      </table>
      <div className="sap-load-more" ref={loadMoreRef} aria-live="polite">{loadingMore ? "Loading more records…" : hasMore ? `${rows.length} records loaded · scroll for more` : rows.length ? `${rows.length} records loaded` : "No data"}</div>
    </div>
  </div>;
}
