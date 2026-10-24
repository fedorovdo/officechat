"use client";

import { useEffect, useRef } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import { Slice } from "@tiptap/pm/model";
import StarterKit from "@tiptap/starter-kit";
import TextAlign from "@tiptap/extension-text-align";
import { FontSize, TextStyle } from "@tiptap/extension-text-style";
import type { Dictionary } from "../lib/i18n";
import { announcementText, plainAnnouncementDocument, type AnnouncementNode } from "../lib/announcement-document";

// Do not import links, images, raw HTML, code or arbitrary CSS into announcements.
const extensions = [
  StarterKit.configure({ blockquote: false, code: false, codeBlock: false, heading: false,
    horizontalRule: false, link: false, strike: false, trailingNode: false }),
  TextAlign.configure({ types: ["paragraph"], alignments: ["left", "center", "right"] }),
  TextStyle,
  FontSize
];

export function AnnouncementEditor({ body, document, label, t, disabled = false, onChange }: {
  body: string; document: AnnouncementNode | null; label: string;
  t: Dictionary["announcements"]["editor"]; disabled?: boolean;
  onChange: (body: string, document: AnnouncementNode) => void;
}) {
  const changed = useRef(onChange);
  changed.current = onChange;
  const editor = useEditor({
    extensions, immediatelyRender: false, shouldRerenderOnTransaction: true,
    content: document ?? plainAnnouncementDocument(body),
    onUpdate: ({ editor }) => {
      const doc = editor.getJSON() as AnnouncementNode;
      changed.current(announcementText(doc), doc);
    },
    editorProps: {
      attributes: { role: "textbox", "aria-label": label, "aria-multiline": "true", class: "announcement-editor-input" },
      handlePaste: (view, event) => {
        event.preventDefault();
        const text = event.clipboardData?.getData("text/plain") ?? "";
        const doc = plainAnnouncementDocument(text.replace(/\r\n?/g, "\n"));
        const fragment = view.state.schema.nodeFromJSON(doc).content;
        view.dispatch(view.state.tr.replaceSelection(new Slice(fragment, 0, 0)).scrollIntoView());
        return true;
      },
      handleDrop: (_view, event) => { event.preventDefault(); return true; }
    }
  });

  useEffect(() => {
    if (!editor) return;
    const next = document ?? plainAnnouncementDocument(body);
    if (JSON.stringify(editor.getJSON()) !== JSON.stringify(next)) {
      editor.commands.setContent(next, { emitUpdate: false });
    }
  }, [editor, body, document]);
  useEffect(() => { editor?.setEditable(!disabled, false); }, [editor, disabled]);

  if (!editor) return <p className="muted">{t.loading}</p>;
  const button = (name: string, active: boolean, action: () => void) => (
    <button type="button" disabled={disabled} aria-label={name} title={name} aria-pressed={active}
      onMouseDown={event => event.preventDefault()} onClick={action}>{name}</button>
  );
  return <div className="announcement-editor">
    <div className="announcement-editor-toolbar" role="toolbar" aria-label={t.toolbar}>
      {button(t.bold, editor.isActive("bold"), () => editor.chain().focus().toggleBold().run())}
      {button(t.italic, editor.isActive("italic"), () => editor.chain().focus().toggleItalic().run())}
      {button(t.underline, editor.isActive("underline"), () => editor.chain().focus().toggleUnderline().run())}
      <label>{t.size}<select disabled={disabled} aria-label={t.size} value={editor.getAttributes("textStyle").fontSize ?? "14px"}
        onChange={event => editor.chain().focus().setFontSize(event.target.value).run()}>
        <option value="14px">{t.normal}</option><option value="18px">{t.large}</option><option value="24px">{t.larger}</option>
      </select></label>
      {(["left", "center", "right"] as const).map(align => <span key={align}>{button(t[align], editor.isActive({ textAlign: align }), () => editor.chain().focus().setTextAlign(align).run())}</span>)}
      {button(t.bullets, editor.isActive("bulletList"), () => editor.chain().focus().toggleBulletList().run())}
      {button(t.numbers, editor.isActive("orderedList"), () => editor.chain().focus().toggleOrderedList().run())}
      {button(t.clear, false, () => editor.chain().focus().unsetAllMarks().clearNodes().unsetTextAlign().run())}
      {button(t.undo, false, () => editor.chain().focus().undo().run())}
      {button(t.redo, false, () => editor.chain().focus().redo().run())}
    </div>
    <EditorContent editor={editor} />
    <small className={body.length > 10000 ? "form-error" : "muted"}>{body.length}/10000</small>
  </div>;
}
