import asyncio
import unittest
from unittest.mock import patch

from app.services import release_updates


def release(tag: str, *, prerelease: bool = True, draft: bool = False) -> dict:
    return {"tag_name": tag, "prerelease": prerelease, "draft": draft}


class ReleaseUpdateTests(unittest.TestCase):
    def test_rc_update_stays_in_same_os_variant(self):
        installed = "0.1.0-rc13.27-redos8-debian13-installer"
        candidates = [
            release("v0.1.0-rc13.28-redos8-debian13-installer"),
            release("v0.1.0-rc13.29-other-variant"),
            release("v0.1.0-rc13.30-redos8-debian13-installer", draft=True),
            release("v0.1.0-rc13.26-redos8-debian13-installer"),
        ]
        self.assertEqual(release_updates.find_update(installed, candidates), {
            "version": "0.1.0-rc13.28-redos8-debian13-installer",
            "url": release_updates.RELEASE_URL_PREFIX + "v0.1.0-rc13.28-redos8-debian13-installer",
        })

    def test_stable_does_not_follow_prerelease_or_unsafe_tag(self):
        self.assertIsNone(release_updates.find_update("0.1.0", [
            release("v0.2.0-rc1.1"),
            release("v0.2.0/../evil", prerelease=False),
        ]))
        self.assertEqual(release_updates.find_update("0.1.0", [release("v0.2.0", prerelease=False)])["version"], "0.2.0")

    def test_network_failure_does_not_claim_no_update(self):
        release_updates._cached = None
        release_updates._failed_until = 0
        with patch.object(release_updates, "_fetch_releases", side_effect=OSError("offline")):
            result = asyncio.run(release_updates.available_update("0.1.0"))
        self.assertEqual(result["status"], "unavailable")
