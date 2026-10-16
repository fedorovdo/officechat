"""Bounded, allow-listed editor document; never accept arbitrary HTML or CSS."""
import json


def validate_document(document: dict) -> dict:
    try:
        size = len(json.dumps(document, ensure_ascii=False))
    except (RecursionError, TypeError) as exc:
        raise ValueError("Invalid announcement document") from exc
    if size > 100000:
        raise ValueError("Announcement formatting is too large")
    count = 0

    def visit(node, depth=0):
        nonlocal count
        count += 1
        if depth > 8 or count > 2000 or not isinstance(node, dict):
            raise ValueError("Invalid announcement document")
        kind = node.get("type")
        fields = {
            "doc": {"type", "content"},
            "paragraph": {"type", "attrs", "content"},
            "text": {"type", "text", "marks"},
            "hardBreak": {"type"},
            "bulletList": {"type", "content"},
            "orderedList": {"type", "attrs", "content"},
            "listItem": {"type", "content"},
        }
        if not isinstance(kind, str) or kind not in fields or not set(node) <= fields[kind]:
            raise ValueError("Unsupported announcement formatting")
        attrs = node.get("attrs", {})
        if not isinstance(attrs, dict):
            raise ValueError("Invalid document attributes")
        if kind == "paragraph":
            if not set(attrs) <= {"textAlign"} or attrs.get("textAlign") not in (None, "left", "center", "right"):
                raise ValueError("Invalid text alignment")
        elif kind == "orderedList":
            if not set(attrs) <= {"start", "type"} or attrs.get("type") is not None:
                raise ValueError("Invalid list attributes")
            start = attrs.get("start", 1)
            if type(start) is not int or not 1 <= start <= 10000:
                raise ValueError("Invalid list start")
        elif attrs:
            raise ValueError("Unexpected document attributes")
        if kind == "text":
            text = node.get("text")
            if not isinstance(text, str) or not 1 <= len(text) <= 10000:
                raise ValueError("Invalid formatted text")
            marks = node.get("marks", [])
            if not isinstance(marks, list) or len(marks) > 4:
                raise ValueError("Invalid text marks")
            seen = set()
            for mark in marks:
                if not isinstance(mark, dict) or not set(mark) <= {"type", "attrs"}:
                    raise ValueError("Invalid text mark")
                name = mark.get("type")
                if name not in ("bold", "italic", "underline", "textStyle") or name in seen:
                    raise ValueError("Unsupported text mark")
                seen.add(name)
                options = mark.get("attrs", {})
                if not isinstance(options, dict):
                    raise ValueError("Invalid mark attributes")
                if name == "textStyle":
                    if not set(options) <= {"fontSize"} or options.get("fontSize") not in (None, "14px", "18px", "24px"):
                        raise ValueError("Invalid font size")
                elif options:
                    raise ValueError("Unexpected mark attributes")
            return text
        if kind == "hardBreak":
            return "\n"
        children = node.get("content", [])
        if not isinstance(children, list):
            raise ValueError("Invalid document content")
        allowed = {
            "doc": {"paragraph", "bulletList", "orderedList"},
            "paragraph": {"text", "hardBreak"},
            "bulletList": {"listItem"}, "orderedList": {"listItem"},
            "listItem": {"paragraph", "bulletList", "orderedList"},
        }[kind]
        if any(not isinstance(child, dict) or not isinstance(child.get("type"), str)
               or child["type"] not in allowed for child in children):
            raise ValueError("Invalid document nesting")
        if kind != "paragraph" and not children:
            raise ValueError("Empty document container")
        if kind == "listItem" and children[0].get("type") != "paragraph":
            raise ValueError("A list item must start with a paragraph")
        separator = "" if kind == "paragraph" else "\n"
        return separator.join(visit(child, depth + 1) for child in children)

    if document.get("type") != "doc":
        raise ValueError("Expected an announcement document")
    text = visit(document).strip()
    if not text or len(text) > 10000:
        raise ValueError("Announcement must contain 1 to 10000 text characters")
    return document


def document_text(node: dict) -> str:
    if node["type"] == "text":
        return node["text"]
    if node["type"] == "hardBreak":
        return "\n"
    separator = "" if node["type"] == "paragraph" else "\n"
    return separator.join(document_text(child) for child in node.get("content", []))
