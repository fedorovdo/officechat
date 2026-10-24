export type AnnouncementNode = {
  type: string;
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: Array<{ type: string; attrs?: Record<string, unknown> }>;
  content?: AnnouncementNode[];
};

export function announcementText(node: AnnouncementNode): string {
  if (node.type === "text") return node.text ?? "";
  if (node.type === "hardBreak") return "\n";
  return (node.content ?? []).map(announcementText).join(node.type === "paragraph" ? "" : "\n");
}

export function plainAnnouncementDocument(text: string): AnnouncementNode {
  return { type: "doc", content: text.split("\n").map(line => ({
    type: "paragraph", ...(line ? { content: [{ type: "text", text: line }] } : {})
  })) };
}
