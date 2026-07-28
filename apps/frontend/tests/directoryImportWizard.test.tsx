import { StrictMode } from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DirectoryImportWizard } from "../components/DirectoryImportWizard";
import { getDictionary } from "../lib/i18n";
import {
  ApiResponseError,
  type DirectoryImportBatch,
  type DirectoryImportRow
} from "../lib/api";

const apiMocks = vi.hoisted(() => ({
  cancelDirectoryImport: vi.fn(),
  executeDirectoryImport: vi.fn(),
  getDirectoryEntry: vi.fn(),
  getDirectoryImportReconciliation: vi.fn(),
  getDirectoryImportResult: vi.fn(),
  getDirectoryImportRows: vi.fn(),
  getDirectoryImports: vi.fn(),
  getStoredAccessToken: vi.fn(() => "token"),
  reconcileDirectoryImport: vi.fn(),
  reanalyzeDirectoryImport: vi.fn(),
  updateDirectoryImport: vi.fn(),
  updateDirectoryImportMatch: vi.fn(),
  updateDirectoryImportRow: vi.fn(),
  uploadDirectoryImport: vi.fn(),
  validateDirectoryImport: vi.fn()
}));

vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return { ...actual, ...apiMocks };
});

const en = getDictionary("en");
const ru = getDictionary("ru");
const batch: DirectoryImportBatch = {
  id: "batch-1",
  original_filename: "directory.xlsx",
  file_type: "xlsx",
  file_sha256: "a".repeat(64),
  available_sheets: ["Contacts", "Archive"],
  selected_sheet: "Contacts",
  parser_mode: "table",
  column_mapping: { "0": "display_name", "1": "work_phone" },
  source_columns: [
    { index: 0, label: "Employee", samples: ["Test User"] },
    { index: 1, label: "Telephone", samples: ["3 11 11"] }
  ],
  status: "analyzed",
  total_source_rows: 4,
  detected_rows: 2,
  selected_rows: 1,
  warning_rows: 1,
  reconciliation_started_at: null,
  reconciled_at: null,
  execution_started_at: null,
  executed_at: null,
  execution_summary: null,
  execution_error: null,
  directory_snapshot_at: null,
  version: 1,
  created_by_user_id: "user-1",
  created_at: "2026-07-27T10:00:00Z",
  updated_at: "2026-07-27T10:00:00Z"
};
const previewRow: DirectoryImportRow = {
  id: "row-1",
  batch_id: batch.id,
  source_sheet: "Contacts",
  source_row_start: 2,
  source_row_end: 3,
  raw_cells: {
    rows: [
      { row: 2, cells: ["Senior", ""] },
      { row: 3, cells: ["Test User", "3 11 11"] }
    ]
  },
  detected_kind: "person",
  confidence: 0.88,
  normalized_data: {
    display_name: "Test User",
    position: "Senior",
    department: "IT",
    work_phone: "3 11 11",
    email: null
  },
  warnings: [{ code: "multiline_position", severity: "info" }],
  is_selected: true,
  proposed_action: "create",
  match_status: null,
  matched_entry_id: null,
  match_score: null,
  match_reasons: [],
  match_candidates: [],
  update_fields: [],
  restore_if_archived: false,
  expected_entry_updated_at: null,
  execution_status: "pending",
  result_entry_id: null,
  execution_error: null,
  sort_order: 0,
  created_at: "2026-07-27T10:00:00Z",
  updated_at: "2026-07-27T10:00:00Z"
};
const reconciledBatch: DirectoryImportBatch = {
  ...batch,
  status: "reconciled",
  reconciled_at: "2026-07-28T10:00:00Z",
  directory_snapshot_at: "2026-07-28T10:00:00Z",
  version: 2
};
const matchedRow: DirectoryImportRow = {
  ...previewRow,
  match_status: "exact",
  matched_entry_id: "11111111-1111-4111-8111-111111111111",
  match_score: 100,
  match_reasons: [
    { code: "exact_email", weight: 100 },
    { code: "exact_name", weight: 50 }
  ],
  match_candidates: [{
    id: "11111111-1111-4111-8111-111111111111",
    display_name: "Existing User",
    department: "IT",
    position: "Engineer",
    internal_phone: null,
    work_phone: "3 11 11",
    mobile_phone: null,
    email: "existing@example.test",
    room: "401",
    location: "HQ",
    is_active: true,
    updated_at: "2026-07-28T09:00:00Z",
    score: 100,
    reasons: [{ code: "exact_email", weight: 100 }]
  }],
  proposed_action: "update",
  update_fields: ["display_name", "position"],
  expected_entry_updated_at: "2026-07-28T09:00:00Z"
};
const validation = {
  create_count: 0,
  update_count: 1,
  restore_count: 0,
  skip_count: 0,
  blocking_count: 0,
  stale_count: 0,
  invalid_count: 0,
  duplicate_count: 0,
  can_execute: true,
  blocking_reasons: []
};
const completedResult = {
  batch_id: batch.id,
  status: "completed" as const,
  created: 0,
  updated: 1,
  restored: 0,
  skipped: 0,
  errors: 0,
  duration_ms: 42,
  result_entry_ids: ["11111111-1111-4111-8111-111111111111"],
  error_code: null
};

function renderWizard(onImported?: () => void) {
  return render(
    <DirectoryImportWizard dictionary={en} onClose={vi.fn()} onImported={onImported} />
  );
}

async function uploadValidFile(onImported?: () => void) {
  renderWizard(onImported);
  const file = new File(["xlsx-content"], "directory.xlsx", {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  });
  fireEvent.change(screen.getByLabelText(en.directoryImport.file), {
    target: { files: [file] }
  });
  fireEvent.change(screen.getByLabelText(en.directoryImport.parserMode), {
    target: { value: "table" }
  });
  fireEvent.click(screen.getByRole("button", { name: en.directoryImport.analyze }));
  await waitFor(() =>
    expect(apiMocks.uploadDirectoryImport).toHaveBeenCalledWith("token", file, "table")
  );
  await screen.findByText(batch.original_filename);
}

async function openReconciliation(onImported?: () => void) {
  await uploadValidFile(onImported);
  fireEvent.click(await screen.findByRole("button", { name: en.directoryImport.openPreview }));
  fireEvent.click(await screen.findByRole("button", { name: en.directoryImport.startReconciliation }));
  await screen.findByText(en.directoryImport.reconciliation.title);
}

describe("directory import wizard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMocks.getDirectoryImports.mockResolvedValue({ items: [], total: 0, page: 1, limit: 10 });
    apiMocks.uploadDirectoryImport.mockResolvedValue(batch);
    apiMocks.getDirectoryImportRows.mockResolvedValue({
      items: [previewRow],
      total: 1,
      page: 1,
      limit: 200
    });
    apiMocks.updateDirectoryImport.mockResolvedValue(batch);
    apiMocks.reanalyzeDirectoryImport.mockResolvedValue(batch);
    apiMocks.updateDirectoryImportRow.mockImplementation(
      async (_token, _batchId, _rowId, payload) => ({ ...previewRow, ...payload })
    );
    apiMocks.cancelDirectoryImport.mockResolvedValue({ ...batch, status: "cancelled" });
    apiMocks.reconcileDirectoryImport.mockResolvedValue(reconciledBatch);
    apiMocks.getDirectoryImportReconciliation.mockImplementation(
      async (_token, _batchId, _page, _limit, filter = "all") => ({
        items: filter === "all" || filter === matchedRow.match_status ? [matchedRow] : [],
        total: filter === "all" || filter === matchedRow.match_status ? 1 : 0,
        page: 1,
        limit: 200
      })
    );
    apiMocks.validateDirectoryImport.mockResolvedValue(validation);
    apiMocks.updateDirectoryImportMatch.mockImplementation(
      async (_token, _batchId, _rowId, payload) => ({ ...matchedRow, ...payload })
    );
    apiMocks.executeDirectoryImport.mockResolvedValue(completedResult);
    apiMocks.getDirectoryImportResult.mockResolvedValue(completedResult);
    apiMocks.getDirectoryEntry.mockResolvedValue({
      id: matchedRow.matched_entry_id,
      display_name: "Existing User",
      department: "IT",
      position: "Engineer",
      internal_phone: null,
      work_phone: "3 11 11",
      mobile_phone: null,
      email: "existing@example.test",
      room: "401",
      location: "HQ",
      notes: "Existing note",
      linked_user_id: null,
      linked_user: null,
      is_active: true,
      created_at: "2026-07-01T00:00:00Z",
      updated_at: "2026-07-28T09:00:00Z",
      created_by_user_id: null,
      updated_by_user_id: null
    });
  });

  it("validates file extension before upload", async () => {
    renderWizard();
    const file = new File(["text"], "directory.txt", { type: "text/plain" });
    fireEvent.change(screen.getByLabelText(en.directoryImport.file), {
      target: { files: [file] }
    });
    fireEvent.click(screen.getByRole("button", { name: en.directoryImport.analyze }));

    expect(await screen.findByText(en.directoryImport.errors.unsupportedFile)).toBeInTheDocument();
    expect(apiMocks.uploadDirectoryImport).not.toHaveBeenCalled();
  });

  it("uploads with selected parser mode and reports a readable failure", async () => {
    apiMocks.uploadDirectoryImport.mockRejectedValueOnce(new Error("backend detail"));
    renderWizard();
    const file = new File(["name,phone"], "directory.csv", { type: "text/csv" });
    fireEvent.change(screen.getByLabelText(en.directoryImport.file), {
      target: { files: [file] }
    });
    fireEvent.click(screen.getByRole("button", { name: en.directoryImport.analyze }));

    expect(await screen.findByText(en.directoryImport.errors.upload)).toBeInTheDocument();
    expect(screen.queryByText("backend detail")).not.toBeInTheDocument();
  });

  it("does not submit the same upload twice while the first request is pending", async () => {
    let resolveUpload: ((value: DirectoryImportBatch) => void) | undefined;
    apiMocks.uploadDirectoryImport.mockReturnValueOnce(
      new Promise<DirectoryImportBatch>((resolve) => {
        resolveUpload = resolve;
      })
    );
    renderWizard();
    const file = new File(["name,phone"], "directory.csv", { type: "text/csv" });
    fireEvent.change(screen.getByLabelText(en.directoryImport.file), {
      target: { files: [file] }
    });
    const analyze = screen.getByRole("button", { name: en.directoryImport.analyze });
    fireEvent.click(analyze);
    fireEvent.click(analyze);

    expect(apiMocks.uploadDirectoryImport).toHaveBeenCalledTimes(1);
    resolveUpload?.(batch);
    expect(await screen.findByText(batch.original_filename)).toBeInTheDocument();
  });

  it("keeps the upload step inside a responsive container and exposes long filenames", async () => {
    renderWizard();
    const file = new File(
      ["name,phone"],
      "a-very-long-corporate-directory-filename-that-must-not-expand-the-page.csv",
      { type: "text/csv" }
    );
    fireEvent.change(screen.getByLabelText(en.directoryImport.file), {
      target: { files: [file] }
    });

    expect(document.querySelector(".directory-import-backdrop")).toBeInTheDocument();
    expect(document.querySelector(".directory-import-wizard")).toBeInTheDocument();
    expect(screen.getByTitle(file.name)).toHaveTextContent(file.name);
    expect(document.querySelector(".directory-import-upload")).toBeInTheDocument();
    await waitFor(() => expect(apiMocks.getDirectoryImports).toHaveBeenCalled());
  });

  it("keeps async wizard state active after the StrictMode effect replay", async () => {
    apiMocks.getDirectoryImports.mockResolvedValue({
      items: [batch],
      total: 1,
      page: 1,
      limit: 10
    });

    render(
      <StrictMode>
        <DirectoryImportWizard dictionary={en} onClose={vi.fn()} />
      </StrictMode>
    );

    expect(await screen.findByText(en.directoryImport.recent)).toBeInTheDocument();
    expect(
      await screen.findByRole("button", { name: new RegExp(batch.original_filename) })
    ).toBeInTheDocument();
  });

  it("supports manual mapping and reanalysis", async () => {
    await uploadValidFile();
    expect(await screen.findByText(batch.original_filename)).toBeInTheDocument();

    fireEvent.change(
      screen.getByLabelText(
        en.directoryImport.mapping.column.replace("{column}", "Telephone")
      ),
      { target: { value: "internal_phone" } }
    );
    fireEvent.click(screen.getByRole("button", { name: en.directoryImport.reanalyze }));

    await waitFor(() =>
      expect(apiMocks.updateDirectoryImport).toHaveBeenCalledWith(
        "token",
        batch.id,
        expect.objectContaining({
          selected_sheet: "Contacts",
          column_mapping: expect.objectContaining({ "1": "internal_phone" })
        })
      )
    );
    expect(apiMocks.reanalyzeDirectoryImport).toHaveBeenCalledWith("token", batch.id);
    expect((await screen.findAllByText("Test User")).length).toBeGreaterThan(0);
  });

  it("clears stale mapping before analyzing another worksheet", async () => {
    apiMocks.reanalyzeDirectoryImport.mockResolvedValueOnce({
      ...batch,
      selected_sheet: "Archive",
      column_mapping: {},
      source_columns: []
    });
    await uploadValidFile();
    fireEvent.change(screen.getByLabelText(en.directoryImport.sheet), {
      target: { value: "Archive" }
    });
    fireEvent.click(screen.getByRole("button", { name: en.directoryImport.reanalyze }));

    await waitFor(() =>
      expect(apiMocks.updateDirectoryImport).toHaveBeenCalledWith(
        "token",
        batch.id,
        expect.objectContaining({
          selected_sheet: "Archive",
          column_mapping: {}
        })
      )
    );
  });

  it("shows the selected worksheet when it is the only replayable sheet", async () => {
    apiMocks.uploadDirectoryImport.mockResolvedValueOnce({
      ...batch,
      available_sheets: ["Contacts"]
    });

    await uploadValidFile();

    const worksheet = screen.getByLabelText(en.directoryImport.sheet);
    expect(worksheet).toHaveValue("Contacts");
    expect(worksheet).toBeDisabled();
  });

  it("renders preview, filters warnings and updates row selection", async () => {
    await uploadValidFile();
    fireEvent.click(await screen.findByRole("button", { name: en.directoryImport.openPreview }));
    expect(await screen.findAllByText("Test User")).not.toHaveLength(0);
    expect(screen.getAllByText(en.directoryImport.warningCodes.multiline_position)).not.toHaveLength(0);

    fireEvent.click(screen.getByLabelText(en.directoryImport.warningsOnly));
    await waitFor(() =>
      expect(apiMocks.getDirectoryImportRows).toHaveBeenLastCalledWith(
        "token",
        batch.id,
        true,
        1,
        200
      )
    );

    fireEvent.click(
      screen.getAllByLabelText(
        en.directoryImport.preview.selectRow.replace("{row}", "2-3")
      )[0]
    );
    await waitFor(() =>
      expect(apiMocks.updateDirectoryImportRow).toHaveBeenCalledWith(
        "token",
        batch.id,
        previewRow.id,
        expect.objectContaining({ is_selected: false, proposed_action: "skip" })
      )
    );
  });

  it("renders a compact desktop preview and omits empty normalized fields", async () => {
    await uploadValidFile();
    fireEvent.click(await screen.findByRole("button", { name: en.directoryImport.openPreview }));

    const table = await screen.findByRole("table");
    expect(within(table).getAllByRole("columnheader")).toHaveLength(7);
    expect(
      within(table).queryByRole("columnheader", { name: en.directory.fields.displayName })
    ).not.toBeInTheDocument();
    expect(within(table).getByText("Test User")).toBeInTheDocument();
    expect(within(table).getByText(`${en.directory.fields.workPhone}: 3 11 11`)).toBeInTheDocument();
    expect(screen.queryByText(en.directoryImport.empty)).not.toBeInTheDocument();
  });

  it("summarizes warnings with two badges and a remaining count", async () => {
    const rowWithWarnings = {
      ...previewRow,
      warnings: [
        { code: "multiline_position", severity: "info" as const },
        { code: "phone_type_uncertain", severity: "warning" as const },
        { code: "multiple_phone_values", severity: "warning" as const }
      ]
    };
    apiMocks.getDirectoryImportRows.mockResolvedValue({
      items: [rowWithWarnings],
      total: 1,
      page: 1,
      limit: 200
    });

    await uploadValidFile();
    fireEvent.click(await screen.findByRole("button", { name: en.directoryImport.openPreview }));
    await screen.findByRole("table");

    expect(screen.getAllByText("+1")).toHaveLength(2);
    expect(
      screen.getAllByLabelText(en.directoryImport.moreWarnings.replace("{count}", "1"))
    ).toHaveLength(2);
  });

  it("keeps blocking rows unavailable for selection", async () => {
    apiMocks.getDirectoryImportRows.mockResolvedValue({
      items: [{
        ...previewRow,
        is_selected: false,
        proposed_action: "skip",
        warnings: [{ code: "missing_display_name", severity: "blocking" }]
      }],
      total: 1,
      page: 1,
      limit: 200
    });

    await uploadValidFile();
    fireEvent.click(await screen.findByRole("button", { name: en.directoryImport.openPreview }));
    await screen.findByRole("table");

    const rowSelectors = screen.getAllByRole("checkbox").filter((element) =>
      element.getAttribute("aria-label")?.includes("2-3") ||
      element.closest(".directory-import-card")
    );
    expect(rowSelectors).toHaveLength(2);
    rowSelectors.forEach((selector) => expect(selector).toBeDisabled());
  });

  it("edits normalized fields, record type and exposes raw cells", async () => {
    await uploadValidFile();
    fireEvent.click(await screen.findByRole("button", { name: en.directoryImport.openPreview }));
    fireEvent.click((await screen.findAllByRole("button", { name: en.directoryImport.openDetails }))[0]);

    const editor = screen.getByText(en.directoryImport.rawCells).closest(".directory-import-row-editor");
    expect(editor).not.toBeNull();
    const scope = within(editor as HTMLElement);
    fireEvent.change(scope.getByLabelText(en.directoryImport.preview.kind), {
      target: { value: "role" }
    });
    fireEvent.change(scope.getByLabelText(en.directory.fields.displayName), {
      target: { value: "Shared role" }
    });
    fireEvent.click(scope.getByText(en.directoryImport.rawCells));
    expect(scope.getByText(/Test User/)).toBeInTheDocument();
    fireEvent.click(scope.getByRole("button", { name: en.directoryImport.saveRow }));

    await waitFor(() =>
      expect(apiMocks.updateDirectoryImportRow).toHaveBeenCalledWith(
        "token",
        batch.id,
        previewRow.id,
        expect.objectContaining({
          detected_kind: "role",
          normalized_data: expect.objectContaining({ display_name: "Shared role" })
        })
      )
    );
  });

  it("validates and saves the selected row in one detail drawer", async () => {
    await uploadValidFile();
    fireEvent.click(await screen.findByRole("button", { name: en.directoryImport.openPreview }));
    fireEvent.click((await screen.findAllByRole("button", { name: en.directoryImport.openDetails }))[0]);

    const dialog = screen.getByRole("dialog", { name: en.directoryImport.detailsTitle });
    const scope = within(dialog);
    expect(scope.getByText("2-3")).toBeInTheDocument();
    expect(scope.getByText("88%")).toBeInTheDocument();
    const displayName = scope.getByLabelText(en.directory.fields.displayName);
    fireEvent.change(displayName, { target: { value: "" } });
    fireEvent.click(scope.getByRole("button", { name: en.directoryImport.saveRow }));
    expect(await scope.findByText(en.directoryImport.errors.displayNameRequired)).toBeInTheDocument();
    expect(apiMocks.updateDirectoryImportRow).not.toHaveBeenCalled();

    fireEvent.change(displayName, { target: { value: "Updated User" } });
    fireEvent.click(scope.getByRole("button", { name: en.directoryImport.saveRow }));
    await waitFor(() =>
      expect(apiMocks.updateDirectoryImportRow).toHaveBeenCalledWith(
        "token",
        batch.id,
        previewRow.id,
        expect.objectContaining({
          normalized_data: expect.objectContaining({ display_name: "Updated User" })
        })
      )
    );
    expect(screen.queryByRole("dialog", { name: en.directoryImport.detailsTitle })).not.toBeInTheDocument();
    expect(screen.getAllByText("Updated User").length).toBeGreaterThan(0);
  });

  it("renders raw source values as text and closes the detail drawer with Escape", async () => {
    apiMocks.getDirectoryImportRows.mockResolvedValue({
      items: [{
        ...previewRow,
        raw_cells: {
          rows: [{ row: 2, cells: ['<img src="x" onerror="alert(1)">'] }]
        }
      }],
      total: 1,
      page: 1,
      limit: 200
    });
    await uploadValidFile();
    fireEvent.click(await screen.findByRole("button", { name: en.directoryImport.openPreview }));
    fireEvent.click((await screen.findAllByRole("button", { name: en.directoryImport.openDetails }))[0]);
    fireEvent.click(screen.getByText(en.directoryImport.rawCells));

    expect(screen.getByText(/<img src=/)).toBeInTheDocument();
    expect(document.querySelector(".directory-import-raw img")).not.toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: en.directoryImport.detailsTitle })).not.toBeInTheDocument();
  });

  it("warns before reanalysis would replace manual row changes", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    await uploadValidFile();
    fireEvent.click(await screen.findByRole("button", { name: en.directoryImport.openPreview }));
    fireEvent.click((await screen.findAllByRole("button", { name: en.directoryImport.openDetails }))[0]);
    const editor = screen.getByText(en.directoryImport.rawCells).closest(".directory-import-row-editor");
    const scope = within(editor as HTMLElement);
    fireEvent.change(scope.getByLabelText(en.directory.fields.displayName), {
      target: { value: "Changed User" }
    });
    fireEvent.click(scope.getByRole("button", { name: en.directoryImport.saveRow }));
    await waitFor(() => expect(apiMocks.updateDirectoryImportRow).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: en.directoryImport.backToMapping }));
    fireEvent.click(screen.getByRole("button", { name: en.directoryImport.reanalyze }));

    expect(confirm).toHaveBeenCalledWith(en.directoryImport.reanalyzeConfirm);
    expect(apiMocks.updateDirectoryImport).not.toHaveBeenCalled();
    expect(apiMocks.reanalyzeDirectoryImport).not.toHaveBeenCalled();
  });

  it("renders reconciliation counts, filters and deterministic match reasons", async () => {
    await openReconciliation();

    expect(apiMocks.reconcileDirectoryImport).toHaveBeenCalledWith("token", batch.id);
    expect(apiMocks.getDirectoryImportReconciliation).toHaveBeenCalledWith(
      "token",
      batch.id,
      1,
      200,
      "all"
    );
    expect(screen.getAllByText(en.directoryImport.matchStatuses.exact).length).toBeGreaterThan(1);
    expect(screen.getAllByText(en.directoryImport.matchReasons.exact_email).length).toBeGreaterThan(0);
    expect(document.querySelector(".directory-import-reconciliation-summary")).toHaveTextContent(
      `${en.directoryImport.reconciliation.update}: 1`
    );

    fireEvent.click(screen.getByRole("button", { name: en.directoryImport.matchStatuses.unmatched }));
    expect(await screen.findByText(en.directoryImport.reconciliation.empty)).toBeInTheDocument();
    expect(apiMocks.getDirectoryImportReconciliation).toHaveBeenLastCalledWith(
      "token",
      batch.id,
      1,
      200,
      "unmatched"
    );
  });

  it("selects a candidate and explicit non-empty update fields", async () => {
    await openReconciliation();
    fireEvent.click(screen.getAllByRole("button", { name: en.directoryImport.reconciliation.compare })[0]);
    const dialog = screen.getByRole("dialog", { name: en.directoryImport.detailsTitle });
    const scope = within(dialog);

    expect(scope.getAllByText("Existing User").length).toBeGreaterThan(0);
    const position = scope.getByLabelText(
      en.directoryImport.reconciliation.applyField.replace(
        "{field}",
        en.directory.fields.position
      )
    );
    fireEvent.click(position);
    fireEvent.click(scope.getByRole("button", { name: en.directoryImport.reconciliation.save }));

    await waitFor(() =>
      expect(apiMocks.updateDirectoryImportMatch).toHaveBeenCalledWith(
        "token",
        batch.id,
        matchedRow.id,
        expect.objectContaining({
          proposed_action: "update",
          matched_entry_id: matchedRow.matched_entry_id,
          update_fields: ["display_name"],
          version: 2
        })
      )
    );
  });

  it("requires final confirmation and blocks a duplicate execute submission", async () => {
    let resolveExecution: ((value: typeof completedResult) => void) | undefined;
    apiMocks.executeDirectoryImport.mockReturnValueOnce(
      new Promise<typeof completedResult>((resolve) => {
        resolveExecution = resolve;
      })
    );
    await openReconciliation();
    fireEvent.click(screen.getByRole("button", { name: en.directoryImport.reconciliation.continue }));
    await screen.findByText(en.directoryImport.confirmation.title);

    const execute = screen.getByRole("button", { name: en.directoryImport.confirmation.execute });
    expect(execute).toBeDisabled();
    fireEvent.click(screen.getByLabelText(en.directoryImport.confirmation.checkbox));
    fireEvent.click(execute);
    fireEvent.click(execute);
    expect(apiMocks.executeDirectoryImport).toHaveBeenCalledTimes(1);

    resolveExecution?.(completedResult);
    expect(await screen.findByText(en.directoryImport.result.success)).toBeInTheDocument();
    expect(screen.getByText(en.directoryImport.result.updated).nextSibling).toHaveTextContent("1");
  });

  it("shows the atomic rollback result after an execution failure", async () => {
    apiMocks.executeDirectoryImport.mockRejectedValueOnce(new Error("network"));
    apiMocks.getDirectoryImportResult.mockResolvedValueOnce({
      ...completedResult,
      status: "failed",
      updated: 0,
      errors: 1,
      result_entry_ids: [],
      error_code: "execution_failed"
    });
    await openReconciliation();
    fireEvent.click(screen.getByRole("button", { name: en.directoryImport.reconciliation.continue }));
    fireEvent.click(await screen.findByLabelText(en.directoryImport.confirmation.checkbox));
    fireEvent.click(screen.getByRole("button", { name: en.directoryImport.confirmation.execute }));

    expect(await screen.findByText(en.directoryImport.result.failed)).toBeInTheDocument();
    expect(screen.getByText(en.directoryImport.result.rollbackDescription)).toBeInTheDocument();
  });

  it("returns stale execution conflicts to reconciliation", async () => {
    apiMocks.executeDirectoryImport.mockRejectedValueOnce(
      new ApiResponseError(409, "stale_match")
    );
    await openReconciliation();
    fireEvent.click(screen.getByRole("button", { name: en.directoryImport.reconciliation.continue }));
    fireEvent.click(await screen.findByLabelText(en.directoryImport.confirmation.checkbox));
    fireEvent.click(screen.getByRole("button", { name: en.directoryImport.confirmation.execute }));

    expect(await screen.findByText(en.directoryImport.errors.stale)).toBeInTheDocument();
    expect(screen.getByText(en.directoryImport.reconciliation.title)).toBeInTheDocument();
    expect(apiMocks.getDirectoryImportResult).not.toHaveBeenCalled();
  });

  it("warns before leaving only while execution is pending", async () => {
    let resolveExecution: ((value: typeof completedResult) => void) | undefined;
    apiMocks.executeDirectoryImport.mockReturnValueOnce(
      new Promise<typeof completedResult>((resolve) => {
        resolveExecution = resolve;
      })
    );
    await openReconciliation();
    fireEvent.click(screen.getByRole("button", { name: en.directoryImport.reconciliation.continue }));
    fireEvent.click(await screen.findByLabelText(en.directoryImport.confirmation.checkbox));
    fireEvent.click(screen.getByRole("button", { name: en.directoryImport.confirmation.execute }));

    const pendingExit = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(pendingExit);
    expect(pendingExit.defaultPrevented).toBe(true);

    resolveExecution?.(completedResult);
    await screen.findByText(en.directoryImport.result.success);
    const completedExit = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(completedExit);
    expect(completedExit.defaultPrevented).toBe(false);
  });

  it("does not offer whitespace-only imported fields for update", async () => {
    const whitespaceRow = {
      ...matchedRow,
      normalized_data: {
        ...matchedRow.normalized_data,
        position: " \t\n"
      },
      update_fields: ["display_name"]
    };
    apiMocks.getDirectoryImportReconciliation.mockResolvedValue({
      items: [whitespaceRow],
      total: 1,
      page: 1,
      limit: 200
    });
    await openReconciliation();
    fireEvent.click(screen.getAllByRole("button", { name: en.directoryImport.reconciliation.compare })[0]);
    await waitFor(() => expect(apiMocks.getDirectoryEntry).toHaveBeenCalled());

    expect(
      within(
        screen.getByRole("dialog", { name: en.directoryImport.detailsTitle })
      ).queryByLabelText(
        en.directoryImport.reconciliation.applyField.replace(
          "{field}",
          en.directory.fields.position
        )
      )
    ).not.toBeInTheDocument();
  });

  it("refreshes the directory when a network retry discovers a completed result", async () => {
    const onImported = vi.fn();
    apiMocks.executeDirectoryImport.mockRejectedValueOnce(new Error("network"));
    await openReconciliation(onImported);
    fireEvent.click(screen.getByRole("button", { name: en.directoryImport.reconciliation.continue }));
    fireEvent.click(await screen.findByLabelText(en.directoryImport.confirmation.checkbox));
    fireEvent.click(screen.getByRole("button", { name: en.directoryImport.confirmation.execute }));

    expect(await screen.findByText(en.directoryImport.result.success)).toBeInTheDocument();
    expect(apiMocks.getDirectoryImportResult).toHaveBeenCalledWith("token", batch.id);
    expect(onImported).toHaveBeenCalledTimes(1);
  });

  it("cancels the preview and has no DirectoryEntry execution action", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    await uploadValidFile();
    fireEvent.click(await screen.findByRole("button", { name: en.directoryImport.cancelBatch }));
    await waitFor(() =>
      expect(apiMocks.cancelDirectoryImport).toHaveBeenCalledWith("token", batch.id)
    );
    expect(screen.queryByRole("button", { name: /execute import/i })).not.toBeInTheDocument();
  });

  it("renders both desktop table and mobile card markup", async () => {
    await uploadValidFile();
    fireEvent.click(await screen.findByRole("button", { name: en.directoryImport.openPreview }));
    expect(await screen.findByRole("table")).toBeInTheDocument();
    expect(document.querySelector(".directory-import-card")).toBeInTheDocument();
  });

  it("paginates large previews through the backend", async () => {
    apiMocks.getDirectoryImportRows.mockImplementation(
      async (_token, _batchId, _warningsOnly, page = 1) => ({
        items: [previewRow],
        total: 201,
        page,
        limit: 200
      })
    );
    await uploadValidFile();
    fireEvent.click(await screen.findByRole("button", { name: en.directoryImport.openPreview }));
    fireEvent.click(await screen.findByRole("button", { name: en.directoryImport.next }));

    await waitFor(() =>
      expect(apiMocks.getDirectoryImportRows).toHaveBeenCalledWith(
        "token",
        batch.id,
        false,
        2,
        200
      )
    );
  });

  it("provides equivalent RU and EN localization keys", () => {
    expect(en.directoryImport.open).toBeTruthy();
    expect(ru.directoryImport.open).toBeTruthy();
    expect(en.directoryImport.warningCodes.missing_display_name).toBeTruthy();
    expect(ru.directoryImport.warningCodes.missing_display_name).toBeTruthy();
    expect(en.directoryImport.warningCodes.phone_type_uncertain).toBeTruthy();
    expect(ru.directoryImport.warningCodes.phone_type_uncertain).toBeTruthy();
    expect(en.directoryImport.openDetails).toBeTruthy();
    expect(ru.directoryImport.openDetails).toBeTruthy();
    expect(en.directoryImport.errors.displayNameRequired).toBeTruthy();
    expect(ru.directoryImport.errors.displayNameRequired).toBeTruthy();
    expect(en.directoryImport.reconciliation.title).toBeTruthy();
    expect(ru.directoryImport.reconciliation.title).toBeTruthy();
    expect(en.directoryImport.confirmation.checkbox).toBeTruthy();
    expect(ru.directoryImport.confirmation.checkbox).toBeTruthy();
    expect(en.directoryImport.errors.stale).toBeTruthy();
    expect(ru.directoryImport.errors.stale).toBeTruthy();
  });
});
