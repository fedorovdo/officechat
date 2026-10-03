#!/usr/bin/env python3
"""Fixed host-side executor for a confirmed OfficeChat restore request."""

import json
import os
import re
import socket
import stat
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path


REQUEST_DIRECTORY = Path("/var/lib/officechat-backup-agent/restores")
INSTALLED_VERSION = Path("/opt/officechat/VERSION")
RESTORE_PROGRAM = "/opt/officechat/restore-production.sh"
BACKUP_CONFIG = "/etc/officechat/backup.conf"
REQUEST_ID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
BACKUP_ID = re.compile(r"^officechat-backup-[0-9]{8}-[0-9]{6}Z$")


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def save(path: Path, request: dict) -> None:
    fd, name = tempfile.mkstemp(prefix=".restore-", dir=REQUEST_DIRECTORY)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(request, stream, ensure_ascii=True)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(name, path)
        parent_fd = os.open(REQUEST_DIRECTORY, os.O_RDONLY)
        try:
            os.fsync(parent_fd)
        finally:
            os.close(parent_fd)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def main(request_id: str) -> int:
    if not REQUEST_ID.fullmatch(request_id) or os.geteuid() != 0:
        raise ValueError("Invalid restore executor request")
    info = REQUEST_DIRECTORY.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or stat.S_IMODE(info.st_mode) != 0o700:
        raise ValueError("Restore request directory is unsafe")
    path = REQUEST_DIRECTORY / f"{request_id}.json"
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or stat.S_IMODE(info.st_mode) != 0o600 or info.st_size > 8192:
            raise ValueError("Restore request file is unsafe")
        request = json.loads(os.read(fd, 8193))
    finally:
        os.close(fd)
    target = request.get("backup_id")
    reason = request.get("reason")
    hostname = socket.gethostname()
    if (request.get("request_id") != request_id or request.get("state") != "queued"
            or not isinstance(target, str) or not BACKUP_ID.fullmatch(target)
            or request.get("hostname") != hostname or not isinstance(reason, str)
            or not 20 <= len(reason) <= 1000 or any(ord(char) < 32 or ord(char) == 127 for char in reason)):
        raise ValueError("Restore request confirmation is invalid")
    installed_version = INSTALLED_VERSION.read_text(encoding="utf-8").strip()
    backup_root = Path(request.get("backup_root", ""))
    if not backup_root.is_absolute() or backup_root.is_symlink():
        raise ValueError("Restore backup root is invalid")
    manifest_path = backup_root / target / "metadata/manifest.json"
    with manifest_path.open(encoding="utf-8") as stream:
        backup_version = json.load(stream).get("officechat_version")
    if installed_version != backup_version:
        raise ValueError("Restore requires the same OfficeChat version as the backup")
    request.update(state="running", started_at=now())
    save(path, request)
    print(f"Restore request {request_id} started for {target}; actor={request.get('requested_by_login')}; reason={reason}", flush=True)
    try:
        base = [RESTORE_PROGRAM, "--config", BACKUP_CONFIG]
        drill = subprocess.run([*base, "--verify-only", "--backup-id", target],
                               check=False, stdin=subprocess.DEVNULL)
        if drill.returncode != 0:
            raise RuntimeError("Isolated restore drill failed")
        completed = subprocess.run([*base, "--production", "--confirm-hostname", hostname,
                                    "--confirm-backup", target, "--yes", "--non-interactive",
                                    "--backup-id", target], check=False, stdin=subprocess.DEVNULL)
        result = completed.returncode
    except (OSError, RuntimeError):
        result = 1
    request.update(state="succeeded" if result == 0 else "failed", finished_at=now(),
                   last_error=None if result == 0 else "RESTORE_FAILED")
    save(path, request)
    print(f"Restore request {request_id} finished with status {request['state']}", flush=True)
    return result


if __name__ == "__main__":
    try:
        raise SystemExit(main(sys.argv[1] if len(sys.argv) == 2 else ""))
    except (OSError, ValueError, TypeError, json.JSONDecodeError) as error:
        print(f"Restore executor rejected request: {error}", file=sys.stderr)
        raise SystemExit(1) from error
