import unittest
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch
from uuid import uuid4

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from pydantic import ValidationError

from app.api.deps import get_db, require_can_broadcast
from app.api.routes import broadcasts as routes
from app.models.broadcast import BroadcastTemplate
from app.schemas.broadcast import BroadcastCreate, BroadcastTemplateCreate, BroadcastUpdate
from app.schemas.announcement_document import document_text
from app.services.broadcasts import serialize_announcement, update_broadcast


def document(text="Сегодня привоз воды"):
    return {"type": "doc", "content": [{"type": "paragraph", "attrs": {"textAlign": "center"},
        "content": [{"type": "text", "text": text, "marks": [{"type": "bold"},
        {"type": "textStyle", "attrs": {"fontSize": "24px"}}]}]}]}


class DocumentTests(unittest.TestCase):
    def payload(self, **overrides):
        return {"name": "Вода", "title": "Доставка воды", "body": "Сегодня привоз воды",
                "body_doc": document(), **overrides}

    def test_formatting_keeps_plain_text_and_whitelisted_marks(self):
        template = BroadcastTemplateCreate(**self.payload())
        self.assertEqual(document_text(template.body_doc), template.body)
        broadcast = BroadcastCreate(title=template.title, body=template.body,
            body_doc=template.body_doc, audience_type="all_active_users")
        self.assertEqual(broadcast.body_doc, template.body_doc)

    def test_rejects_injected_owner_html_css_and_mismatched_text(self):
        bad_documents = []
        for attrs in ({"textAlign": "expression(alert(1))"}, {"onclick": "alert(1)"}):
            doc = document(); doc["content"][0]["attrs"] = attrs; bad_documents.append(doc)
        for mark in ({"type": "link", "attrs": {"href": "javascript:alert(1)"}},
                     {"type": "textStyle", "attrs": {"fontSize": "url(secret)"}}):
            doc = document(); doc["content"][0]["content"][0]["marks"] = [mark]; bad_documents.append(doc)
        bad_documents.append({"type": "doc", "content": [{"type": "image", "attrs": {"src": "secret"}}]})
        for doc in bad_documents:
            with self.subTest(doc=doc), self.assertRaises(ValidationError):
                BroadcastTemplateCreate(**self.payload(body_doc=doc))
        with self.assertRaises(ValidationError):
            BroadcastTemplateCreate(**self.payload(created_by_user_id=str(uuid4())))
        with self.assertRaises(ValidationError):
            BroadcastTemplateCreate(**self.payload(body="Другой текст"))
        with self.assertRaises(ValidationError):
            BroadcastUpdate(body_doc=document())

    def test_rejects_empty_and_excessively_nested_documents(self):
        with self.assertRaises(ValidationError):
            BroadcastTemplateCreate(**self.payload(body_doc={"type": "doc", "content": []}))
        node = {"type": "paragraph", "content": [{"type": "text", "text": "x"}]}
        for _ in range(6):
            node = {"type": "bulletList", "content": [{"type": "listItem", "content": [
                {"type": "paragraph", "content": [{"type": "text", "text": "x"}]}, node]}]}
        with self.assertRaises(ValidationError):
            BroadcastTemplateCreate(**self.payload(body_doc={"type": "doc", "content": [node]}))


class Session:
    def __init__(self, template):
        self.template = template
        self.deleted = []
        self.commits = 0
    async def get(self, model, item_id, **kwargs):
        return self.template if item_id == self.template.id else None
    def add(self, item):
        self.template = item
    async def flush(self):
        if self.template.id is None:
            self.template.id = uuid4()
    async def refresh(self, item):
        item.created_at = item.updated_at = datetime.now(timezone.utc)
    async def commit(self):
        self.commits += 1
    async def delete(self, item):
        self.deleted.append(item.id)
    async def scalar(self, statement):
        return 1
    async def scalars(self, statement):
        return SimpleNamespace(all=lambda: [self.template])


class TemplateHTTPTests(unittest.TestCase):
    def setUp(self):
        self.owner = SimpleNamespace(id=uuid4(), display_name="Автор", is_active=True, role="user", auth_provider="local")
        now = datetime.now(timezone.utc)
        self.template = BroadcastTemplate(id=uuid4(), created_by_user_id=self.owner.id,
            created_by_display_name="Автор", name="Вода", title="Привоз", body="Сегодня привоз воды",
            body_doc=document(), priority="normal", created_at=now, updated_at=now)
        self.session = Session(self.template)
        self.actor = self.owner
        self.app = FastAPI()
        self.app.include_router(routes.router, prefix="/api")
        self.app.dependency_overrides[get_db] = lambda: self.session
        self.app.dependency_overrides[require_can_broadcast] = lambda: self.actor
        self.audit = patch.object(routes, "record_audit_event", AsyncMock())
        self.audit_mock = self.audit.start()
        self.addCleanup(self.audit.stop)
        self.client = TestClient(self.app)

    def payload(self):
        return {"name": "Вода завтра", "title": "Завтра", "body": "Завтра привоз воды",
                "body_doc": document("Завтра привоз воды"), "priority": "important"}

    def test_owner_creates_updates_and_deletes_without_audit_body(self):
        response = self.client.post("/api/broadcast-templates", json=self.payload())
        self.assertEqual(response.status_code, 201, response.text)
        self.assertEqual(response.json()["created_by_user_id"], str(self.owner.id))
        item_id = response.json()["id"]
        response = self.client.put(f"/api/broadcast-templates/{item_id}", json=self.payload())
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(self.client.delete(f"/api/broadcast-templates/{item_id}").status_code, 204)
        self.assertEqual(self.session.commits, 3)
        for call in self.audit_mock.call_args_list:
            self.assertNotIn("body", call.kwargs.get("details", {}))
            self.assertNotIn("Вода", call.kwargs.get("target_label", ""))

    def test_other_sender_and_superadmin_can_use_but_cannot_mutate_template(self):
        for role in ("user", "admin", "superadmin"):
            with self.subTest(role=role):
                self.actor = SimpleNamespace(id=uuid4(), display_name="Другой", is_active=True, role=role, auth_provider="local")
                self.assertEqual(self.client.get("/api/broadcast-templates").status_code, 200)
                path = f"/api/broadcast-templates/{self.template.id}"
                self.assertEqual(self.client.put(path, json=self.payload()).status_code, 403)
                self.assertEqual(self.client.delete(path).status_code, 403)
        self.assertEqual(self.template.title, "Привоз")
        self.assertEqual(self.session.commits, 0)
        self.assertEqual(self.session.deleted, [])

    def test_missing_permission_denies_every_template_route(self):
        def denied():
            raise HTTPException(status_code=403, detail="Permission required")
        self.app.dependency_overrides[require_can_broadcast] = denied
        path = f"/api/broadcast-templates/{self.template.id}"
        for response in (self.client.get("/api/broadcast-templates"),
                         self.client.post("/api/broadcast-templates", json=self.payload()),
                         self.client.put(path, json=self.payload()), self.client.delete(path)):
            self.assertEqual(response.status_code, 403)

    def test_bot_and_disabled_sender_and_forged_owner_denied(self):
        for active, role in ((False, "user"), (True, "bot")):
            self.actor = SimpleNamespace(id=self.owner.id, display_name="Автор", is_active=active, role=role, auth_provider="local")
            self.assertEqual(self.client.post("/api/broadcast-templates", json=self.payload()).status_code, 403)
        self.actor = self.owner
        forged = {**self.payload(), "created_by_user_id": str(uuid4())}
        self.assertEqual(self.client.post("/api/broadcast-templates", json=forged).status_code, 422)
        self.assertEqual(self.client.put(f"/api/broadcast-templates/{uuid4()}", json=self.payload()).status_code, 404)

    def test_invalid_node_types_return_validation_error_without_writing(self):
        for kind in ([], {}, None, 42):
            for nested in (False, True):
                with self.subTest(kind=kind, nested=nested):
                    invalid_node = {"type": kind}
                    content = [{"type": "paragraph", "content": [invalid_node]}] if nested else [invalid_node]
                    payload = {**self.payload(), "body_doc": {"type": "doc", "content": content}}
                    for method, path in (("post", "/api/broadcast-templates"),
                                         ("put", f"/api/broadcast-templates/{self.template.id}"),
                                         ("post", "/api/broadcasts")):
                        request_payload = payload if "templates" in path else {
                            "title": payload["title"], "body": payload["body"],
                            "body_doc": payload["body_doc"], "audience_type": "all_active_users"}
                        response = getattr(self.client, method)(path, json=request_payload)
                        self.assertEqual(response.status_code, 422, response.text)
        self.assertEqual(self.session.commits, 0)
        self.audit_mock.assert_not_awaited()


class BroadcastFormattingTests(unittest.IsolatedAsyncioTestCase):
    async def test_plain_body_update_clears_stale_formatting_but_title_update_keeps_it(self):
        actor = SimpleNamespace(is_active=True, role="user", auth_provider="local")
        announcement = SimpleNamespace(title="Привоз", body="Сегодня привоз воды", body_doc=document(),
            status="draft", expires_at=None)
        session = AsyncMock()
        await update_broadcast(session, actor, announcement, BroadcastUpdate(title="Вода"))
        self.assertEqual(announcement.body_doc, document())
        await update_broadcast(session, actor, announcement, BroadcastUpdate(body="Завтра"))
        self.assertIsNone(announcement.body_doc)

    async def test_retraction_hides_both_plain_text_and_formatting(self):
        broadcast = SimpleNamespace(id=uuid4(), title="Вода", body="Сегодня привоз воды", body_doc=document(),
            status="retracted", priority="normal", created_by_display_name="Автор", sent_at=None, expires_at=None)
        public = serialize_announcement(SimpleNamespace(broadcast=broadcast, read_at=None, dismissed_at=None))
        self.assertIsNone(public.body)
        self.assertIsNone(public.body_doc)
