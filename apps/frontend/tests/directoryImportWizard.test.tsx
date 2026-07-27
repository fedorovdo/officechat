import { StrictMode } from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DirectoryImportWizard } from "../components/DirectoryImportWizard";
import { getDictionary } from "../lib/i18n";
import type { DirectoryImportBatch, DirectoryImportRow } from "../lib/api";

const apiMocks = vi.hoisted(() => ({
  cancelDirectoryImport: vi.fn(),
  getDirectoryImportRows: vi.fn(),
  getDirectoryImports: vi.fn(),
  getStoredAccessToken: vi.fn(() => "token"),
  reanalyzeDirectoryImport: vi.fn(),
  updateDirectoryImport: vi.fn(),
  updateDirectoryImportRow: vi.fn(),
  uploadDirectoryImport: vi.fn()
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
  sort_order: 0,
  created_at: "2026-07-27T10:00:00Z",
  updated_at: "2026-07-27T10:00:00Z"
};

function renderWizard() {
  return render(<DirectoryImportWizard dictionary={en} onClose={vi.fn()} />);
}

async function uploadValidFile() {
  renderWizard();
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

  it("edits normalized fields, record type and exposes raw cells", async () => {
    await uploadValidFile();
    fireEvent.click(await screen.findByRole("button", { name: en.directoryImport.openPreview }));
    fireEvent.click((await screen.findAllByRole("button", { name: en.directoryImport.editRow }))[0]);

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

  it("warns before reanalysis would replace manual row changes", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    await uploadValidFile();
    fireEvent.click(await screen.findByRole("button", { name: en.directoryImport.openPreview }));
    fireEvent.click((await screen.findAllByRole("button", { name: en.directoryImport.editRow }))[0]);
    const editor = screen.getByText(en.directoryImport.rawCells).closest(".directory-import-row-editor");
    const scope = within(editor as HTMLElement);
    fireEvent.change(scope.getByLabelText(en.directory.fields.displayName), {
      target: { value: "Changed User" }
    });
    fireEvent.click(scope.getByRole("button", { name: en.directoryImport.saveRow }));
    await waitFor(() => expect(apiMocks.updateDirectoryImportRow).toHaveBeenCalled());
    fireEvent.click(
      scope.getAllByRole("button", { name: en.directoryImport.close })[0]
    );
    fireEvent.click(screen.getByRole("button", { name: en.directoryImport.backToMapping }));
    fireEvent.click(screen.getByRole("button", { name: en.directoryImport.reanalyze }));

    expect(confirm).toHaveBeenCalledWith(en.directoryImport.reanalyzeConfirm);
    expect(apiMocks.updateDirectoryImport).not.toHaveBeenCalled();
    expect(apiMocks.reanalyzeDirectoryImport).not.toHaveBeenCalled();
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
  });
});
