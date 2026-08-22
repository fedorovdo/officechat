import os
import unittest
from unittest.mock import patch

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

    def test_missing_version_metadata_uses_non_release_marker(self):
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop("APP_VERSION", None)
            os.environ.pop("OFFICECHAT_VERSION", None)
            settings = Settings(_env_file=None)
        self.assertEqual(settings.app_version, "development")
        self.assertNotEqual(settings.app_version, "0.1.0-rc2")

    def test_release_version_metadata_is_used_exactly(self):
        settings = Settings(APP_VERSION="0.1.0-test-release")
        self.assertEqual(settings.safe_service_metadata["version"], "0.1.0-test-release")

    def test_blank_version_metadata_uses_non_release_marker(self):
        settings = Settings(APP_VERSION="   ")
        self.assertEqual(settings.safe_service_metadata["version"], "development")


if __name__ == "__main__":
    unittest.main()
