"use client";

import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";

import {
  ApiResponseError,
  cancelDirectoryImport,
  getDirectoryImportRows,
  getDirectoryImports,
  getStoredAccessToken,
  reanalyzeDirectoryImport,
  updateDirectoryImport,
  updateDirectoryImportRow,
  uploadDirectoryImport,
  type DirectoryImportBatch,
  type DirectoryImportKind,
  type DirectoryImportParserMode,
  type DirectoryImportRow
} from "../lib/api";
import type { Dictionary } from "../lib/i18n";

type Props = {
  dictionary: Dictionary;
  onClose: () => void;
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

export function DirectoryImportWizard({ dictionary, onClose }: Props) {
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
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const uploadBusyRef = useRef(false);
  const loadGenerationRef = useRef(0);
  const mountedRef = useRef(true);

  const step = batch ? (rows.length || batch.detected_rows === 0 ? 3 : 2) : 1;
  const mappingTargets = useMemo(
    () => [
      ["", t.mapping.skipColumn],
      ...importFields.map((field) => [field, dictionary.directory.fields[fieldLabelKey(field)]])
    ],
    [dictionary.directory.fields, t.mapping.skipColumn]
  );

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
      await loadRows(batch, warningsOnly, nextPage);
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

  async function cancelBatch() {
    if (!batch || !window.confirm(t.cancelConfirm)) return;
    const token = getStoredAccessToken();
    if (!token) return;
    setIsBusy(true);
    try {
      const cancelled = await cancelDirectoryImport(token, batch.id);
      setBatch(null);
      setRows([]);
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

  return (
    <div className="modal-backdrop" role="presentation">
      <section
        aria-label={t.title}
        aria-modal="true"
        className="directory-import-wizard"
        role="dialog"
      >
        <header className="dashboard-header">
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
          {[t.steps.upload, t.steps.mapping, t.steps.preview].map((label, index) => (
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
                    onClick={() => {
                      loadGenerationRef.current += 1;
                      setBatch(item);
                      setRows([]);
                      setHasManualRowEdits(false);
                      setRowPage(1);
                      setRowTotal(0);
                    }}
                    type="button"
                  >
                    {item.original_filename} · {item.detected_rows}
                  </button>
                ))}
              </div>
            ) : null}
          </form>
        ) : null}

        {batch && rows.length === 0 ? (
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

        {batch && rows.length > 0 ? (
          <div className="directory-import-preview">
            <div className="directory-import-preview-toolbar">
              <div>
                <strong>{batch.original_filename}</strong>
                <small>
                  {t.selectedCount.replace(
                    "{count}",
                    String(batch.selected_rows)
                  )}
                </small>
              </div>
              <label className="checkbox-label">
                <input
                  checked={warningsOnly}
                  disabled={isBusy}
                  onChange={(event) => void toggleWarnings(event.target.checked)}
                  type="checkbox"
                />
                {t.warningsOnly}
              </label>
            </div>

            <div className="directory-import-table-wrap">
              <table className="directory-import-table">
                <thead>
                  <tr>
                    <th>{t.preview.select}</th>
                    <th>{t.preview.source}</th>
                    <th>{t.preview.kind}</th>
                    <th>{dictionary.directory.fields.displayName}</th>
                    <th>{dictionary.directory.fields.position}</th>
                    <th>{dictionary.directory.fields.department}</th>
                    <th>{dictionary.directory.fields.internalPhone}</th>
                    <th>{dictionary.directory.fields.workPhone}</th>
                    <th>{dictionary.directory.fields.mobilePhone}</th>
                    <th>{dictionary.directory.fields.email}</th>
                    <th>{dictionary.directory.fields.room}</th>
                    <th>{t.preview.warnings}</th>
                    <th>{t.preview.action}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.id}>
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
                      <td>
                        <button className="table-action" onClick={() => setEditingRow(row)} type="button">
                          {row.source_sheet} · {rowRange(row)}
                        </button>
                      </td>
                      <td>{t.kinds[row.detected_kind]}</td>
                      <td>{row.normalized_data.display_name || t.empty}</td>
                      <td>{row.normalized_data.position || t.empty}</td>
                      <td>{row.normalized_data.department || t.empty}</td>
                      <td>{row.normalized_data.internal_phone || t.empty}</td>
                      <td>{row.normalized_data.work_phone || t.empty}</td>
                      <td>{row.normalized_data.mobile_phone || t.empty}</td>
                      <td>{row.normalized_data.email || t.empty}</td>
                      <td>{row.normalized_data.room || t.empty}</td>
                      <td>
                        <div className="directory-import-warnings">
                          {row.warnings.map((warning, index) => (
                            <span className={`import-warning import-warning-${warning.severity}`} key={`${warning.code}-${index}`}>
                              {t.warningCodes[warning.code as keyof typeof t.warningCodes] ?? warning.code}
                            </span>
                          ))}
                        </div>
                      </td>
                      <td>{t.actions[row.proposed_action]}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="directory-import-cards">
              {rows.map((row) => (
                <article className="directory-import-card" key={row.id}>
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
                  <strong>{row.normalized_data.display_name || t.empty}</strong>
                  <span>{row.normalized_data.position || t.empty}</span>
                  <span>{row.normalized_data.department || t.empty}</span>
                  <span>{[
                    row.normalized_data.internal_phone,
                    row.normalized_data.work_phone,
                    row.normalized_data.mobile_phone,
                    row.normalized_data.email,
                    row.normalized_data.room
                  ].filter(Boolean).join(" · ") || t.empty}</span>
                  <div className="directory-import-warnings">
                    {row.warnings.map((warning, index) => (
                      <span className={`import-warning import-warning-${warning.severity}`} key={`${warning.code}-${index}`}>
                        {t.warningCodes[warning.code as keyof typeof t.warningCodes] ?? warning.code}
                      </span>
                    ))}
                  </div>
                  <button className="table-action" onClick={() => setEditingRow(row)} type="button">{t.editRow}</button>
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
              <button className="secondary-link" disabled={isBusy} onClick={() => void cancelBatch()} type="button">{t.cancelBatch}</button>
            </div>
          </div>
        ) : null}

        {editingRow ? (
          <div className="directory-import-row-editor">
            <header className="dashboard-header">
              <h4>{t.editRow}</h4>
              <button className="table-action" onClick={() => setEditingRow(null)} type="button">{t.close}</button>
            </header>
            <div className="directory-import-settings">
              <label className="field">
                <span className="field-label">{t.preview.kind}</span>
                <select
                  className="field-input"
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
                  onChange={(event) => setEditingRow((current) => current && {
                    ...current,
                    proposed_action: event.target.value as "create" | "skip",
                    is_selected: event.target.value === "create" && current.is_selected
                  })}
                  value={editingRow.proposed_action}
                >
                  <option value="create">{t.actions.create}</option>
                  <option value="skip">{t.actions.skip}</option>
                </select>
              </label>
            </div>
            <div className="directory-import-edit-grid">
              {importFields.map((field) => (
                <label className="field" key={field}>
                  <span className="field-label">{dictionary.directory.fields[fieldLabelKey(field)]}</span>
                  <input
                    className="field-input"
                    onChange={(event) => setEditingRow((current) => current && {
                      ...current,
                      normalized_data: { ...current.normalized_data, [field]: event.target.value }
                    })}
                    value={editingRow.normalized_data[field] ?? ""}
                  />
                </label>
              ))}
            </div>
            <details className="directory-import-raw">
              <summary>{t.rawCells}</summary>
              <pre>{JSON.stringify(editingRow.raw_cells, null, 2)}</pre>
            </details>
            <div className="actions">
              <button
                className="primary-button"
                disabled={isBusy}
                onClick={() => void patchRow(editingRow, {
                  detected_kind: editingRow.detected_kind,
                  normalized_data: editingRow.normalized_data,
                  proposed_action: editingRow.proposed_action,
                  is_selected: editingRow.is_selected
                }).then((saved) => {
                  if (saved) setEditingRow(null);
                })}
                type="button"
              >
                {t.saveRow}
              </button>
              <button className="secondary-link" onClick={() => setEditingRow(null)} type="button">{t.close}</button>
            </div>
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
