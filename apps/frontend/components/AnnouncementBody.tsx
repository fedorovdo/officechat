import type { ReactNode } from "react";
import type { AnnouncementNode } from "../lib/announcement-document";

function renderNode(node: AnnouncementNode, key: number): ReactNode {
  const content = (node.content ?? []).map(renderNode);
  if (node.type === "text") {
    let result: ReactNode = node.text ?? "";
    for (const mark of node.marks ?? []) {
      if (mark.type === "bold") result = <strong>{result}</strong>;
      if (mark.type === "italic") result = <em>{result}</em>;
      if (mark.type === "underline") result = <u>{result}</u>;
      if (mark.type === "textStyle" && ["14px", "18px", "24px"].includes(String(mark.attrs?.fontSize))) {
        result = <span style={{ fontSize: String(mark.attrs?.fontSize) }}>{result}</span>;
      }
    }
    return <span key={key}>{result}</span>;
  }
  if (node.type === "paragraph") {
    const align = node.attrs?.textAlign;
    return <p key={key} style={{ textAlign: align === "center" || align === "right" ? align : "left" }}>{content.length ? content : <br />}</p>;
  }
  if (node.type === "hardBreak") return <br key={key} />;
  if (node.type === "bulletList") return <ul key={key}>{content}</ul>;
  if (node.type === "orderedList") return <ol key={key} start={Number(node.attrs?.start) || 1}>{content}</ol>;
  if (node.type === "listItem") return <li key={key}>{content}</li>;
  if (node.type === "doc") return <div key={key}>{content}</div>;
  return null;
}

export function AnnouncementBody({ body, document }: { body: string; document?: AnnouncementNode | null }) {
  return <div className="announcement-body">{document ? renderNode(document, 0) : <div className="announcement-plain-text">{body}</div>}</div>;
}
