import unittest

from app.api.routes.health import health
from app.core.config import Settings


class BrandMetadataTests(unittest.IsolatedAsyncioTestCase):
    async def test_health_includes_product_and_version(self):
        payload = await health()
        self.assertEqual(payload["status"], "ok")
        self.assertEqual(payload["service"], "officechat-backend")
        self.assertEqual(payload["product"], "OfficeChat")
        self.assertIn("version", payload)

    async def test_health_does_not_include_secrets_or_internal_paths(self):
        payload = await health()
        serialized = " ".join(payload.keys()).lower()
        self.assertNotIn("secret", serialized)
        self.assertNotIn("password", serialized)
        self.assertNotIn("database", serialized)
        self.assertNotIn("uploads", serialized)

    def test_build_sha_is_shortened(self):
        settings = Settings(OFFICECHAT_BUILD_SHA="1234567890abcdef")
        self.assertEqual(settings.short_build_sha, "1234567890ab")
        self.assertEqual(settings.safe_service_metadata["build_sha"], "1234567890ab")

    def test_absent_optional_build_metadata_is_safe(self):
        settings = Settings(OFFICECHAT_BUILD_SHA=None, OFFICECHAT_BUILD_DATE=None)
        metadata = settings.safe_service_metadata
        self.assertNotIn("build_sha", metadata)
        self.assertNotIn("build_date", metadata)
        self.assertEqual(metadata["product"], "OfficeChat")


if __name__ == "__main__":
    unittest.main()
