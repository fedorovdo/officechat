"use client";

import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";

import {
  ApiResponseError,
  cancelDirectoryImport,
  executeDirectoryImport,
  getDirectoryEntry,
  getDirectoryImportReconciliation,
  getDirectoryImportResult,
  getDirectoryImportRows,
  getDirectoryImports,
  getStoredAccessToken,
  reconcileDirectoryImport,
  reanalyzeDirectoryImport,
  updateDirectoryImport,
  updateDirectoryImportMatch,
  updateDirectoryImportRow,
  uploadDirectoryImport,
  validateDirectoryImport,
  type DirectoryImportBatch,
  type DirectoryImportExecutionResult,
  type DirectoryImportKind,
  type DirectoryImportMatchStatus,
  type DirectoryImportParserMode,
  type DirectoryImportRow,
  type DirectoryImportValidation,
  type OfficeChatDirectoryEntry
} from "../lib/api";
import type { Dictionary } from "../lib/i18n";

type Props = {
  dictionary: Dictionary;
  onClose: () => void;
  onImported?: () => void;
};

const importFields = [
  "display_name",
  "department",
  "position",
  "internal_phone",
  "work_phone",
  "mobile_phone",
  "email",
  "room",
  "location",
  "notes"
] as const;
const previewPageSize = 200;

function rowRange(row: DirectoryImportRow) {
  return row.source_row_start === row.source_row_end
    ? String(row.source_row_start)
    : `${row.source_row_start}-${row.source_row_end}`;
}

function editableRowSnapshot(row: DirectoryImportRow | null) {
  if (!row) return "";
  return JSON.stringify({
    detected_kind: row.detected_kind,
    normalized_data: row.normalized_data,
    proposed_action: row.proposed_action,
    is_selected: row.is_selected
  });
}

function hasImportedValue(value: unknown) {
  return value !== null && value !== undefined &&
    (typeof value !== "string" || value.trim().length > 0);
}

type WizardView = "preview" | "reconciliation" | "confirmation" | "result";

export function DirectoryImportWizard({ dictionary, onClose, onImported }: Props) {
  const t = dictionary.directoryImport;
  const [file, setFile] = useState<File | null>(null);
  const [parserMode, setParserMode] = useState<DirectoryImportParserMode>("auto");
  const [batch, setBatch] = useState<DirectoryImportBatch | null>(null);
  const [rows, setRows] = useState<DirectoryImportRow[]>([]);
  const [rowPage, setRowPage] = useState(1);
  const [rowTotal, setRowTotal] = useState(0);
  const [recentBatches, setRecentBatches] = useState<DirectoryImportBatch[]>([]);
  const [warningsOnly, setWarningsOnly] = useState(false);
  const [editingRow, setEditingRow] = useState<DirectoryImportRow | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const [hasManualRowEdits, setHasManualRowEdits] = useState(false);
  const [editorError, setEditorError] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [view, setView] = useState<WizardView>("preview");
  const [validation, setValidation] = useState<DirectoryImportValidation | null>(null);
  const [executionResult, setExecutionResult] = useState<DirectoryImportExecutionResult | null>(null);
  const [executionConfirmed, setExecutionConfirmed] = useState(false);
  const [isExecuting, setIsExecuting] = useState(false);
  const [matchFilter, setMatchFilter] = useState<DirectoryImportMatchStatus | "all">("all");
  const [comparisonEntry, setComparisonEntry] = useState<OfficeChatDirectoryEntry | null>(null);
  const uploadBusyRef = useRef(false);
  const executeBusyRef = useRef(false);
  const loadGenerationRef = useRef(0);
  const mountedRef = useRef(true);
  const editorRef = useRef<HTMLElement | null>(null);
  const editorTriggerRef = useRef<HTMLElement | null>(null);
  const editingRowRef = useRef<DirectoryImportRow | null>(null);
  const rowsRef = useRef<DirectoryImportRow[]>([]);
  const closeEditorRef = useRef<() => void>(() => undefined);
  const comparisonEntryIdRef = useRef<string | null>(null);

  const step = executionResult || view === "result"
    ? 5
    : view === "reconciliation" || view === "confirmation"
      ? 4
      : batch
        ? (rows.length || batch.detected_rows === 0 ? 3 : 2)
        : 1;
  const mappingTargets = useMemo(
    () => [
      ["", t.mapping.skipColumn],
      ...importFields.map((field) => [field, dictionary.directory.fields[fieldLabelKey(field)]])
    ],
    [dictionary.directory.fields, t.mapping.skipColumn]
  );
  editingRowRef.current = editingRow;
  rowsRef.current = rows;

  function warningLabel(row: DirectoryImportRow, index: number) {
    const warning = row.warnings[index];
    return t.warningCodes[warning.code as keyof typeof t.warningCodes] ?? warning.code;
  }

  function openRowEditor(row: DirectoryImportRow, trigger: HTMLElement) {
    editorTriggerRef.current = trigger;
    setEditorError("");
    setEditingRow({ ...row, normalized_data: { ...row.normalized_data } });
    setComparisonEntry(null);
    if (view === "reconciliation" && row.matched_entry_id) {
      void loadComparisonEntry(row.matched_entry_id);
    }
  }

  async function loadComparisonEntry(entryId: string) {
    const token = getStoredAccessToken();
    if (!token) return;
    comparisonEntryIdRef.current = entryId;
    try {
      const entry = await getDirectoryEntry(token, entryId);
      if (comparisonEntryIdRef.current === entry.id) {
        setComparisonEntry(entry);
      }
    } catch {
      setComparisonEntry(null);
    }
  }

  function closeRowEditor() {
    const current = editingRowRef.current;
    const original = current
      ? rowsRef.current.find((row) => row.id === current.id) ?? null
      : null;
    if (
      current &&
      original &&
      editableRowSnapshot(current) !== editableRowSnapshot(original) &&
      !window.confirm(t.discardChangesConfirm)
    ) {
      return;
    }
    setEditorError("");
    setEditingRow(null);
    setComparisonEntry(null);
    comparisonEntryIdRef.current = null;
  }
  closeEditorRef.current = closeRowEditor;

  useEffect(() => {
    mountedRef.current = true;
    const token = getStoredAccessToken();
    if (token) {
      void getDirectoryImports(token, 1, 10)
        .then((result) => {
          if (mountedRef.current) setRecentBatches(result.items);
        })
        .catch(() => {
          if (mountedRef.current) setRecentBatches([]);
        });
    }
    return () => {
      mountedRef.current = false;
      loadGenerationRef.current += 1;
    };
  }, []);

  useEffect(() => {
    if (!isExecuting) return;
    function preventAccidentalExit(event: BeforeUnloadEvent) {
      event.preventDefault();
      event.returnValue = "";
    }
    window.addEventListener("beforeunload", preventAccidentalExit);
    return () => window.removeEventListener("beforeunload", preventAccidentalExit);
  }, [isExecuting]);

  useEffect(() => {
    if (!editingRow) return;
    const editor = editorRef.current;
    if (!editor) return;
    const previousFocus =
      editorTriggerRef.current ??
      (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    const focusableSelector =
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';
    const firstFocusable =
      editor.querySelector<HTMLElement>("[data-editor-initial-focus]") ??
      editor.querySelector<HTMLElement>(focusableSelector);
    firstFocusable?.focus();

    function handleKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        closeEditorRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const items = Array.from(
        editor!.querySelectorAll<HTMLElement>(focusableSelector)
      );
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      previousFocus?.focus();
    };
  }, [editingRow?.id]);

  async function loadRows(
    nextBatch: DirectoryImportBatch,
    onlyWarnings = warningsOnly,
    nextPage = 1
  ) {
    const token = getStoredAccessToken();
    if (!token) return;
    const generation = ++loadGenerationRef.current;
    const result = await getDirectoryImportRows(
      token,
      nextBatch.id,
      onlyWarnings,
      nextPage,
      previewPageSize
    );
    if (!mountedRef.current || generation !== loadGenerationRef.current) return;
    setRows(result.items);
    setRowPage(result.page);
    setRowTotal(result.total);
  }

  async function upload(event: FormEvent) {
    event.preventDefault();
    if (uploadBusyRef.current) return;
    if (!file) {
      setError(t.errors.fileRequired);
      return;
    }
    const extension = file.name.split(".").pop()?.toLowerCase();
    if (!extension || !["xlsx", "csv"].includes(extension)) {
      setError(t.errors.unsupportedFile);
      return;
    }
    const token = getStoredAccessToken();
    if (!token) return;
    uploadBusyRef.current = true;
    setIsBusy(true);
    setError("");
    setMessage("");
    try {
      const uploaded = await uploadDirectoryImport(token, file, parserMode);
      if (!mountedRef.current) return;
      loadGenerationRef.current += 1;
      setBatch(uploaded);
      setRows([]);
      setRowPage(1);
      setRowTotal(0);
      setHasManualRowEdits(false);
      setMessage(t.uploadSuccess);
    } catch (uploadError) {
      setError(
        uploadError instanceof ApiResponseError && uploadError.status === 413
          ? t.errors.fileTooLarge
          : t.errors.upload
      );
    } finally {
      uploadBusyRef.current = false;
      if (mountedRef.current) setIsBusy(false);
    }
  }

  async function saveAnalysisSettings() {
    if (!batch) return;
    if (hasManualRowEdits && !window.confirm(t.reanalyzeConfirm)) return;
    const token = getStoredAccessToken();
    if (!token) return;
    setIsBusy(true);
    setError("");
    try {
      await updateDirectoryImport(token, batch.id, {
        parser_mode: batch.parser_mode,
        selected_sheet: batch.selected_sheet,
        column_mapping: batch.column_mapping
      });
      const analyzed = await reanalyzeDirectoryImport(token, batch.id);
      setBatch(analyzed);
      await loadRows(analyzed, false);
      setWarningsOnly(false);
      setHasManualRowEdits(false);
      setMessage(t.reanalyzeSuccess);
    } catch {
      setError(t.errors.reanalyze);
    } finally {
      setIsBusy(false);
    }
  }

  async function openPreview() {
    if (!batch) return;
    setIsBusy(true);
    setError("");
    try {
      await loadRows(batch, false);
      setWarningsOnly(false);
    } catch {
      setError(t.errors.rows);
    } finally {
      setIsBusy(false);
    }
  }

  async function toggleWarnings(value: boolean) {
    if (!batch) return;
    setWarningsOnly(value);
    setIsBusy(true);
    try {
      await loadRows(batch, value);
    } catch {
      setError(t.errors.rows);
    } finally {
      setIsBusy(false);
    }
  }

  async function changeRowPage(nextPage: number) {
    if (!batch) return;
    setIsBusy(true);
    setError("");
    try {
      if (view === "reconciliation") {
        await loadReconciliationRows(batch, nextPage, matchFilter);
      } else {
        await loadRows(batch, warningsOnly, nextPage);
      }
    } catch {
      setError(t.errors.rows);
    } finally {
      setIsBusy(false);
    }
  }

  async function patchRow(
    row: DirectoryImportRow,
    payload: Parameters<typeof updateDirectoryImportRow>[3]
  ): Promise<boolean> {
    if (!batch) return false;
    const token = getStoredAccessToken();
    if (!token) return false;
    setIsBusy(true);
    setError("");
    try {
      const updated = await updateDirectoryImportRow(token, batch.id, row.id, payload);
      setRows((current) => current.map((item) => (item.id === updated.id ? updated : item)));
      setEditingRow((current) => (current?.id === updated.id ? updated : current));
      if (updated.is_selected !== row.is_selected) {
        setBatch((current) =>
          current
            ? {
                ...current,
                selected_rows: Math.max(
                  0,
                  current.selected_rows + (updated.is_selected ? 1 : -1)
                )
              }
            : current
        );
      }
      setHasManualRowEdits(true);
      return true;
    } catch {
      setError(t.errors.row);
      return false;
    } finally {
      setIsBusy(false);
    }
  }

  async function loadReconciliationRows(
    nextBatch: DirectoryImportBatch,
    nextPage = 1,
    filter: DirectoryImportMatchStatus | "all" = matchFilter
  ) {
    const token = getStoredAccessToken();
    if (!token) return;
    const generation = ++loadGenerationRef.current;
    const result = await getDirectoryImportReconciliation(
      token,
      nextBatch.id,
      nextPage,
      previewPageSize,
      filter
    );
    if (!mountedRef.current || generation !== loadGenerationRef.current) return;
    setRows(result.items);
    setRowPage(result.page);
    setRowTotal(result.total);
  }

  async function startReconciliation() {
    if (!batch || isBusy) return;
    const token = getStoredAccessToken();
    if (!token) return;
    setIsBusy(true);
    setError("");
    setMessage("");
    try {
      const reconciled = await reconcileDirectoryImport(token, batch.id);
      setBatch(reconciled);
      setMatchFilter("all");
      await loadReconciliationRows(reconciled, 1, "all");
      const checked = await validateDirectoryImport(token, reconciled.id);
      setView("reconciliation");
      setValidation(checked);
      setExecutionConfirmed(false);
    } catch {
      setError(t.errors.reconcile);
    } finally {
      setIsBusy(false);
    }
  }

  async function saveMatch(
    row: DirectoryImportRow,
    payload: {
      proposed_action: "create" | "update" | "skip";
      matched_entry_id?: string | null;
      update_fields?: string[];
      restore_if_archived?: boolean;
    }
  ) {
    if (!batch || isBusy) return false;
    const token = getStoredAccessToken();
    if (!token) return false;
    setIsBusy(true);
    setError("");
    try {
      const updated = await updateDirectoryImportMatch(token, batch.id, row.id, {
        ...payload,
        version: batch.version
      });
      setRows((current) => current.map((item) => item.id === updated.id ? updated : item));
      setEditingRow((current) => current?.id === updated.id ? updated : current);
      setValidation(await validateDirectoryImport(token, batch.id));
      return true;
    } catch {
      setError(t.errors.match);
      return false;
    } finally {
      setIsBusy(false);
    }
  }

  async function openConfirmation() {
    if (!batch || isBusy) return;
    const token = getStoredAccessToken();
    if (!token) return;
    setIsBusy(true);
    setError("");
    try {
      const checked = await validateDirectoryImport(token, batch.id);
      setValidation(checked);
      setExecutionConfirmed(false);
      setView("confirmation");
    } catch {
      setError(t.errors.validate);
    } finally {
      setIsBusy(false);
    }
  }

  async function executeImport() {
    if (
      !batch ||
      !validation?.can_execute ||
      !executionConfirmed ||
      isBusy ||
      executeBusyRef.current
    ) return;
    const token = getStoredAccessToken();
    if (!token) return;
    executeBusyRef.current = true;
    setIsExecuting(true);
    setIsBusy(true);
    setError("");
    try {
      const result = await executeDirectoryImport(token, batch.id, batch.version);
      setExecutionResult(result);
      setBatch((current) => current ? { ...current, status: result.status } : current);
      setRows([]);
      setView("result");
      onImported?.();
    } catch (executionError) {
      if (
        executionError instanceof ApiResponseError &&
        executionError.status === 409 &&
        ["stale_match", "stale_batch", "blocking_conflicts"].includes(executionError.message)
      ) {
        setExecutionConfirmed(false);
        setView("reconciliation");
        setError(
          executionError.message === "stale_match" || executionError.message === "stale_batch"
            ? t.errors.stale
            : t.errors.validate
        );
        return;
      }
      try {
        const result = await getDirectoryImportResult(token, batch.id);
        setExecutionResult(result);
        setBatch((current) => current ? { ...current, status: result.status } : current);
        if (result.status === "completed") {
          setRows([]);
          onImported?.();
        }
        setView("result");
      } catch {
        setError(t.errors.execute);
      }
    } finally {
      executeBusyRef.current = false;
      setIsExecuting(false);
      setIsBusy(false);
    }
  }

  async function cancelBatch() {
    if (!batch || !window.confirm(t.cancelConfirm)) return;
    const token = getStoredAccessToken();
    if (!token) return;
    setIsBusy(true);
    try {
      const cancelled = await cancelDirectoryImport(token, batch.id);
      setBatch(null);
      setRows([]);
      setEditingRow(null);
      loadGenerationRef.current += 1;
      setHasManualRowEdits(false);
      setRecentBatches((current) => current.filter((item) => item.id !== cancelled.id));
      setMessage(t.cancelled);
    } catch {
      setError(t.errors.cancel);
    } finally {
      setIsBusy(false);
    }
  }

  async function openRecentBatch(item: DirectoryImportBatch) {
    const token = getStoredAccessToken();
    if (!token || isBusy) return;
    loadGenerationRef.current += 1;
    setBatch(item);
    setRows([]);
    setHasManualRowEdits(false);
    setRowPage(1);
    setRowTotal(0);
    setExecutionResult(null);
    setIsBusy(true);
    try {
      if (item.status === "completed" || item.status === "failed") {
        setExecutionResult(await getDirectoryImportResult(token, item.id));
        setView("result");
      } else if (item.status === "reconciled") {
        setMatchFilter("all");
        await loadReconciliationRows(item, 1, "all");
        setValidation(await validateDirectoryImport(token, item.id));
        setView("reconciliation");
      } else {
        setView("preview");
      }
    } catch {
      setError(t.errors.rows);
      setView("preview");
    } finally {
      setIsBusy(false);
    }
  }

  async function saveEditingRow(event: FormEvent) {
    event.preventDefault();
    if (!editingRow || isBusy) return;
    if (view === "reconciliation") {
      if (editingRow.proposed_action === "update" && !editingRow.matched_entry_id) {
        setEditorError(t.errors.candidateRequired);
        return;
      }
      if (
        editingRow.proposed_action === "update" &&
        !editingRow.update_fields.length &&
        !editingRow.restore_if_archived
      ) {
        setEditorError(t.errors.updateFieldRequired);
        return;
      }
      const saved = await saveMatch(editingRow, {
        proposed_action: editingRow.proposed_action,
        matched_entry_id: editingRow.proposed_action === "update"
          ? editingRow.matched_entry_id
          : null,
        update_fields: editingRow.proposed_action === "update"
          ? editingRow.update_fields
          : [],
        restore_if_archived: editingRow.proposed_action === "update"
          ? editingRow.restore_if_archived
          : false
      });
      if (saved) setEditingRow(null);
      return;
    }
    if (
      editingRow.proposed_action === "create" &&
      !editingRow.normalized_data.display_name?.trim()
    ) {
      setEditorError(t.errors.displayNameRequired);
      return;
    }
    setEditorError("");
    const originalRow = rows.find((row) => row.id === editingRow.id) ?? editingRow;
    const saved = await patchRow(originalRow, {
      detected_kind: editingRow.detected_kind,
      normalized_data: editingRow.normalized_data,
      proposed_action: editingRow.proposed_action === "update"
        ? "skip"
        : editingRow.proposed_action,
      is_selected: editingRow.is_selected
    });
    if (saved) setEditingRow(null);
  }

  function renderContact(row: DirectoryImportRow) {
    const data = row.normalized_data;
    const details = [
      data.position,
      data.department,
      data.internal_phone
        ? `${dictionary.directory.fields.internalPhone}: ${data.internal_phone}`
        : null,
      data.work_phone
        ? `${dictionary.directory.fields.workPhone}: ${data.work_phone}`
        : null,
      data.mobile_phone
        ? `${dictionary.directory.fields.mobilePhone}: ${data.mobile_phone}`
        : null,
      data.email ? `${dictionary.directory.fields.email}: ${data.email}` : null,
      data.room ? `${dictionary.directory.fields.room}: ${data.room}` : null
    ].filter((value): value is string => Boolean(value));
    return (
      <div className="directory-import-contact">
        {data.display_name ? <strong>{data.display_name}</strong> : null}
        {details.map((value) => <span key={value}>{value}</span>)}
        {!data.display_name && details.length === 0 ? <span>{t.empty}</span> : null}
      </div>
    );
  }

  function renderWarningSummary(row: DirectoryImportRow) {
    const visibleWarnings = row.warnings.slice(0, 2);
    const remaining = row.warnings.length - visibleWarnings.length;
    return (
      <div className="directory-import-warnings">
        {visibleWarnings.map((warning, index) => (
          <span
            className={`import-warning import-warning-${warning.severity}`}
            key={`${warning.code}-${index}`}
            title={warningLabel(row, index)}
          >
            {warningLabel(row, index)}
          </span>
        ))}
        {remaining > 0 ? (
          <span
            aria-label={t.moreWarnings.replace("{count}", String(remaining))}
            className="import-warning import-warning-more"
            title={row.warnings.slice(2).map((_, index) => warningLabel(row, index + 2)).join("\n")}
          >
            +{remaining}
          </span>
        ) : null}
        {!row.warnings.length ? <span className="muted">{t.noWarnings}</span> : null}
      </div>
    );
  }

  function matchLabel(status: DirectoryImportMatchStatus | null) {
    return status ? t.matchStatuses[status] : t.notAvailable;
  }

  function matchReasonLabel(code: string) {
    return t.matchReasons[code as keyof typeof t.matchReasons] ?? code;
  }

  async function changeMatchFilter(filter: DirectoryImportMatchStatus | "all") {
    if (!batch || isBusy) return;
    setMatchFilter(filter);
    setIsBusy(true);
    setError("");
    try {
      await loadReconciliationRows(batch, 1, filter);
    } catch {
      setError(t.errors.rows);
    } finally {
      setIsBusy(false);
    }
  }

  const editingRowHasBlockingWarning = editingRow?.warnings.some(
    (warning) => warning.severity === "blocking"
  ) ?? false;
  const reconciliationRows = rows;

  return (
    <div className="directory-import-backdrop" role="presentation">
      <section
        aria-label={t.title}
        aria-modal="true"
        className="directory-import-wizard"
        role="dialog"
      >
        <header className="dashboard-header directory-import-header">
          <div>
            <p className="eyebrow">{t.eyebrow}</p>
            <h3>{t.title}</h3>
            <p className="muted">{t.previewOnly}</p>
          </div>
          <button className="table-action" disabled={isBusy} onClick={onClose} type="button">
            {t.close}
          </button>
        </header>

        <ol aria-label={t.stepsLabel} className="directory-import-steps">
          {[
            t.steps.upload,
            t.steps.mapping,
            t.steps.preview,
            t.steps.reconciliation,
            t.steps.result
          ].map((label, index) => (
            <li className={step === index + 1 ? "is-current" : ""} key={label}>
              <span>{index + 1}</span>{label}
            </li>
          ))}
        </ol>

        {error ? <p className="form-error">{error}</p> : null}
        {message ? <p className="form-success">{message}</p> : null}

        {!batch ? (
          <form className="directory-import-upload" onSubmit={upload}>
            <label className="field">
              <span className="field-label">{t.file}</span>
              <input
                accept=".xlsx,.csv"
                aria-label={t.file}
                className="field-input"
                disabled={isBusy}
                onChange={(event) => setFile(event.target.files?.[0] ?? null)}
                type="file"
              />
              {file ? (
                <span className="directory-import-file-name" title={file.name}>
                  {file.name}
                </span>
              ) : null}
              <small>{t.fileHelp}</small>
            </label>
            <label className="field">
              <span className="field-label">{t.parserMode}</span>
              <select
                aria-label={t.parserMode}
                className="field-input"
                disabled={isBusy}
                onChange={(event) => setParserMode(event.target.value as DirectoryImportParserMode)}
                value={parserMode}
              >
                <option value="auto">{t.modes.auto}</option>
                <option value="table">{t.modes.table}</option>
                <option value="legacy_layout">{t.modes.legacy}</option>
              </select>
            </label>
            <div className="actions">
              <button className="primary-button" disabled={isBusy} type="submit">
                {isBusy ? t.uploading : t.analyze}
              </button>
              <button className="secondary-link" disabled={isBusy} onClick={onClose} type="button">{t.close}</button>
            </div>
            {recentBatches.length ? (
              <div className="directory-import-recent">
                <strong>{t.recent}</strong>
                {recentBatches.map((item) => (
                  <button
                    className="table-action"
                    disabled={isBusy}
                    key={item.id}
                    onClick={() => void openRecentBatch(item)}
                    type="button"
                  >
                    {item.original_filename} · {item.detected_rows}
                  </button>
                ))}
              </div>
            ) : null}
          </form>
        ) : null}

        {batch && rows.length === 0 && view === "preview" && !executionResult ? (
          <div className="directory-import-mapping">
            <div className="directory-import-summary">
              <strong>{batch.original_filename}</strong>
              <span>{t.summary
                .replace("{rows}", String(batch.total_source_rows))
                .replace("{warnings}", String(batch.warning_rows))}</span>
            </div>
            <div className="directory-import-settings">
              <label className="field">
                <span className="field-label">{t.parserMode}</span>
                <select
                  className="field-input"
                  disabled={isBusy}
                  onChange={(event) =>
                    setBatch((current) => current && {
                      ...current,
                      parser_mode: event.target.value as DirectoryImportParserMode
                    })
                  }
                  value={batch.parser_mode}
                >
                  <option value="auto">{t.modes.auto}</option>
                  <option value="table">{t.modes.table}</option>
                  <option value="legacy_layout">{t.modes.legacy}</option>
                </select>
              </label>
              {batch.available_sheets.length ? (
                <label className="field">
                  <span className="field-label">{t.sheet}</span>
                  <select
                    className="field-input"
                    disabled={isBusy || batch.available_sheets.length === 1}
                    onChange={(event) =>
                      setBatch((current) => current && {
                        ...current,
                        selected_sheet: event.target.value,
                        column_mapping: {},
                        source_columns: []
                      })
                    }
                    value={batch.selected_sheet ?? ""}
                  >
                    {batch.available_sheets.map((sheet) => <option key={sheet}>{sheet}</option>)}
                  </select>
                </label>
              ) : null}
            </div>
            {batch.source_columns.length ? (
              <div className="directory-import-column-map">
                <h4>{t.mapping.title}</h4>
                {batch.source_columns.map((column) => (
                  <div className="directory-import-column" key={column.index}>
                    <div>
                      <strong>{column.label || t.mapping.unnamed.replace("{index}", String(column.index + 1))}</strong>
                      <small>{column.samples.join(" · ") || t.mapping.noSamples}</small>
                    </div>
                    <select
                      aria-label={t.mapping.column.replace("{column}", column.label || String(column.index + 1))}
                      className="field-input"
                      disabled={isBusy}
                      onChange={(event) =>
                        setBatch((current) => {
                          if (!current) return current;
                          const mapping = { ...current.column_mapping };
                          Object.keys(mapping).forEach((key) => {
                            if (mapping[key] === event.target.value) delete mapping[key];
                          });
                          if (event.target.value) mapping[String(column.index)] = event.target.value;
                          else delete mapping[String(column.index)];
                          return { ...current, column_mapping: mapping };
                        })
                      }
                      value={batch.column_mapping[String(column.index)] ?? ""}
                    >
                      {mappingTargets.map(([value, label]) => (
                        <option key={value} value={value}>{label}</option>
                      ))}
                    </select>
                  </div>
                ))}
              </div>
            ) : null}
            <div className="actions">
              <button className="primary-button" disabled={isBusy} onClick={() => void saveAnalysisSettings()} type="button">
                {isBusy ? t.reanalyzing : t.reanalyze}
              </button>
              <button className="secondary-link" disabled={isBusy} onClick={() => void openPreview()} type="button">
                {t.openPreview}
              </button>
              <button className="secondary-link" disabled={isBusy} onClick={() => void cancelBatch()} type="button">
                {t.cancelBatch}
              </button>
            </div>
          </div>
        ) : null}

        {batch && rows.length > 0 && view === "preview" ? (
          <div className="directory-import-preview">
            <div className="directory-import-preview-toolbar">
              <div className="directory-import-preview-summary">
                <strong title={batch.original_filename}>{batch.original_filename}</strong>
                <small>
                  {t.selectedCount.replace(
                    "{count}",
                    String(batch.selected_rows)
                  )}
                </small>
              </div>
              <div className="directory-import-preview-actions">
                <label className="checkbox-label">
                  <input
                    checked={warningsOnly}
                    disabled={isBusy}
                    onChange={(event) => void toggleWarnings(event.target.checked)}
                    type="checkbox"
                  />
                  {t.warningsOnly}
                </label>
                <button
                  className="secondary-link"
                  disabled={isBusy}
                  onClick={() => void saveAnalysisSettings()}
                  type="button"
                >
                  {isBusy ? t.reanalyzing : t.reanalyze}
                </button>
                <button
                  className="secondary-link"
                  disabled={isBusy}
                  onClick={() => void cancelBatch()}
                  type="button"
                >
                  {t.cancelBatch}
                </button>
                <button className="secondary-link" disabled={isBusy} onClick={onClose} type="button">
                  {t.close}
                </button>
              </div>
            </div>

            <div className="directory-import-table-wrap">
              <table className="directory-import-table">
                <thead>
                  <tr>
                    <th>{t.preview.select}</th>
                    <th>{t.preview.source}</th>
                    <th>{t.preview.kind}</th>
                    <th>{t.preview.contact}</th>
                    <th>{t.preview.warnings}</th>
                    <th>{t.preview.action}</th>
                    <th>{t.preview.details}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr
                      className={row.warnings.some((warning) => warning.severity === "blocking")
                        ? "directory-import-row-blocking"
                        : undefined}
                      key={row.id}
                    >
                      <td>
                        <input
                          aria-label={t.preview.selectRow.replace("{row}", rowRange(row))}
                          checked={row.is_selected}
                          disabled={isBusy || row.warnings.some((item) => item.severity === "blocking")}
                          onChange={(event) => void patchRow(row, {
                            is_selected: event.target.checked,
                            proposed_action: event.target.checked ? "create" : "skip"
                          })}
                          type="checkbox"
                        />
                      </td>
                      <td>{row.source_sheet} · {rowRange(row)}</td>
                      <td>{t.kinds[row.detected_kind]}</td>
                      <td>{renderContact(row)}</td>
                      <td>{renderWarningSummary(row)}</td>
                      <td>{t.actions[row.proposed_action]}</td>
                      <td>
                        <button
                          className="table-action"
                          onClick={(event) => openRowEditor(row, event.currentTarget)}
                          type="button"
                        >
                          {t.openDetails}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="directory-import-cards">
              {rows.map((row) => (
                <article
                  className={`directory-import-card${
                    row.warnings.some((warning) => warning.severity === "blocking")
                      ? " directory-import-card-blocking"
                      : ""
                  }`}
                  key={row.id}
                >
                  <header>
                    <label className="checkbox-label">
                      <input
                        checked={row.is_selected}
                        disabled={isBusy || row.warnings.some((item) => item.severity === "blocking")}
                        onChange={(event) => void patchRow(row, {
                          is_selected: event.target.checked,
                          proposed_action: event.target.checked ? "create" : "skip"
                        })}
                        type="checkbox"
                      />
                      {row.source_sheet} · {rowRange(row)}
                    </label>
                    <span>{t.kinds[row.detected_kind]}</span>
                  </header>
                  {renderContact(row)}
                  <div className="directory-import-card-footer">
                    {renderWarningSummary(row)}
                    <span className="directory-import-action">{t.actions[row.proposed_action]}</span>
                  </div>
                  <button
                    className="table-action"
                    onClick={(event) => openRowEditor(row, event.currentTarget)}
                    type="button"
                  >
                    {t.openDetails}
                  </button>
                </article>
              ))}
            </div>

            {rowTotal > previewPageSize ? (
              <div className="directory-pagination">
                <span>
                  {t.page
                    .replace("{page}", String(rowPage))
                    .replace("{pages}", String(Math.ceil(rowTotal / previewPageSize)))
                    .replace("{total}", String(rowTotal))}
                </span>
                <div>
                  <button
                    className="secondary-link"
                    disabled={isBusy || rowPage <= 1}
                    onClick={() => void changeRowPage(rowPage - 1)}
                    type="button"
                  >
                    {t.previous}
                  </button>
                  <button
                    className="secondary-link"
                    disabled={
                      isBusy || rowPage >= Math.ceil(rowTotal / previewPageSize)
                    }
                    onClick={() => void changeRowPage(rowPage + 1)}
                    type="button"
                  >
                    {t.next}
                  </button>
                </div>
              </div>
            ) : null}

            <div className="actions">
              <button className="secondary-link" disabled={isBusy} onClick={() => setRows([])} type="button">{t.backToMapping}</button>
              <button className="primary-button" disabled={isBusy} onClick={() => void startReconciliation()} type="button">
                {isBusy ? t.reconciling : t.startReconciliation}
              </button>
            </div>
          </div>
        ) : null}

        {batch && view === "reconciliation" ? (
          <div className="directory-import-preview directory-import-reconciliation">
            <div className="directory-import-preview-toolbar">
              <div className="directory-import-preview-summary">
                <strong>{t.reconciliation.title}</strong>
                <small>{t.reconciliation.description}</small>
              </div>
              <button
                className="secondary-link"
                disabled={isBusy}
                onClick={() => void startReconciliation()}
                type="button"
              >
                {isBusy ? t.reconciling : t.reconciliation.refresh}
              </button>
            </div>
            {validation ? (
              <div className="directory-import-reconciliation-summary">
                <span>{t.reconciliation.create}: <strong>{validation.create_count}</strong></span>
                <span>{t.reconciliation.update}: <strong>{validation.update_count}</strong></span>
                <span>{t.reconciliation.restore}: <strong>{validation.restore_count}</strong></span>
                <span>{t.reconciliation.skip}: <strong>{validation.skip_count}</strong></span>
                <span className={validation.blocking_count ? "has-blocking" : ""}>
                  {t.reconciliation.blocking}: <strong>{validation.blocking_count}</strong>
                </span>
              </div>
            ) : null}
            <div className="directory-import-match-filters" aria-label={t.reconciliation.filters}>
              {(["all", "unmatched", "exact", "probable", "ambiguous", "archived_match", "batch_duplicate"] as const).map((filter) => (
                <button
                  aria-pressed={matchFilter === filter}
                  className={matchFilter === filter ? "table-action is-active" : "table-action"}
                  disabled={isBusy}
                  key={filter}
                  onClick={() => void changeMatchFilter(filter)}
                  type="button"
                >
                  {filter === "all" ? t.reconciliation.all : matchLabel(filter)}
                </button>
              ))}
            </div>
            <div className="directory-import-table-wrap">
              <table className="directory-import-table directory-import-reconciliation-table">
                <thead>
                  <tr>
                    <th>{t.preview.source}</th>
                    <th>{t.preview.contact}</th>
                    <th>{t.reconciliation.match}</th>
                    <th>{t.reconciliation.reasons}</th>
                    <th>{t.preview.action}</th>
                    <th>{t.preview.details}</th>
                  </tr>
                </thead>
                <tbody>
                  {reconciliationRows.map((row) => (
                    <tr className={row.match_status === "ambiguous" || row.match_status === "batch_duplicate" ? "directory-import-row-blocking" : undefined} key={row.id}>
                      <td>{row.source_sheet} · {rowRange(row)}</td>
                      <td>{renderContact(row)}</td>
                      <td>
                        <span className={`import-match import-match-${row.match_status ?? "none"}`}>
                          {matchLabel(row.match_status)}
                        </span>
                      </td>
                      <td>
                        <div className="directory-import-match-reasons">
                          {row.match_reasons.slice(0, 3).map((reason, index) => (
                            <span key={`${reason.code}-${index}`}>{matchReasonLabel(reason.code)}</span>
                          ))}
                        </div>
                      </td>
                      <td>{t.actions[row.proposed_action]}</td>
                      <td>
                        <button
                          className="table-action"
                          disabled={isBusy}
                          onClick={(event) => openRowEditor(row, event.currentTarget)}
                          type="button"
                        >
                          {t.reconciliation.compare}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="directory-import-cards">
              {reconciliationRows.map((row) => (
                <article className="directory-import-card" key={row.id}>
                  <header>
                    <span>{row.source_sheet} · {rowRange(row)}</span>
                    <span className={`import-match import-match-${row.match_status ?? "none"}`}>
                      {matchLabel(row.match_status)}
                    </span>
                  </header>
                  {renderContact(row)}
                  <div className="directory-import-match-reasons">
                    {row.match_reasons.slice(0, 3).map((reason, index) => (
                      <span key={`${reason.code}-${index}`}>{matchReasonLabel(reason.code)}</span>
                    ))}
                  </div>
                  <div className="directory-import-card-footer">
                    <span className="directory-import-action">{t.actions[row.proposed_action]}</span>
                    <button
                      className="table-action"
                      disabled={isBusy}
                      onClick={(event) => openRowEditor(row, event.currentTarget)}
                      type="button"
                    >
                      {t.reconciliation.compare}
                    </button>
                  </div>
                </article>
              ))}
            </div>
            {!reconciliationRows.length ? <p className="empty-state">{t.reconciliation.empty}</p> : null}
            {rowTotal > previewPageSize ? (
              <div className="directory-pagination">
                <span>
                  {t.page
                    .replace("{page}", String(rowPage))
                    .replace("{pages}", String(Math.ceil(rowTotal / previewPageSize)))
                    .replace("{total}", String(rowTotal))}
                </span>
                <div>
                  <button className="secondary-link" disabled={isBusy || rowPage <= 1} onClick={() => void changeRowPage(rowPage - 1)} type="button">{t.previous}</button>
                  <button className="secondary-link" disabled={isBusy || rowPage >= Math.ceil(rowTotal / previewPageSize)} onClick={() => void changeRowPage(rowPage + 1)} type="button">{t.next}</button>
                </div>
              </div>
            ) : null}
            <div className="actions">
              <button className="secondary-link" disabled={isBusy} onClick={() => { setView("preview"); setRows([]); }} type="button">{t.backToMapping}</button>
              <button className="primary-button" disabled={isBusy} onClick={() => void openConfirmation()} type="button">{t.reconciliation.continue}</button>
            </div>
          </div>
        ) : null}

        {batch && view === "confirmation" && validation ? (
          <div className="directory-import-confirmation">
            <h4>{t.confirmation.title}</h4>
            <p>{t.confirmation.warning}</p>
            <dl className="directory-import-result-grid">
              <div><dt>{t.confirmation.create}</dt><dd>{validation.create_count}</dd></div>
              <div><dt>{t.confirmation.update}</dt><dd>{validation.update_count}</dd></div>
              <div><dt>{t.confirmation.restore}</dt><dd>{validation.restore_count}</dd></div>
              <div><dt>{t.confirmation.skip}</dt><dd>{validation.skip_count}</dd></div>
            </dl>
            {validation.blocking_count ? (
              <p className="form-error">
                {t.confirmation.blocked.replace("{count}", String(validation.blocking_count))}
              </p>
            ) : null}
            <label className="checkbox-label directory-import-execute-confirm">
              <input
                checked={executionConfirmed}
                disabled={isBusy || !validation.can_execute}
                onChange={(event) => setExecutionConfirmed(event.target.checked)}
                type="checkbox"
              />
              {t.confirmation.checkbox}
            </label>
            <div className="actions">
              <button className="secondary-link" disabled={isBusy} onClick={() => setView("reconciliation")} type="button">{t.confirmation.back}</button>
              <button className="primary-button" disabled={isBusy || !validation.can_execute || !executionConfirmed} onClick={() => void executeImport()} type="button">
                {isBusy ? t.confirmation.executing : t.confirmation.execute}
              </button>
            </div>
          </div>
        ) : null}

        {executionResult && view === "result" ? (
          <div className="directory-import-result">
            <h4>{executionResult.status === "completed" ? t.result.success : t.result.failed}</h4>
            <p>{executionResult.status === "completed" ? t.result.successDescription : t.result.rollbackDescription}</p>
            <dl className="directory-import-result-grid">
              <div><dt>{t.result.created}</dt><dd>{executionResult.created}</dd></div>
              <div><dt>{t.result.updated}</dt><dd>{executionResult.updated}</dd></div>
              <div><dt>{t.result.restored}</dt><dd>{executionResult.restored}</dd></div>
              <div><dt>{t.result.skipped}</dt><dd>{executionResult.skipped}</dd></div>
              <div><dt>{t.result.errors}</dt><dd>{executionResult.errors}</dd></div>
              <div>
                <dt>{t.result.duration}</dt>
                <dd>{t.result.durationValue.replace("{value}", String(executionResult.duration_ms))}</dd>
              </div>
            </dl>
            {executionResult.error_code ? <p className="form-error">{t.result.errorCode.replace("{code}", executionResult.error_code)}</p> : null}
            <div className="actions">
              {executionResult.status === "failed" ? (
                <button className="secondary-link" onClick={() => setView("reconciliation")} type="button">{t.result.back}</button>
              ) : null}
              <button className="primary-button" onClick={onClose} type="button">{t.result.openDirectory}</button>
              <button className="secondary-link" onClick={onClose} type="button">{t.close}</button>
            </div>
          </div>
        ) : null}

        {editingRow ? (
          <div
            className="directory-import-detail-backdrop"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget) closeRowEditor();
            }}
            role="presentation"
          >
            <section
              aria-label={t.detailsTitle}
              aria-modal="true"
              className="directory-import-row-editor"
              ref={editorRef}
              role="dialog"
            >
              <header className="directory-import-editor-header">
                <div>
                  <h4>{t.detailsTitle}</h4>
                  <p className="muted">
                    {editingRow.source_sheet} · {rowRange(editingRow)}
                  </p>
                </div>
                <button className="table-action" onClick={closeRowEditor} type="button">
                  {t.close}
                </button>
              </header>
              <form className="directory-import-editor-form" onSubmit={saveEditingRow}>
                <dl className="directory-import-row-metadata">
                  <div>
                    <dt>{t.sourceRows}</dt>
                    <dd>{rowRange(editingRow)}</dd>
                  </div>
                  <div>
                    <dt>{t.confidence}</dt>
                    <dd>
                      {editingRow.confidence === null
                        ? t.notAvailable
                        : `${Math.round(editingRow.confidence * 100)}%`}
                    </dd>
                  </div>
                </dl>
                <div className="directory-import-settings">
                  <label className="field">
                    <span className="field-label">{t.preview.kind}</span>
                    <select
                      className="field-input"
                      data-editor-initial-focus
                      disabled={isBusy || view === "reconciliation"}
                      onChange={(event) => setEditingRow((current) => current && {
                        ...current,
                        detected_kind: event.target.value as DirectoryImportKind
                      })}
                      value={editingRow.detected_kind}
                    >
                      {(Object.keys(t.kinds) as DirectoryImportKind[]).map((kind) => (
                        <option key={kind} value={kind}>{t.kinds[kind]}</option>
                      ))}
                    </select>
                  </label>
                  <label className="field">
                    <span className="field-label">{t.preview.action}</span>
                    <select
                      className="field-input"
                      disabled={isBusy}
                      onChange={(event) => setEditingRow((current) => current && {
                        ...current,
                        proposed_action: event.target.value as "create" | "update" | "skip",
                        is_selected: event.target.value !== "skip",
                        matched_entry_id: event.target.value === "update"
                          ? current.matched_entry_id ?? current.match_candidates[0]?.id ?? null
                          : null,
                        update_fields: event.target.value === "update"
                          ? current.update_fields
                          : [],
                        restore_if_archived: event.target.value === "update"
                          ? current.restore_if_archived
                          : false
                      })}
                      value={editingRow.proposed_action}
                    >
                      <option value="create">{t.actions.create}</option>
                      {view === "reconciliation" ? <option value="update">{t.actions.update}</option> : null}
                      <option value="skip">{t.actions.skip}</option>
                    </select>
                  </label>
                </div>
                {view !== "reconciliation" ? <label className="checkbox-label directory-import-editor-selection">
                  <input
                    checked={editingRow.is_selected}
                    disabled={isBusy || editingRowHasBlockingWarning}
                    onChange={(event) => setEditingRow((current) => current && {
                      ...current,
                      is_selected: event.target.checked,
                      proposed_action: event.target.checked ? "create" : "skip"
                    })}
                    type="checkbox"
                  />
                  {t.includeRow}
                </label> : null}
                {view === "reconciliation" ? (
                  <section className="directory-import-match-editor">
                    <h5>{t.reconciliation.candidates}</h5>
                    {editingRow.match_candidates.length ? (
                      <div className="directory-import-candidates">
                        {editingRow.match_candidates.map((candidate) => (
                          <label className="directory-import-candidate" key={candidate.id}>
                            <input
                              checked={editingRow.matched_entry_id === candidate.id}
                              disabled={isBusy || editingRow.proposed_action !== "update"}
                              name="directory-import-candidate"
                              onChange={() => {
                                setEditorError("");
                                setEditingRow((current) => current && {
                                  ...current,
                                  matched_entry_id: candidate.id,
                                  expected_entry_updated_at: candidate.updated_at,
                                  restore_if_archived: !candidate.is_active
                                });
                                void loadComparisonEntry(candidate.id);
                              }}
                              type="radio"
                            />
                            <span>
                              <strong>{candidate.display_name}</strong>
                              <small>{[candidate.department, candidate.position, candidate.email].filter(Boolean).join(" · ")}</small>
                              <small>{candidate.is_active ? t.reconciliation.active : t.reconciliation.archived} · {Math.round(candidate.score)}%</small>
                            </span>
                          </label>
                        ))}
                      </div>
                    ) : <p className="muted">{t.reconciliation.noCandidates}</p>}
                    {editingRow.proposed_action === "update" && editingRow.matched_entry_id ? (
                      <div className="directory-import-comparison">
                        <div className="directory-import-comparison-head">
                          <strong>{t.reconciliation.existing}</strong>
                          <strong>{t.reconciliation.imported}</strong>
                        </div>
                        {importFields.map((field) => {
                          const candidate = editingRow.match_candidates.find((item) => item.id === editingRow.matched_entry_id);
                          const imported = editingRow.normalized_data[field];
                          const existingSource = comparisonEntry?.id === editingRow.matched_entry_id
                            ? comparisonEntry
                            : candidate;
                          const existing = existingSource
                            ? (existingSource as unknown as Record<string, unknown>)[field]
                            : null;
                          if (!hasImportedValue(imported)) return null;
                          return (
                            <label className="directory-import-comparison-row" key={field}>
                              <span>
                                <small>{dictionary.directory.fields[fieldLabelKey(field)]}</small>
                                {String(existing ?? t.empty)}
                              </span>
                              <span>
                                <input
                                  aria-label={t.reconciliation.applyField.replace("{field}", dictionary.directory.fields[fieldLabelKey(field)])}
                                  checked={editingRow.update_fields.includes(field)}
                                  disabled={isBusy}
                                  onChange={(event) => setEditingRow((current) => current && {
                                    ...current,
                                    update_fields: event.target.checked
                                      ? [...new Set([...current.update_fields, field])]
                                      : current.update_fields.filter((item) => item !== field)
                                  })}
                                  type="checkbox"
                                />
                                {String(imported)}
                              </span>
                            </label>
                          );
                        })}
                        {editingRow.match_candidates.find((item) => item.id === editingRow.matched_entry_id)?.is_active === false ? (
                          <label className="checkbox-label">
                            <input
                              checked={editingRow.restore_if_archived}
                              disabled={isBusy}
                              onChange={(event) => setEditingRow((current) => current && ({
                                ...current,
                                restore_if_archived: event.target.checked
                              }))}
                              type="checkbox"
                            />
                            {t.reconciliation.restoreArchived}
                          </label>
                        ) : null}
                      </div>
                    ) : null}
                    <div className="directory-import-match-reasons">
                      {editingRow.match_reasons.map((reason, index) => (
                        <span key={`${reason.code}-${index}`}>{matchReasonLabel(reason.code)}</span>
                      ))}
                    </div>
                    {editorError ? <p className="form-error">{editorError}</p> : null}
                  </section>
                ) : <div className="directory-import-edit-grid">
                  {importFields.map((field) => (
                    <label className="field" key={field}>
                      <span className="field-label">{dictionary.directory.fields[fieldLabelKey(field)]}</span>
                      <input
                        aria-describedby={field === "display_name" && editorError ? "directory-import-display-name-error" : undefined}
                        aria-invalid={field === "display_name" && Boolean(editorError)}
                        className="field-input"
                        disabled={isBusy}
                        onChange={(event) => {
                          if (field === "display_name") setEditorError("");
                          setEditingRow((current) => current && {
                            ...current,
                            normalized_data: { ...current.normalized_data, [field]: event.target.value }
                          });
                        }}
                        value={editingRow.normalized_data[field] ?? ""}
                      />
                      {field === "display_name" && editorError ? (
                        <small className="form-error" id="directory-import-display-name-error">
                          {editorError}
                        </small>
                      ) : null}
                    </label>
                  ))}
                </div>}
                <section className="directory-import-warning-details">
                  <h5>{t.preview.warnings}</h5>
                  {editingRow.warnings.length ? (
                    <div className="directory-import-warnings">
                      {editingRow.warnings.map((warning, index) => (
                        <span
                          className={`import-warning import-warning-${warning.severity}`}
                          key={`${warning.code}-${index}`}
                        >
                          {warningLabel(editingRow, index)}
                        </span>
                      ))}
                    </div>
                  ) : <p className="muted">{t.noWarnings}</p>}
                </section>
                <details className="directory-import-raw">
                  <summary>{t.rawCells}</summary>
                  <pre>{JSON.stringify(editingRow.raw_cells, null, 2)}</pre>
                </details>
                <div className="directory-import-editor-actions">
                  <button className="primary-button" disabled={isBusy} type="submit">
                    {view === "reconciliation" ? t.reconciliation.save : t.saveRow}
                  </button>
                  <button className="secondary-link" disabled={isBusy} onClick={closeRowEditor} type="button">
                    {t.close}
                  </button>
                </div>
              </form>
            </section>
          </div>
        ) : null}
      </section>
    </div>
  );
}

function fieldLabelKey(field: typeof importFields[number]) {
  const map = {
    display_name: "displayName",
    department: "department",
    position: "position",
    internal_phone: "internalPhone",
    work_phone: "workPhone",
    mobile_phone: "mobilePhone",
    email: "email",
    room: "room",
    location: "location",
    notes: "notes"
  } as const;
  return map[field];
}
