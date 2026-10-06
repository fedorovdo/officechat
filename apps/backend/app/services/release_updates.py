"""Read published OfficeChat releases for a passive administrator notice."""

import asyncio
import json
import re
import time
from urllib.request import Request, urlopen


RELEASES_URL = "https://api.github.com/repos/fedorovdo/officechat/releases?per_page=100"
RELEASE_URL_PREFIX = "https://github.com/fedorovdo/officechat/releases/tag/"
VERSION = re.compile(r"^v?(\d+)\.(\d+)\.(\d+)(?:-rc(\d+)\.(\d+)(-[a-z0-9-]+)?)?$")
CACHE_SECONDS = 3600
_cached: tuple[float, list[dict]] | None = None
_failed_until = 0.0
_lock = asyncio.Lock()


def version_parts(version: str) -> tuple[tuple[int, ...], str | None] | None:
    match = VERSION.fullmatch(version)
    if not match:
        return None
    major, minor, patch, rc, iteration, suffix = match.groups()
    order = (int(major), int(minor), int(patch), 1 if rc is None else 0,
             int(rc or 0), int(iteration or 0))
    return order, suffix


def find_update(current: str, releases: list[dict]) -> dict[str, str] | None:
    installed = version_parts(current)
    if installed is None:
        return None
    installed_order, installed_suffix = installed
    candidates = []
    for release in releases:
        if not isinstance(release, dict) or release.get("draft") is not False:
            continue
        tag = release.get("tag_name")
        if not isinstance(tag, str):
            continue
        parsed = version_parts(tag)
        if parsed is None:
            continue
        order, suffix = parsed
        if suffix != installed_suffix or order <= installed_order:
            continue
        # A stable installation only follows stable releases. Candidate installations
        # follow their own tested OS variant, and can later move to a stable release.
        if installed_order[3] == 1 and release.get("prerelease") is not False:
            continue
        if (order[3] == 0) != (release.get("prerelease") is True):
            continue
        candidates.append((order, tag))
    if not candidates:
        return None
    _, tag = max(candidates)
    return {"version": tag.removeprefix("v"), "url": RELEASE_URL_PREFIX + tag}


def _fetch_releases() -> list[dict]:
    request = Request(RELEASES_URL, headers={
        "Accept": "application/vnd.github+json",
        "User-Agent": "OfficeChat-release-notice",
        "X-GitHub-Api-Version": "2022-11-28",
    })
    with urlopen(request, timeout=4) as response:
        data = response.read(1_000_001)
    if len(data) > 1_000_000:
        raise ValueError("Release list is too large")
    releases = json.loads(data)
    if not isinstance(releases, list):
        raise ValueError("Invalid release list")
    return releases


async def available_update(current: str) -> dict[str, str | None]:
    global _cached, _failed_until
    if version_parts(current) is None:
        return {"current_version": current, "latest_version": None, "release_url": None, "status": "unsupported"}
    async with _lock:
        if _cached is None or time.monotonic() - _cached[0] > CACHE_SECONDS:
            if time.monotonic() < _failed_until:
                return {"current_version": current, "latest_version": None, "release_url": None, "status": "unavailable"}
            try:
                _cached = (time.monotonic(), await asyncio.to_thread(_fetch_releases))
            except (OSError, ValueError, TimeoutError, json.JSONDecodeError):
                _failed_until = time.monotonic() + 300
                return {"current_version": current, "latest_version": None, "release_url": None, "status": "unavailable"}
            _failed_until = 0.0
        candidate = find_update(current, _cached[1])
    return {
        "current_version": current,
        "latest_version": candidate["version"] if candidate else None,
        "release_url": candidate["url"] if candidate else None,
        "status": "update_available" if candidate else "current",
    }
