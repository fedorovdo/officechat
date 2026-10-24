import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AnnouncementTemplates } from "../components/AnnouncementTemplates";
import { AnnouncementBody } from "../components/AnnouncementBody";
import { getDictionary } from "../lib/i18n";
import { plainAnnouncementDocument, announcementText } from "../lib/announcement-document";

const api = vi.hoisted(() => ({ getBroadcastTemplates: vi.fn(), createBroadcastTemplate: vi.fn(),
  updateBroadcastTemplate: vi.fn(), deleteBroadcastTemplate: vi.fn() }));
vi.mock("../lib/api", async original => ({ ...await original<typeof import("../lib/api")>(), ...api }));
vi.mock("../components/AnnouncementEditor", () => ({ AnnouncementEditor: ({ body, label, onChange }: any) =>
  <textarea aria-label={label} value={body} onChange={event => onChange(event.target.value, plainAnnouncementDocument(event.target.value))} /> }));
const dictionary = getDictionary("ru");
const t = dictionary.announcements.templates;
const own = { id: "own", created_by_user_id: "author", created_by_display_name: "Автор", name: "Вода", title: "Привоз",
  body: "Сегодня привоз воды", body_doc: plainAnnouncementDocument("Сегодня привоз воды"), priority: "normal" as const,
  created_at: "2026-10-14T10:00:00Z", updated_at: "2026-10-14T10:00:00Z" };
const other = { ...own, id: "other", created_by_user_id: "other-author", name: "Обед" };
const draft = { title: "Завтра", body: "Вода завтра", body_doc: plainAnnouncementDocument("Вода завтра"), priority: "important" as const };
function panel(onUse = vi.fn()) {
  return render(<AnnouncementTemplates userId="author" dictionary={dictionary} getToken={() => "token"} draft={draft} disabled={false} onUse={onUse} />);
}

describe("announcement templates", () => {
  beforeEach(() => {
    api.getBroadcastTemplates.mockResolvedValue({ items: [own, other], page: 1, limit: 20, total: 2 });
    api.createBroadcastTemplate.mockResolvedValue(own);
    api.updateBroadcastTemplate.mockResolvedValue(own);
    api.deleteBroadcastTemplate.mockResolvedValue(undefined);
  });
  it("offers everyone's templates but only the author's mutation controls", async () => {
    const use = vi.fn(); panel(use);
    const row = (await screen.findByText("Обед")).closest(".announcement-template-item") as HTMLElement;
    expect(within(row).queryByRole("button", { name: t.edit })).toBeNull();
    expect(within(row).queryByRole("button", { name: t.delete })).toBeNull();
    fireEvent.click(within(row).getByRole("button", { name: t.use }));
    expect(use).toHaveBeenCalledWith(other);
    expect(screen.getAllByRole("button", { name: t.edit })).toHaveLength(1);
  });
  it("saves the draft as a named template without audience or owner fields", async () => {
    panel(); await screen.findByText("Вода");
    fireEvent.change(screen.getByLabelText(t.name), { target: { value: "Повтор воды" } });
    fireEvent.click(screen.getByRole("button", { name: t.saveNew }));
    await waitFor(() => expect(api.createBroadcastTemplate).toHaveBeenCalledWith("token", { name: "Повтор воды", ...draft }));
    expect(await screen.findByText(t.saved)).toBeInTheDocument();
  });
  it("edits in a separate form and deletes only after confirmation", async () => {
    panel(); await screen.findByText("Вода");
    fireEvent.click(screen.getByRole("button", { name: t.edit }));
    fireEvent.change(screen.getByLabelText(dictionary.announcements.fields.title), { target: { value: "Завтра привоз" } });
    fireEvent.click(screen.getByRole("button", { name: t.save }));
    await waitFor(() => expect(api.updateBroadcastTemplate).toHaveBeenCalledWith("token", "own", expect.objectContaining({ title: "Завтра привоз" })));
    fireEvent.click(screen.getByRole("button", { name: t.delete }));
    expect(api.deleteBroadcastTemplate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: t.confirmDelete }));
    await waitFor(() => expect(api.deleteBroadcastTemplate).toHaveBeenCalledWith("token", "own"));
  });
});

describe("announcement display", () => {
  it("renders legacy text literally and retains line breaks", () => {
    const { container } = render(<AnnouncementBody body={'<img src=x onerror=alert(1)>\nВода'} />);
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("<img src=x onerror=alert(1)>");
  });
  it("renders alignment and marks through React without arbitrary markup", () => {
    const doc = plainAnnouncementDocument("Вода");
    doc.content![0].attrs = { textAlign: "center" };
    doc.content![0].content![0].marks = [{ type: "bold" }, { type: "textStyle", attrs: { fontSize: "24px" } }];
    const { container } = render(<AnnouncementBody body="Вода" document={doc} />);
    expect(container.querySelector("p")).toHaveStyle({ textAlign: "center" });
    expect(container.querySelector("strong")).toHaveTextContent("Вода");
    expect(container.querySelector('[style*="24px"]')).toBeTruthy();
    expect(announcementText(doc)).toBe("Вода");
  });
});
