import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AnnouncementEditor } from "../components/AnnouncementEditor";
import { getDictionary } from "../lib/i18n";
import { plainAnnouncementDocument } from "../lib/announcement-document";

const t = getDictionary("ru").announcements.editor;

describe("real announcement editor", () => {
  it("loads and replaces formatting even when template text is identical", async () => {
    const onChange = vi.fn();
    const doc = plainAnnouncementDocument("Сегодня вода");
    const props = { body: "Сегодня вода", document: doc, label: "Сообщение", t, onChange };
    const view = render(<AnnouncementEditor {...props} />);
    await screen.findByRole("textbox", { name: "Сообщение" });
    const formatted = structuredClone(doc);
    formatted.content![0].attrs = { textAlign: "center" };
    formatted.content![0].content![0].marks = [{ type: "bold" }];
    view.rerender(<AnnouncementEditor {...props} document={formatted} />);
    await waitFor(() => expect(view.container.querySelector(".tiptap strong")).toHaveTextContent("Сегодня вода"));
    expect(view.container.querySelector(".tiptap p")).toHaveStyle({ textAlign: "center" });
    expect(onChange).not.toHaveBeenCalled();
  });
  it("blocks clipboard HTML and retains multiline plain text", async () => {
    const onChange = vi.fn();
    render(<AnnouncementEditor body="" document={null} label="Сообщение" t={t} onChange={onChange} />);
    const input = await screen.findByRole("textbox", { name: "Сообщение" });
    fireEvent.paste(input, { clipboardData: { getData: (type: string) => type === "text/plain" ? "Сегодня\nВода" : '<img src=x onerror="alert(1)">' } });
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(onChange.mock.lastCall?.[0].trim()).toBe("Сегодня\nВода");
    expect(input.querySelector("img")).toBeNull();
  });
});
