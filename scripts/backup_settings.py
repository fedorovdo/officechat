#!/usr/bin/env python3
"""Apply a narrowly scoped backup destination and calendar request on the host.

This program runs only as the fixed systemd settings executor. It never accepts
mount options, local paths, unit names or shell commands from the request.
"""

from __future__ import annotations

import json
import fcntl
import ipaddress
import os
import re
import shutil
import stat
import socket
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path


REQUEST_DIR = Path("/var/lib/officechat-backup-agent/settings")
CONFIG = Path("/etc/officechat/backup.conf")
CREDENTIALS = Path("/etc/officechat/backup-offsite.credentials")
MOUNTPOINT = Path("/mnt/officechat-offsite")
MOUNT_UNIT = Path(r"/etc/systemd/system/mnt-officechat\x2doffsite.mount")
TIMER_OVERRIDE = Path("/etc/systemd/system/officechat-backup.timer.d/10-officechat-settings.conf")
SYSTEMCTL = "/usr/bin/systemctl"
FINDMNT = "/usr/bin/findmnt"
UNIT_NAME = "mnt-officechat\\x2doffsite.mount"
TIMER_NAME = "officechat-backup.timer"
BACKUP_STATUS = Path("/var/backups/officechat/status/latest.json")
REQUEST_ID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
HOST = re.compile(r"^[a-zA-Z0-9](?:[a-zA-Z0-9.-]{0,251}[a-zA-Z0-9])?$")
EXPORT = re.compile(r"^/(?:[a-zA-Z0-9_.-]+/?)+$")
SHARE = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9_.$-]{0,79}$")
SMB_DIRECTORY = re.compile(r"^(?:|[a-zA-Z0-9_][a-zA-Z0-9_.-]*(?:/[a-zA-Z0-9_][a-zA-Z0-9_.-]*)*)$")
IDENTITY = re.compile(r"^[a-zA-Z0-9_.@-]{1,128}$")
DAYS = ("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun")


class SettingsError(ValueError):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


def secure_read(path: Path, *, max_bytes: int = 65536, mode: int = 0o600) -> bytes:
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or stat.S_IMODE(info.st_mode) != mode or info.st_size > max_bytes:
            raise ValueError("Host configuration or request has unsafe ownership or permissions")
        return os.read(fd, max_bytes + 1)
    finally:
        os.close(fd)


def atomic_write(path: Path, content: bytes, mode: int = 0o600) -> None:
    if path.is_symlink() or (path.exists() and not path.is_file()):
        raise ValueError("Unsafe settings destination")
    path.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix=".officechat-", dir=path.parent)
    try:
        os.fchmod(fd, mode)
        with os.fdopen(fd, "wb") as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(name, path)
        parent = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(parent)
        finally:
            os.close(parent)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def run(*args: str, timeout: int = 20) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(args, shell=False, stdin=subprocess.DEVNULL, text=True,
                            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=timeout, check=False)
    if result.returncode:
        raise RuntimeError("Host backup settings check or systemd operation failed")
    return result


def validated(request: dict) -> dict:
    if set(request) != {"request_id", "state", "destination", "schedule", "requested_at"}:
        raise ValueError("Invalid settings request fields")
    destination = request["destination"]
    schedule = request["schedule"]
    if not isinstance(destination, dict) or not isinstance(schedule, dict):
        raise ValueError("Invalid settings request")
    if set(schedule) != {"enabled", "days", "time"} or not isinstance(schedule["enabled"], bool):
        raise ValueError("Invalid calendar settings")
    days = schedule["days"]
    clock = schedule["time"]
    if not isinstance(days, list) or not days or len(days) > 7 or any(day not in DAYS for day in days) or len(set(days)) != len(days):
        raise ValueError("Invalid calendar days")
    if not isinstance(clock, str) or not re.fullmatch(r"(?:[01][0-9]|2[0-3]):[0-5][0-9]", clock):
        raise ValueError("Invalid calendar time")
    kind = destination.get("kind")
    if kind in ("local", "unchanged", "reconnect"):
        if set(destination) != {"kind"}:
            raise ValueError("Invalid destination selector")
    elif kind == "nfs":
        if set(destination) != {"kind", "host", "export", "version", "require_offsite"}:
            raise ValueError("Invalid NFS destination")
        if (not isinstance(destination["host"], str) or not HOST.fullmatch(destination["host"])
                or not isinstance(destination["export"], str) or not EXPORT.fullmatch(destination["export"])
                or ".." in destination["export"].split("/") or destination["version"] not in ("3", "4.1", "4.2")
                or not isinstance(destination["require_offsite"], bool)):
            raise ValueError("Invalid NFS destination")
    elif kind == "smb":
        required = {"kind", "host", "share", "domain", "username", "password", "require_offsite"}
        if set(destination) not in (required, required | {"directory"}):
            raise ValueError("Invalid SMB destination")
        directory = destination.get("directory", "")
        if (not isinstance(destination["host"], str) or not HOST.fullmatch(destination["host"])
                or not isinstance(destination["share"], str) or not SHARE.fullmatch(destination["share"])
                or not isinstance(directory, str) or len(directory) > 255 or not SMB_DIRECTORY.fullmatch(directory)
                or not isinstance(destination["domain"], str) or (destination["domain"] and not IDENTITY.fullmatch(destination["domain"]))
                or not isinstance(destination["username"], str) or not IDENTITY.fullmatch(destination["username"])
                or not isinstance(destination["password"], str) or not 1 <= len(destination["password"]) <= 512
                or any(char in destination["password"] for char in "\r\n\0")
                or not isinstance(destination["require_offsite"], bool)):
            raise ValueError("Invalid SMB destination")
    else:
        raise ValueError("Unsupported backup destination")
    return request


def replace_backup_value(content: bytes, key: str, value: str) -> bytes:
    text = content.decode("utf-8")
    lines = text.splitlines(keepends=True)
    matches = [index for index, line in enumerate(lines) if line.startswith(f"{key}=")]
    if len(matches) != 1:
        raise ValueError("Backup configuration has an unexpected format")
    lines[matches[0]] = f"{key}={value}\n"
    return "".join(lines).encode("utf-8")


def calendar_file(schedule: dict) -> bytes:
    ordered = [day for day in DAYS if day in schedule["days"]]
    expression = f"{','.join(ordered)} *-*-* {schedule['time']}:00"
    run("/usr/bin/systemd-analyze", "calendar", expression)
    return ("[Timer]\nOnCalendar=\nOnCalendar=" + expression + "\nRandomizedDelaySec=0\n").encode()


def mount_file(destination: dict) -> tuple[bytes, bytes | None]:
    if destination["kind"] == "nfs":
        source = f"{destination['host']}:{destination['export']}"
        options = f"rw,_netdev,vers={destination['version']}"
        filesystem = "nfs"
        secret = None
    else:
        source = f"//{destination['host']}/{destination['share']}"
        if destination.get("directory"):
            source += f"/{destination['directory']}"
        options = f"rw,_netdev,credentials={CREDENTIALS},vers=3.1.1,dir_mode=0700,file_mode=0600"
        filesystem = "cifs"
        secret = (f"username={destination['username']}\npassword={destination['password']}\n"
                  + (f"domain={destination['domain']}\n" if destination["domain"] else "")).encode()
    unit = f"[Unit]\nDescription=OfficeChat offsite backups\n\n[Mount]\nWhat={source}\nWhere={MOUNTPOINT}\nType={filesystem}\nOptions={options}\nTimeoutSec=30s\n\n[Install]\nWantedBy=multi-user.target\n"
    return unit.encode(), secret


def managed_mount_host() -> str:
    """Read only the fixed, root-owned mount definition, never credentials."""
    content = secure_read(MOUNT_UNIT, mode=0o644).decode()
    fields = {}
    for key in ("What", "Where", "Type"):
        matches = re.findall(rf"^{key}=(.+)$", content, re.M)
        if len(matches) != 1:
            raise ValueError("Invalid managed mount definition")
        fields[key] = matches[0]
    if fields["Where"] != str(MOUNTPOINT):
        raise ValueError("Unexpected mountpoint")
    source = fields["What"]
    if fields["Type"] == "cifs":
        match = re.fullmatch(r"//([^/]+)/([^/]+)(?:/(.+))?", source)
        if not match or not SHARE.fullmatch(match[2]) or not SMB_DIRECTORY.fullmatch(match[3] or ""):
            raise ValueError("Invalid SMB source")
    elif fields["Type"] == "nfs":
        match = re.fullmatch(r"([^:]+):(/.+)", source)
        if not match or not EXPORT.fullmatch(match[2]) or ".." in match[2].split("/"):
            raise ValueError("Invalid NFS source")
    else:
        raise ValueError("Unsupported managed filesystem")
    if not HOST.fullmatch(match[1]):
        raise ValueError("Invalid mount host")
    return match[1]


def wait_for_mount_route(timeout: float = 60) -> None:
    host = managed_mount_host()
    deadline = time.monotonic() + timeout
    while True:
        try:
            addresses = socket.getaddrinfo(host, 9, type=socket.SOCK_DGRAM)
            for family, kind, protocol, _, address in addresses:
                try:
                    # UDP connect asks the kernel for a route; no packet is sent.
                    with socket.socket(family, kind, protocol) as probe:
                        probe.settimeout(1)
                        probe.connect(address)
                        local = ipaddress.ip_address(probe.getsockname()[0])
                        if not local.is_unspecified and not local.is_loopback:
                            print("Offsite network route is ready", flush=True)
                            return
                except OSError:
                    continue
        except OSError:
            pass
        if time.monotonic() >= deadline:
            raise SettingsError("NETWORK_ROUTE_UNAVAILABLE")
        time.sleep(min(1, max(0, deadline - time.monotonic())))


def check_mounted_destination(original_config: bytes) -> None:
    run(FINDMNT, "--mountpoint", str(MOUNTPOINT), "--noheadings", "--output", "TARGET")
    local_match = re.search(rb"^BACKUP_ROOT=(.*)$", original_config, re.M)
    if local_match is None or MOUNTPOINT.stat().st_dev == Path(local_match[1].decode()).stat().st_dev:
        raise ValueError("Offsite destination is on the local filesystem")
    test = MOUNTPOINT / f".officechat-settings-check-{os.getpid()}"
    fd = os.open(test, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        try:
            os.write(fd, b"OfficeChat mount test\n")
            os.fsync(fd)
        finally:
            os.close(fd)
        if test.read_bytes() != b"OfficeChat mount test\n":
            raise SettingsError("DESTINATION_READ_FAILED")
    finally:
        test.unlink(missing_ok=True)


def apply(request: dict) -> None:
    validated(request)
    destination = request["destination"]
    schedule = request["schedule"]
    original_config = secure_read(CONFIG)
    previous_root = re.findall(rb"^OFFSITE_ROOT=(.*)$", original_config, re.M)
    if len(previous_root) != 1 or previous_root[0] not in (b"", str(MOUNTPOINT).encode()):
        raise ValueError("Existing offsite configuration must be managed on the server")
    if MOUNTPOINT.exists() and (MOUNTPOINT.is_symlink() or not MOUNTPOINT.is_dir()):
        raise ValueError("Mountpoint is unsafe")
    if destination["kind"] == "reconnect":
        if not previous_root[0]:
            raise ValueError("No managed destination is configured")
        managed_mount_host()
        # Reconnect cannot change credentials, the destination or the schedule.
        run(SYSTEMCTL, "reset-failed", UNIT_NAME)
        run(SYSTEMCTL, "start", UNIT_NAME, timeout=100)
        check_mounted_destination(original_config)
        return
    if destination["kind"] in ("nfs", "smb") and previous_root[0]:
        raise ValueError("Changing an existing destination requires an explicit server migration")
    if destination["kind"] == "local" and previous_root[0]:
        raise ValueError("Disabling an existing offsite destination requires an explicit server migration")
    if destination["kind"] in ("nfs", "smb") and (MOUNT_UNIT.exists() or CREDENTIALS.exists()):
        raise ValueError("Existing mount configuration must be managed on the server")
    if destination["kind"] in ("nfs", "smb"):
        helper = "mount.nfs" if destination["kind"] == "nfs" else "mount.cifs"
        if not shutil.which(helper, path="/usr/sbin:/sbin:/usr/bin:/bin"):
            raise SettingsError("MOUNT_HELPER_MISSING")
    if schedule["enabled"]:
        if previous_root[0]:
            check_mounted_destination(original_config)
        if destination["kind"] in ("nfs", "smb"):
            raise ValueError("Create and verify a manual offsite backup before enabling the timer")
        latest = json.loads(secure_read(BACKUP_STATUS))
        verified = latest.get("last_success") or {}
        if verified.get("verification_status") != "passed" or (
            previous_root[0] and verified.get("offsite_status") != "copied"
        ):
            raise ValueError("Create and verify a manual backup to the selected destination first")
    previous_timer = secure_read(TIMER_OVERRIDE, mode=0o644) if TIMER_OVERRIDE.exists() else None
    # is-enabled returns a nonzero status for a disabled timer.
    was_enabled = subprocess.run((SYSTEMCTL, "is-enabled", "--quiet", TIMER_NAME),
                                 stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                 stderr=subprocess.DEVNULL, timeout=5, check=False).returncode == 0
    timer_written = mount_written = config_written = False
    try:
        if destination["kind"] in ("nfs", "smb"):
            MOUNTPOINT.mkdir(mode=0o700, parents=True, exist_ok=True)
            if subprocess.run((FINDMNT, "--mountpoint", str(MOUNTPOINT), "--noheadings", "--output", "TARGET"),
                              stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                              stderr=subprocess.DEVNULL, timeout=5, check=False).returncode == 0:
                raise ValueError("Mountpoint already active")
            unit, secret = mount_file(destination)
            mount_written = True
            if secret is not None:
                atomic_write(CREDENTIALS, secret)
            atomic_write(MOUNT_UNIT, unit, 0o644)
            run(SYSTEMCTL, "daemon-reload")
            run(SYSTEMCTL, "start", UNIT_NAME, timeout=100)
            check_mounted_destination(original_config)
            run(SYSTEMCTL, "enable", UNIT_NAME)
        if destination["kind"] != "unchanged":
            new_config = replace_backup_value(original_config, "OFFSITE_ROOT", str(MOUNTPOINT) if destination["kind"] != "local" else "")
            new_config = replace_backup_value(new_config, "REQUIRE_OFFSITE", "yes" if destination.get("require_offsite") else "no")
            config_written = True
            atomic_write(CONFIG, new_config)
        timer_content = calendar_file(schedule)
        timer_written = True
        atomic_write(TIMER_OVERRIDE, timer_content, 0o644)
        run(SYSTEMCTL, "daemon-reload")
        run(SYSTEMCTL, "enable" if schedule["enabled"] else "disable", "--now", TIMER_NAME)
    except Exception:
        # Every attempted mutation is restored, including a failed atomic write.
        try:
            if timer_written:
                if previous_timer is None:
                    TIMER_OVERRIDE.unlink(missing_ok=True)
                else:
                    atomic_write(TIMER_OVERRIDE, previous_timer, 0o644)
            if config_written:
                atomic_write(CONFIG, original_config)
            if mount_written:
                subprocess.run((SYSTEMCTL, "disable", "--now", UNIT_NAME),
                               stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=65, check=False)
                MOUNT_UNIT.unlink(missing_ok=True)
                CREDENTIALS.unlink(missing_ok=True)
            run(SYSTEMCTL, "daemon-reload")
            run(SYSTEMCTL, "enable" if was_enabled else "disable", "--now", TIMER_NAME)
        finally:
            raise


def main(request_id: str) -> int:
    if os.geteuid() != 0 or not REQUEST_ID.fullmatch(request_id):
        raise ValueError("Invalid backup settings request")
    directory = REQUEST_DIR.lstat()
    if not stat.S_ISDIR(directory.st_mode) or directory.st_uid != 0 or stat.S_IMODE(directory.st_mode) != 0o700:
        raise ValueError("Settings request directory is unsafe")
    path = REQUEST_DIR / f"{request_id}.json"
    request = json.loads(secure_read(path, max_bytes=4096))
    if request.get("request_id") != request_id or request.get("state") != "queued":
        raise ValueError("Invalid backup settings request state")
    request["state"] = "running"
    atomic_write(path, json.dumps(request).encode())
    lock = Path("/run/lock/officechat/backup.lock")
    lock.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    fd = -1
    release_lock = Path("/tmp/officechat-release.lock")
    release_locked = False
    try:
        fd = os.open(lock, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        try:
            release_lock.mkdir(mode=0o700)
            release_locked = True
        except FileExistsError as exc:
            raise SettingsError("MAINTENANCE_BUSY") from exc
        apply(request)
        current_path = REQUEST_DIR / "current.json"
        if request["destination"]["kind"] in ("unchanged", "reconnect"):
            previous = json.loads(secure_read(current_path)) if current_path.exists() else {}
            selected = previous.get("destination", {"kind": "unmanaged"})
        else:
            selected = {key: value for key, value in request["destination"].items() if key != "password"}
        current = {"destination": selected, "schedule": request["schedule"]}
        if request["destination"]["kind"] != "reconnect":
            atomic_write(REQUEST_DIR / "current.json", json.dumps(current).encode())
        request["state"] = "succeeded"
        result = 0
    except Exception as exc:
        request["state"] = "failed"
        request["error_code"] = exc.code if isinstance(exc, SettingsError) else "SETTINGS_APPLY_FAILED"
        result = 1
    finally:
        try:
            if release_locked:
                release_lock.rmdir()
        except OSError:
            # Keep the terminal request state and remove the transient secret.
            pass
        if fd >= 0:
            os.close(fd)
        # The password is never retained in the job history, even after a failure.
        if isinstance(request.get("destination"), dict):
            request["destination"].pop("password", None)
        request["finished_at"] = datetime.now(timezone.utc).isoformat()
        atomic_write(path, json.dumps(request).encode())
    print(f"Backup settings request {request_id} finished: {request['state']}", flush=True)
    return result


if __name__ == "__main__":
    try:
        if sys.argv[1:] == ["--wait-network"]:
            if os.geteuid() != 0:
                raise ValueError("Network wait requires root")
            wait_for_mount_route()
        else:
            raise SystemExit(main(sys.argv[1] if len(sys.argv) == 2 else ""))
    except (OSError, ValueError, json.JSONDecodeError):
        print("Backup settings executor rejected request", file=sys.stderr)
        raise SystemExit(1)
