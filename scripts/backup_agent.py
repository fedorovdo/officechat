#!/usr/bin/env python3
"""Host agent for OfficeChat backup metadata and allowlisted backup jobs."""

from __future__ import annotations

import argparse
import grp
import json
import logging
import os
import re
import signal
import socket
import socketserver
import stat
import subprocess
import threading
import time
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


PROTOCOL_VERSION = 1
BACKUP_ID_PATTERN = re.compile(r"^officechat-backup-[0-9]{8}-[0-9]{6}Z$")
SAFE_METADATA_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9 ._+()\-]{0,159}$")
SAFE_COMPONENT_PATTERN = re.compile(r"^[a-z][a-z0-9_-]{0,63}$")
BACKUP_TYPES = {"manual", "scheduled", "pre_upgrade", "unknown"}
VERIFICATION_STATUSES = {"not_requested", "pending", "passed", "failed", "unknown"}
OFFSITE_STATUSES = {"not_configured", "copied", "skipped_not_mounted", "failed", "unknown"}
CURRENT_RESULTS = {"success", "failure", "unknown"}
JOB_OPERATIONS = {"create_backup", "verify_backup"}
JOB_STATES = {"queued", "running", "verifying", "succeeded", "failed", "interrupted"}
ACTIVE_JOB_STATES = {"queued", "running", "verifying"}
TERMINAL_JOB_STATES = JOB_STATES - ACTIVE_JOB_STATES
JOB_HISTORY_VERSION = 1
JOB_HISTORY_MAX_BYTES = 1_048_576
DEFAULT_AUDIT_CLAIM_TTL_SECONDS = 120
SYSTEMCTL_PATH = "/usr/bin/systemctl"
CREATE_EXECUTOR_UNIT = "officechat-backup-job.service"
VERIFY_EXECUTOR_UNIT_PREFIX = "officechat-backup-verify@"
VERIFY_EXECUTOR_UNIT_GLOB = "officechat-backup-verify@*.service"
SCHEDULED_BACKUP_UNIT = "officechat-backup.service"
SYSTEMCTL_COMMAND_TIMEOUT_SECONDS = 15
SYSTEMCTL_OUTPUT_MAX_BYTES = 16_384
EXECUTOR_BUSY_EXIT_CODE = 75
SAFE_JOB_ENVIRONMENT = {
    "PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    "LANG": "C",
    "LC_ALL": "C",
    "HOME": "/root",
}
CONFIG_KEYS = {
    "BACKUP_ROOT",
    "STATUS_DIRECTORY",
    "STATUS_FILE",
    "BACKUP_CONFIG_PATH",
    "TIMER_UNIT",
    "SOCKET_PATH",
    "SOCKET_GROUP",
    "MAX_LIST_LIMIT",
    "REQUEST_MAX_BYTES",
    "RESPONSE_MAX_BYTES",
    "IO_TIMEOUT_SECONDS",
    "STATE_DIRECTORY",
    "MAX_JOB_HISTORY",
    "AUDIT_CLAIM_TTL_SECONDS",
    "EXECUTOR_TIMEOUT_SECONDS",
}

logger = logging.getLogger("officechat-backup-agent")


class AgentError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.safe_message = message


@dataclass(frozen=True, slots=True)
class AgentConfig:
    backup_root: Path = Path("/var/backups/officechat/production")
    status_directory: Path = Path("/var/backups/officechat/status")
    status_file: Path = Path("/var/backups/officechat/status/latest.json")
    backup_config_path: Path = Path("/etc/officechat/backup.conf")
    timer_unit: str = "officechat-backup.timer"
    socket_path: Path = Path("/run/officechat-backup-agent/agent.sock")
    socket_group: str = "officechat-backup"
    max_list_limit: int = 100
    request_max_bytes: int = 65_536
    response_max_bytes: int = 1_048_576
    io_timeout_seconds: float = 5.0
    state_directory: Path = Path("/var/lib/officechat-backup-agent")
    max_job_history: int = 100
    audit_claim_ttl_seconds: int = DEFAULT_AUDIT_CLAIM_TTL_SECONDS
    executor_timeout_seconds: int = 21_600


def _contains_control(value: str) -> bool:
    return any(ord(character) < 32 or ord(character) == 127 for character in value)


def _validate_config_file(path: Path, expected_uid: int = 0) -> None:
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or path.is_symlink():
        raise ValueError("Agent configuration must be a regular non-symlink file")
    if info.st_uid != expected_uid:
        raise ValueError("Agent configuration has an invalid owner")
    if stat.S_IMODE(info.st_mode) not in {0o600, 0o640}:
        raise ValueError("Agent configuration mode must be 0600 or 0640")


def _canonical_path(value: str, label: str) -> Path:
    if not value or _contains_control(value):
        raise ValueError(f"{label} is invalid")
    path = Path(value)
    if not path.is_absolute():
        raise ValueError(f"{label} must be absolute")
    current = Path(path.anchor)
    for part in path.parts[1:]:
        current /= part
        if current.exists() and current.is_symlink():
            raise ValueError(f"{label} contains a symlink component")
    return path.resolve(strict=False)


def load_agent_config(path: Path, *, expected_uid: int = 0) -> AgentConfig:
    _validate_config_file(path, expected_uid)
    values: dict[str, str] = {}
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if "=" not in line:
            raise ValueError("Invalid agent configuration line")
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip()
        if key not in CONFIG_KEYS:
            raise ValueError(f"Unknown agent configuration key: {key}")
        if not value or _contains_control(value):
            raise ValueError(f"Invalid value for {key}")
        values[key] = value

    defaults = AgentConfig()
    backup_root = _canonical_path(values.get("BACKUP_ROOT", str(defaults.backup_root)), "BACKUP_ROOT")
    status_directory = _canonical_path(
        values.get("STATUS_DIRECTORY", str(defaults.status_directory)), "STATUS_DIRECTORY"
    )
    status_file = _canonical_path(values.get("STATUS_FILE", str(defaults.status_file)), "STATUS_FILE")
    try:
        status_file.relative_to(status_directory)
    except ValueError as exc:
        raise ValueError("STATUS_FILE must be inside STATUS_DIRECTORY") from exc
    backup_config_path = _canonical_path(
        values.get("BACKUP_CONFIG_PATH", str(defaults.backup_config_path)), "BACKUP_CONFIG_PATH"
    )
    socket_path = _canonical_path(values.get("SOCKET_PATH", str(defaults.socket_path)), "SOCKET_PATH")
    state_directory = _canonical_path(
        values.get("STATE_DIRECTORY", str(defaults.state_directory)), "STATE_DIRECTORY"
    )
    timer_unit = values.get("TIMER_UNIT", defaults.timer_unit)
    if timer_unit != "officechat-backup.timer":
        raise ValueError("Unsupported TIMER_UNIT")
    socket_group = values.get("SOCKET_GROUP", defaults.socket_group)
    if not re.fullmatch(r"[a-z_][a-z0-9_-]{0,31}", socket_group):
        raise ValueError("Invalid SOCKET_GROUP")

    def integer(name: str, default: int, minimum: int, maximum: int) -> int:
        try:
            parsed = int(values.get(name, str(default)))
        except ValueError as exc:
            raise ValueError(f"{name} must be an integer") from exc
        if parsed < minimum or parsed > maximum:
            raise ValueError(f"{name} is outside the allowed range")
        return parsed

    try:
        timeout = float(values.get("IO_TIMEOUT_SECONDS", str(defaults.io_timeout_seconds)))
    except ValueError as exc:
        raise ValueError("IO_TIMEOUT_SECONDS must be numeric") from exc
    if timeout < 0.1 or timeout > 60:
        raise ValueError("IO_TIMEOUT_SECONDS is outside the allowed range")

    return AgentConfig(
        backup_root=backup_root,
        status_directory=status_directory,
        status_file=status_file,
        backup_config_path=backup_config_path,
        timer_unit=timer_unit,
        socket_path=socket_path,
        socket_group=socket_group,
        max_list_limit=integer("MAX_LIST_LIMIT", defaults.max_list_limit, 1, 100),
        request_max_bytes=integer("REQUEST_MAX_BYTES", defaults.request_max_bytes, 1024, 262_144),
        response_max_bytes=integer("RESPONSE_MAX_BYTES", defaults.response_max_bytes, 4096, 4_194_304),
        io_timeout_seconds=timeout,
        state_directory=state_directory,
        max_job_history=integer("MAX_JOB_HISTORY", defaults.max_job_history, 10, 500),
        audit_claim_ttl_seconds=integer(
            "AUDIT_CLAIM_TTL_SECONDS", defaults.audit_claim_ttl_seconds, 30, 3600
        ),
        executor_timeout_seconds=integer(
            "EXECUTOR_TIMEOUT_SECONDS", defaults.executor_timeout_seconds, 60, 86_400
        ),
    )


def validate_backup_id(value: object) -> str:
    if not isinstance(value, str) or len(value) > 64 or not BACKUP_ID_PATTERN.fullmatch(value):
        raise AgentError("INVALID_BACKUP_ID", "Backup identifier is invalid")
    return value


def _read_bounded_json(path: Path, maximum_bytes: int, *, missing_code: str, corrupt_code: str) -> dict[str, Any]:
    try:
        flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
        descriptor = os.open(path, flags)
    except FileNotFoundError as exc:
        raise AgentError(missing_code, "Backup metadata is not available") from exc
    except OSError as exc:
        raise AgentError(corrupt_code, "Backup metadata cannot be read safely") from exc
    try:
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode) or info.st_size > maximum_bytes:
            raise AgentError(corrupt_code, "Backup metadata is invalid or too large")
        payload = os.read(descriptor, maximum_bytes + 1)
        if len(payload) > maximum_bytes:
            raise AgentError(corrupt_code, "Backup metadata is invalid or too large")
    finally:
        os.close(descriptor)
    try:
        decoded = json.loads(payload.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise AgentError(corrupt_code, "Backup metadata is corrupt") from exc
    if not isinstance(decoded, dict):
        raise AgentError(corrupt_code, "Backup metadata has an invalid format")
    return decoded


def _safe_iso(value: object) -> str | None:
    if not isinstance(value, str) or len(value) > 64 or _contains_control(value):
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc).isoformat()


def _safe_metadata(value: object, *, build_sha: bool = False) -> str | None:
    if not isinstance(value, str):
        return None
    stripped = value.strip()
    if build_sha:
        return stripped if re.fullmatch(r"[0-9a-fA-F]{7,64}", stripped) else None
    return stripped if SAFE_METADATA_PATTERN.fullmatch(stripped) else None


def _enum(value: object, allowed: set[str], fallback: str = "unknown") -> str:
    return value if isinstance(value, str) and value in allowed else fallback


def _status_run(value: object) -> dict[str, Any] | None:
    if not isinstance(value, dict):
        return None
    success = value.get("success") if isinstance(value.get("success"), bool) else None
    backup_id = value.get("backup_id")
    if backup_id is not None:
        try:
            backup_id = validate_backup_id(backup_id)
        except AgentError:
            backup_id = None
    size = value.get("backup_size_bytes")
    duration = value.get("duration_seconds")
    return {
        "timestamp": _safe_iso(value.get("timestamp")),
        "success": success,
        "backup_id": backup_id,
        "backup_size_bytes": size if isinstance(size, int) and not isinstance(size, bool) and size >= 0 else None,
        "duration_seconds": duration if isinstance(duration, int) and not isinstance(duration, bool) and duration >= 0 else None,
        "offsite_status": _enum(value.get("offsite_status"), OFFSITE_STATUSES),
        "verification_status": _enum(value.get("verification_status"), VERIFICATION_STATUSES),
        "last_error": "Backup operation failed; inspect server logs" if value.get("last_error") else None,
    }


def _parse_simple_config(path: Path) -> dict[str, str]:
    try:
        flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
        descriptor = os.open(path, flags)
    except OSError:
        return {}
    try:
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode) or info.st_size > 262_144:
            return {}
        raw = os.read(descriptor, 262_145)
    finally:
        os.close(descriptor)
    if len(raw) > 262_144:
        return {}
    result: dict[str, str] = {}
    try:
        lines = raw.decode("utf-8").splitlines()
    except UnicodeDecodeError:
        return {}
    for raw_line in lines:
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        if key in {"KEEP_DAILY", "KEEP_WEEKLY", "KEEP_MONTHLY", "OFFSITE_ROOT", "REQUIRE_OFFSITE"}:
            result[key] = value.strip().strip("\"'")
    return result


def _parse_systemd_time(value: str | None) -> str | None:
    if not value or value in {"n/a", "0"}:
        return None
    match = re.fullmatch(r"[A-Za-z]{3} ([0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2})(?: [A-Za-z0-9+:-]+)?", value)
    if not match:
        return None
    parsed = datetime.strptime(match.group(1), "%Y-%m-%d %H:%M:%S").astimezone()
    return parsed.astimezone(timezone.utc).isoformat()


def read_timer_status(unit_name: str) -> tuple[dict[str, Any], list[str]]:
    command = [
        SYSTEMCTL_PATH, "show", unit_name, "--no-pager",
        "--property=LoadState", "--property=UnitFileState", "--property=ActiveState",
        "--property=NextElapseUSecRealtime", "--property=LastTriggerUSec",
    ]
    try:
        completed = subprocess.run(
            command,
            capture_output=True,
            check=False,
            env={"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LC_ALL": "C"},
            text=True,
            timeout=3,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired, OSError):
        return {
            "installed": False, "enabled": False, "active": False,
            "next_run_at": None, "last_trigger_at": None, "unit_name": unit_name,
        }, ["TIMER_UNAVAILABLE"]
    properties = {}
    for line in completed.stdout.splitlines():
        if "=" in line:
            key, value = line.split("=", 1)
            properties[key] = value
    installed = completed.returncode == 0 and properties.get("LoadState") not in {None, "not-found"}
    enabled_states = {"enabled", "enabled-runtime", "linked", "linked-runtime", "static"}
    return {
        "installed": installed,
        "enabled": installed and properties.get("UnitFileState") in enabled_states,
        "active": installed and properties.get("ActiveState") == "active",
        "next_run_at": _parse_systemd_time(properties.get("NextElapseUSecRealtime")),
        "last_trigger_at": _parse_systemd_time(properties.get("LastTriggerUSec")),
        "unit_name": unit_name,
    }, ([] if installed else ["TIMER_UNAVAILABLE"])


class BackupInspector:
    def __init__(self, config: AgentConfig) -> None:
        self.config = config

    def _backup_directory(self, backup_id: str) -> Path:
        validated = validate_backup_id(backup_id)
        candidate = self.config.backup_root / validated
        try:
            info = candidate.lstat()
        except FileNotFoundError as exc:
            raise AgentError("BACKUP_NOT_FOUND", "Backup was not found") from exc
        if not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode):
            raise AgentError("BACKUP_NOT_FOUND", "Backup was not found")
        root = self.config.backup_root.resolve(strict=False)
        resolved = candidate.resolve(strict=True)
        if resolved.parent != root:
            raise AgentError("BACKUP_NOT_FOUND", "Backup was not found")
        return candidate

    def _backup_size(self, root: Path) -> tuple[int | None, list[str]]:
        total = 0
        stack = [root]
        try:
            while stack:
                current = stack.pop()
                with os.scandir(current) as entries:
                    for entry in entries:
                        if entry.is_symlink():
                            continue
                        if entry.is_dir(follow_symlinks=False):
                            stack.append(Path(entry.path))
                        elif entry.is_file(follow_symlinks=False):
                            total += entry.stat(follow_symlinks=False).st_size
            return total, []
        except OSError:
            return None, ["SIZE_UNAVAILABLE"]

    def _is_protected(self, directory: Path) -> bool:
        marker = directory / "PROTECTED"
        try:
            info = marker.lstat()
        except FileNotFoundError:
            return False
        return stat.S_ISREG(info.st_mode) and not stat.S_ISLNK(info.st_mode)

    def backup_item(self, backup_id: str) -> dict[str, Any]:
        directory = self._backup_directory(backup_id)
        warnings: list[str] = []
        try:
            manifest = _read_bounded_json(
                directory / "metadata" / "manifest.json", 1_048_576,
                missing_code="MANIFEST_MISSING", corrupt_code="MANIFEST_CORRUPT",
            )
        except AgentError as exc:
            manifest = {}
            warnings.append(exc.code)
        protected = self._is_protected(directory)
        pre_upgrade = manifest.get("pre_upgrade") is True or protected
        explicit_type = _enum(manifest.get("backup_type"), BACKUP_TYPES)
        backup_type = "pre_upgrade" if pre_upgrade else explicit_type
        size_bytes, size_warnings = self._backup_size(directory)
        warnings.extend(size_warnings)
        created_at = _safe_iso(manifest.get("timestamp"))
        if created_at is None:
            created_at = datetime.fromtimestamp(directory.stat().st_mtime, timezone.utc).isoformat()
            warnings.append("CREATED_AT_FROM_FILESYSTEM")

        offsite_status = "unknown"
        try:
            receipt = _read_bounded_json(
                directory / "metadata" / "offsite-receipt.json", 131_072,
                missing_code="OFFSITE_RECEIPT_MISSING", corrupt_code="OFFSITE_RECEIPT_CORRUPT",
            )
            raw_status = receipt.get("status")
            receipt_mapping = {"skipped": "skipped_not_mounted"}
            offsite_status = _enum(receipt_mapping.get(raw_status, raw_status), OFFSITE_STATUSES)
        except AgentError as exc:
            warnings.append(exc.code)

        components: list[str] = []
        raw_components = manifest.get("detected_components")
        if isinstance(raw_components, list):
            for component in raw_components:
                if isinstance(component, str) and SAFE_COMPONENT_PATTERN.fullmatch(component):
                    components.append(component)
                else:
                    warnings.append("UNKNOWN_COMPONENT_OMITTED")
        return {
            "backup_id": backup_id,
            "created_at": created_at,
            "backup_type": backup_type,
            "size_bytes": size_bytes,
            "verification_status": _enum(manifest.get("verification_status"), VERIFICATION_STATUSES),
            "verified_at": _safe_iso(manifest.get("verified_at")),
            "offsite_status": offsite_status,
            "officechat_version": _safe_metadata(manifest.get("officechat_version")),
            "build_sha": _safe_metadata(manifest.get("build_sha"), build_sha=True),
            "alembic_revision": _safe_metadata(manifest.get("alembic_revision")),
            "postgresql_version": _safe_metadata(manifest.get("postgresql_version")),
            "pre_upgrade": pre_upgrade,
            "protected": protected,
            "warnings": list(dict.fromkeys(warnings)),
            "components": list(dict.fromkeys(components)),
        }

    def list_backups(self, page: int, limit: int) -> dict[str, Any]:
        if page < 1 or limit < 1 or limit > self.config.max_list_limit:
            raise AgentError("INVALID_PAGINATION", "Backup pagination is invalid")
        backup_ids: list[str] = []
        try:
            entries = list(os.scandir(self.config.backup_root))
        except FileNotFoundError:
            entries = []
        except OSError as exc:
            raise AgentError("BACKUP_ROOT_UNAVAILABLE", "Backup storage is unavailable") from exc
        for entry in entries:
            if not BACKUP_ID_PATTERN.fullmatch(entry.name) or entry.is_symlink():
                continue
            try:
                if entry.is_dir(follow_symlinks=False):
                    backup_ids.append(entry.name)
            except OSError:
                continue
        backup_ids.sort(reverse=True)
        total = len(backup_ids)
        offset = (page - 1) * limit
        selected = backup_ids[offset:offset + limit]
        items = []
        for backup_id in selected:
            try:
                items.append(self.backup_item(backup_id))
            except AgentError:
                continue
        return {"items": items, "page": page, "limit": limit, "total": total, "has_next": offset + limit < total}

    def status(self) -> dict[str, Any]:
        warnings: list[str] = []
        current_result = "unknown"
        last_run = None
        last_success = None
        status_missing = False
        try:
            raw_status = _read_bounded_json(
                self.config.status_file, 262_144,
                missing_code="STATUS_MISSING", corrupt_code="STATUS_CORRUPT",
            )
            current_result = _enum(raw_status.get("current_result"), CURRENT_RESULTS)
            last_run = _status_run(raw_status.get("last_run"))
            last_success = _status_run(raw_status.get("last_success"))
        except AgentError as exc:
            status_missing = exc.code == "STATUS_MISSING"
            warnings.append(exc.code)

        capacity = {"total_bytes": None, "used_bytes": None, "free_bytes": None, "usage_percent": None}
        try:
            stats = os.statvfs(self.config.backup_root)
            total = stats.f_blocks * stats.f_frsize
            free = stats.f_bavail * stats.f_frsize
            used = max(total - free, 0)
            capacity = {
                "total_bytes": total,
                "used_bytes": used,
                "free_bytes": free,
                "usage_percent": round((used / total) * 100, 1) if total else None,
            }
            if capacity["usage_percent"] is not None and capacity["usage_percent"] >= 90:
                warnings.append("BACKUP_STORAGE_LOW")
        except OSError:
            warnings.append("BACKUP_CAPACITY_UNAVAILABLE")

        timer, timer_warnings = read_timer_status(self.config.timer_unit)
        warnings.extend(timer_warnings)
        if timer.get("installed") and not timer.get("enabled"):
            warnings.append("TIMER_DISABLED")

        simple_config = _parse_simple_config(self.config.backup_config_path)
        retention = {}
        for field, key in (("daily", "KEEP_DAILY"), ("weekly", "KEEP_WEEKLY"), ("monthly", "KEEP_MONTHLY")):
            value = simple_config.get(key)
            retention[field] = int(value) if value and value.isdigit() else None
        offsite_configured = bool(simple_config.get("OFFSITE_ROOT"))
        offsite_required = simple_config.get("REQUIRE_OFFSITE") == "yes"
        offsite_status = last_run["offsite_status"] if last_run else "unknown"
        if not offsite_configured:
            warnings.append("OFFSITE_NOT_CONFIGURED")

        if status_missing:
            health = "never_run"
        elif current_result == "failure":
            health = "failed"
            warnings.append("LAST_BACKUP_FAILED")
        elif current_result == "success" and last_run and last_run["verification_status"] == "passed":
            health = "healthy"
        elif current_result == "success":
            health = "degraded"
        else:
            health = "unknown"
        if health == "healthy" and ("TIMER_DISABLED" in warnings or "BACKUP_STORAGE_LOW" in warnings):
            health = "degraded"
        return {
            "agent_status": "available",
            "backup_health": health,
            "current_result": current_result,
            "last_run": last_run,
            "last_success": last_success,
            "backup_root_capacity": capacity,
            "timer": timer,
            "retention": retention,
            "offsite": {"configured": offsite_configured, "required": offsite_required, "status": offsite_status},
            "warnings": list(dict.fromkeys(warnings)),
        }

    def completed_backup(self, backup_id: str) -> Path:
        directory = self._backup_directory(backup_id)
        marker = directory / "SUCCESS"
        try:
            info = marker.lstat()
        except FileNotFoundError as exc:
            raise AgentError("BACKUP_INCOMPLETE", "Backup is not complete") from exc
        if not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode):
            raise AgentError("BACKUP_INCOMPLETE", "Backup is not complete")
        return directory

    def latest_completed_backup_id(self) -> str | None:
        try:
            status = _read_bounded_json(
                self.config.status_file,
                262_144,
                missing_code="STATUS_MISSING",
                corrupt_code="STATUS_CORRUPT",
            )
        except AgentError:
            return None
        last_run = status.get("last_run")
        backup_id = last_run.get("backup_id") if isinstance(last_run, dict) else None
        try:
            validated = validate_backup_id(backup_id)
            self.completed_backup(validated)
        except AgentError:
            return None
        return validated

    def completed_backup_ids(self) -> set[str]:
        try:
            entries = os.scandir(self.config.backup_root)
        except FileNotFoundError:
            return set()
        except OSError as exc:
            raise AgentError("BACKUP_ROOT_UNAVAILABLE", "Backup storage is unavailable") from exc
        completed: set[str] = set()
        with entries:
            for entry in entries:
                if not BACKUP_ID_PATTERN.fullmatch(entry.name) or entry.is_symlink():
                    continue
                try:
                    self.completed_backup(entry.name)
                except AgentError:
                    continue
                completed.add(entry.name)
        return completed


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def validate_job_id(value: object) -> str:
    try:
        parsed = str(uuid.UUID(str(value)))
    except (ValueError, TypeError, AttributeError) as exc:
        raise AgentError("INVALID_JOB_ID", "Job identifier is invalid") from exc
    if value != parsed:
        raise AgentError("INVALID_JOB_ID", "Job identifier is invalid")
    return parsed


def validate_actor_user_id(value: object) -> str:
    try:
        parsed = str(uuid.UUID(str(value)))
    except (ValueError, TypeError, AttributeError) as exc:
        raise AgentError("INVALID_ACTOR", "Backup job actor is invalid") from exc
    if value != parsed:
        raise AgentError("INVALID_ACTOR", "Backup job actor is invalid")
    return parsed


def validate_actor_login(value: object) -> str:
    if not isinstance(value, str):
        raise AgentError("INVALID_ACTOR", "Backup job actor is invalid")
    login = value.strip()
    if not login or len(login) > 64 or _contains_control(login):
        raise AgentError("INVALID_ACTOR", "Backup job actor is invalid")
    return login


def executor_unit_name(operation: str, backup_id: str | None = None) -> str:
    if operation == "create_backup":
        if backup_id is not None:
            raise AgentError("INVALID_PARAMS", "Create backup does not accept a backup identifier")
        return CREATE_EXECUTOR_UNIT
    if operation == "verify_backup":
        return f"{VERIFY_EXECUTOR_UNIT_PREFIX}{validate_backup_id(backup_id)}.service"
    raise AgentError("UNKNOWN_OPERATION", "Backup job operation is not supported")


class SystemdJobExecutor:
    """Starts and observes only the installed OfficeChat executor units."""

    _SHOW_PROPERTIES = (
        "LoadState",
        "ActiveState",
        "SubState",
        "Result",
        "ExecMainCode",
        "ExecMainStatus",
        "ExecMainStartTimestampMonotonic",
        "InvocationID",
    )
    _LIST_ACTIVE_VERIFY_ARGUMENTS = (
        "list-units",
        "--type=service",
        "--state=activating,active,deactivating",
        "--plain",
        "--no-legend",
        "--no-pager",
        VERIFY_EXECUTOR_UNIT_GLOB,
    )

    def __init__(
        self,
        *,
        runner: Any = subprocess.run,
        sleep: Any = time.sleep,
        monotonic: Any = time.monotonic,
        poll_interval_seconds: float = 0.5,
    ) -> None:
        self._runner = runner
        self._sleep = sleep
        self._monotonic = monotonic
        self._poll_interval_seconds = poll_interval_seconds

    @staticmethod
    def _is_executor_unit(unit_name: str) -> bool:
        if unit_name == CREATE_EXECUTOR_UNIT:
            return True
        if not unit_name.startswith(VERIFY_EXECUTOR_UNIT_PREFIX) or not unit_name.endswith(".service"):
            return False
        backup_id = unit_name[len(VERIFY_EXECUTOR_UNIT_PREFIX):-len(".service")]
        try:
            validate_backup_id(backup_id)
        except AgentError:
            return False
        return True

    def _validate_systemctl_arguments(self, arguments: tuple[str, ...]) -> None:
        if not arguments:
            raise AgentError("EXECUTOR_UNAVAILABLE", "Backup executor control request is invalid")
        action = arguments[0]
        if action == "show" and len(arguments) >= 3:
            unit_name = arguments[1]
            expected = (
                "show",
                unit_name,
                "--no-pager",
                *(f"--property={name}" for name in self._SHOW_PROPERTIES),
            )
            if arguments == expected and (
                unit_name == SCHEDULED_BACKUP_UNIT or self._is_executor_unit(unit_name)
            ):
                return
        elif action == "reset-failed" and len(arguments) == 2:
            if self._is_executor_unit(arguments[1]):
                return
        elif action == "start" and len(arguments) == 3:
            if arguments[1] == "--no-block" and self._is_executor_unit(arguments[2]):
                return
        elif action == "stop" and len(arguments) == 2:
            if self._is_executor_unit(arguments[1]):
                return
        elif action == "list-units" and arguments == self._LIST_ACTIVE_VERIFY_ARGUMENTS:
            return
        raise AgentError("EXECUTOR_UNAVAILABLE", "Backup executor control request is invalid")

    def _systemctl(self, *arguments: str) -> subprocess.CompletedProcess[str]:
        self._validate_systemctl_arguments(arguments)
        try:
            completed = self._runner(
                [SYSTEMCTL_PATH, *arguments],
                shell=False,
                env=dict(SAFE_JOB_ENVIRONMENT),
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                text=True,
                timeout=SYSTEMCTL_COMMAND_TIMEOUT_SECONDS,
                check=False,
            )
        except subprocess.TimeoutExpired as exc:
            raise AgentError("EXECUTOR_TIMEOUT", "Backup executor control timed out") from exc
        except (FileNotFoundError, OSError, subprocess.SubprocessError) as exc:
            raise AgentError("EXECUTOR_UNAVAILABLE", "Backup executor is unavailable") from exc
        if len(completed.stdout.encode("utf-8", errors="replace")) > SYSTEMCTL_OUTPUT_MAX_BYTES:
            raise AgentError("EXECUTOR_UNAVAILABLE", "Backup executor returned invalid status")
        return completed

    def _show(self, unit_name: str) -> dict[str, str]:
        completed = self._systemctl(
            "show",
            unit_name,
            "--no-pager",
            *(f"--property={name}" for name in self._SHOW_PROPERTIES),
        )
        if completed.returncode != 0:
            raise AgentError("EXECUTOR_UNAVAILABLE", "Backup executor status is unavailable")
        status: dict[str, str] = {}
        for line in completed.stdout.splitlines():
            if "=" in line:
                key, value = line.split("=", 1)
                if key in self._SHOW_PROPERTIES:
                    status[key] = value
        if status.get("LoadState") != "loaded":
            raise AgentError("EXECUTOR_UNAVAILABLE", "Backup executor unit is unavailable")
        return status

    def _scheduled_backup_is_active(self) -> bool:
        status = self._show(SCHEDULED_BACKUP_UNIT)
        return status.get("ActiveState") in {"activating", "active", "deactivating"}

    def _active_verify_executor_units(self) -> tuple[str, ...]:
        completed = self._systemctl(*self._LIST_ACTIVE_VERIFY_ARGUMENTS)
        if completed.returncode != 0:
            raise AgentError("EXECUTOR_UNAVAILABLE", "Backup executor status is unavailable")
        active_units: list[str] = []
        for line in completed.stdout.splitlines():
            fields = line.split(None, 1)
            if not fields:
                continue
            unit_name = fields[0]
            if not unit_name.startswith(VERIFY_EXECUTOR_UNIT_PREFIX) or not self._is_executor_unit(unit_name):
                raise AgentError("EXECUTOR_UNAVAILABLE", "Backup executor returned invalid status")
            active_units.append(unit_name)
        return tuple(active_units)

    def _stop(self, unit_name: str) -> None:
        completed = self._systemctl("stop", unit_name)
        if completed.returncode != 0:
            logger.error("executor_unit=%s stop_failed", unit_name)

    def run(
        self,
        operation: str,
        backup_id: str | None,
        *,
        timeout_seconds: int,
        stop_event: threading.Event,
    ) -> int:
        unit_name = executor_unit_name(operation, backup_id)
        if self._scheduled_backup_is_active():
            raise AgentError("BACKUP_BUSY", "Another backup operation is already running")
        create_status = self._show(CREATE_EXECUTOR_UNIT)
        if create_status.get("ActiveState") in {"activating", "active", "deactivating"}:
            raise AgentError("BACKUP_BUSY", "Another backup operation is already running")
        if self._active_verify_executor_units():
            raise AgentError("BACKUP_BUSY", "Another backup operation is already running")
        previous = create_status if unit_name == CREATE_EXECUTOR_UNIT else self._show(unit_name)
        previous_invocation = previous.get("InvocationID") or ""
        previous_start = previous.get("ExecMainStartTimestampMonotonic") or "0"
        reset = self._systemctl("reset-failed", unit_name)
        if reset.returncode != 0:
            raise AgentError("EXECUTOR_UNAVAILABLE", "Backup executor state could not be reset")
        started = self._systemctl("start", "--no-block", unit_name)
        if started.returncode != 0:
            raise AgentError("EXECUTOR_UNAVAILABLE", "Backup executor could not be started")

        deadline = self._monotonic() + timeout_seconds
        invocation_seen = False
        while self._monotonic() < deadline:
            if stop_event.is_set():
                raise AgentError("JOB_INTERRUPTED", "Backup operation was interrupted")
            status = self._show(unit_name)
            invocation = status.get("InvocationID") or ""
            start_timestamp = status.get("ExecMainStartTimestampMonotonic") or "0"
            if (invocation and invocation != previous_invocation) or (
                start_timestamp not in {"0", previous_start}
            ):
                invocation_seen = True
            if invocation_seen and status.get("ActiveState") in {"inactive", "failed"}:
                try:
                    exit_code = int(status.get("ExecMainStatus") or "1")
                except ValueError:
                    exit_code = 1
                if status.get("Result") == "success" and exit_code == 0:
                    return 0
                if exit_code == EXECUTOR_BUSY_EXIT_CODE:
                    raise AgentError("BACKUP_BUSY", "Another backup operation is already running")
                error_code = "VERIFY_FAILED" if operation == "verify_backup" else "BACKUP_EXECUTION_FAILED"
                raise AgentError(error_code, "Backup executor reported a failure")
            self._sleep(self._poll_interval_seconds)

        self._stop(unit_name)
        raise AgentError("EXECUTOR_TIMEOUT", "Backup executor timed out")


class BackupJobManager:
    """Runs one fixed backup operation at a time and persists bounded public state."""

    def __init__(
        self,
        config: AgentConfig,
        inspector: BackupInspector,
        *,
        executor: SystemdJobExecutor | Any | None = None,
    ) -> None:
        self.config = config
        self.inspector = inspector
        self._executor = executor or SystemdJobExecutor()
        self._lock = threading.RLock()
        self._jobs: list[dict[str, Any]] = []
        self._stop_event = threading.Event()
        self._stopping = False
        self._state_file = config.state_directory / "jobs.json"
        self._prepare_state_directory()
        self._load_state()

    def _prepare_state_directory(self) -> None:
        try:
            info = self.config.state_directory.lstat()
        except FileNotFoundError:
            self.config.state_directory.mkdir(mode=0o700, parents=True)
            info = self.config.state_directory.lstat()
        if not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode) or info.st_uid != os.geteuid():
            raise RuntimeError("Backup agent state directory is unsafe")
        os.chmod(self.config.state_directory, 0o700)

    def _load_state(self) -> None:
        if not self._state_file.exists():
            return
        try:
            payload = _read_bounded_json(
                self._state_file,
                JOB_HISTORY_MAX_BYTES,
                missing_code="JOB_STATE_MISSING",
                corrupt_code="JOB_STATE_CORRUPT",
            )
            raw_jobs = payload.get("jobs")
            if payload.get("version") != JOB_HISTORY_VERSION or not isinstance(raw_jobs, list):
                raise AgentError("JOB_STATE_CORRUPT", "Backup job state is invalid")
            jobs = [self._validate_stored_job(job) for job in raw_jobs]
        except AgentError as exc:
            logger.error("Backup job state could not be loaded: %s", exc.code)
            jobs = []
        changed = False
        for job in jobs:
            if job["state"] in ACTIVE_JOB_STATES:
                job.update({
                    "state": "interrupted",
                    "phase": "interrupted",
                    "finished_at": _utc_now(),
                    "success": False,
                    "exit_code": None,
                    "safe_message": "Backup operation was interrupted by an agent restart",
                    "last_error": "JOB_INTERRUPTED",
                })
                changed = True
        self._jobs = jobs
        self._prune_reconciled_history()
        if changed:
            self._save_state()

    @staticmethod
    def _validate_stored_job(value: object) -> dict[str, Any]:
        if not isinstance(value, dict):
            raise AgentError("JOB_STATE_CORRUPT", "Backup job state is invalid")
        job_id = validate_job_id(value.get("job_id"))
        operation = value.get("operation")
        state = value.get("state")
        if operation not in JOB_OPERATIONS or state not in JOB_STATES:
            raise AgentError("JOB_STATE_CORRUPT", "Backup job state is invalid")
        backup_id = value.get("backup_id")
        if backup_id is not None:
            backup_id = validate_backup_id(backup_id)
        requested_by_user_id = value.get("requested_by_user_id")
        if requested_by_user_id is not None:
            requested_by_user_id = validate_actor_user_id(requested_by_user_id)
        requested_by_login = value.get("requested_by_login")
        if requested_by_login is not None:
            requested_by_login = validate_actor_login(requested_by_login)
        audit_claim_id = value.get("audit_claim_id")
        if audit_claim_id is not None:
            audit_claim_id = validate_job_id(audit_claim_id)
        result = {
            "job_id": job_id,
            "operation": operation,
            "state": state,
            "phase": str(value.get("phase") or state)[:64],
            "backup_id": backup_id,
            "requested_at": _safe_iso(value.get("requested_at")),
            "started_at": _safe_iso(value.get("started_at")),
            "finished_at": _safe_iso(value.get("finished_at")),
            "success": value.get("success") if isinstance(value.get("success"), bool) else None,
            "exit_code": value.get("exit_code") if isinstance(value.get("exit_code"), int) else None,
            "safe_message": str(value.get("safe_message") or "")[:300],
            "last_error": str(value.get("last_error") or "")[:64] or None,
            "requested_by_user_id": requested_by_user_id,
            "requested_by_login": requested_by_login,
            "audit_claim_id": audit_claim_id,
            "audit_claimed_at": _safe_iso(value.get("audit_claimed_at")),
            "audit_reconciled_at": _safe_iso(value.get("audit_reconciled_at")),
        }
        if result["requested_at"] is None:
            raise AgentError("JOB_STATE_CORRUPT", "Backup job state is invalid")
        return result

    def _save_state(self) -> None:
        payload = json.dumps(
            {"version": JOB_HISTORY_VERSION, "jobs": self._jobs},
            ensure_ascii=True,
            separators=(",", ":"),
        ).encode("utf-8")
        if len(payload) > JOB_HISTORY_MAX_BYTES:
            raise RuntimeError("Backup job state exceeds its size limit")
        temporary = self.config.state_directory / f".jobs-{uuid.uuid4().hex}.tmp"
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
        descriptor = os.open(temporary, flags, 0o600)
        try:
            os.write(descriptor, payload)
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
        try:
            os.replace(temporary, self._state_file)
            directory_fd = os.open(self.config.state_directory, os.O_RDONLY)
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)
        finally:
            temporary.unlink(missing_ok=True)

    @staticmethod
    def _public_job(job: dict[str, Any]) -> dict[str, Any]:
        fields = (
            "job_id", "operation", "state", "phase", "backup_id", "requested_at",
            "started_at", "finished_at", "success", "exit_code", "safe_message", "last_error",
        )
        return {field: job[field] for field in fields}

    @staticmethod
    def _audit_job(job: dict[str, Any]) -> dict[str, Any]:
        result = BackupJobManager._public_job(job)
        result.update({
            "requested_by_user_id": job.get("requested_by_user_id"),
            "requested_by_login": job.get("requested_by_login"),
        })
        return result

    def active_job(self) -> dict[str, Any] | None:
        with self._lock:
            job = next((item for item in reversed(self._jobs) if item["state"] in ACTIVE_JOB_STATES), None)
            return self._public_job(job) if job else None

    def get_job(self, job_id: str) -> dict[str, Any]:
        validated = validate_job_id(job_id)
        with self._lock:
            job = next((item for item in self._jobs if item["job_id"] == validated), None)
            if job is None:
                raise AgentError("JOB_NOT_FOUND", "Backup job was not found")
            return self._public_job(job)

    def _make_history_room(self) -> None:
        while len(self._jobs) >= self.config.max_job_history:
            removable_index = next((
                index
                for index, job in enumerate(self._jobs)
                if job["state"] in TERMINAL_JOB_STATES
                and job.get("audit_reconciled_at") is not None
            ), None)
            if removable_index is None:
                raise AgentError(
                    "AUDIT_BACKLOG_FULL",
                    "Backup audit backlog must be reconciled before another job can start",
                )
            self._jobs.pop(removable_index)

    def _prune_reconciled_history(self) -> None:
        while len(self._jobs) > self.config.max_job_history:
            removable_index = next((
                index
                for index, job in enumerate(self._jobs)
                if job["state"] in TERMINAL_JOB_STATES
                and job.get("audit_reconciled_at") is not None
            ), None)
            if removable_index is None:
                return
            self._jobs.pop(removable_index)

    def create_job(
        self,
        operation: str,
        *,
        requested_by_user_id: str,
        requested_by_login: str,
        backup_id: str | None = None,
    ) -> dict[str, Any]:
        if operation not in JOB_OPERATIONS:
            raise AgentError("UNKNOWN_OPERATION", "Backup job operation is not supported")
        if operation == "create_backup" and backup_id is not None:
            raise AgentError("INVALID_PARAMS", "Create backup does not accept a backup identifier")
        if operation == "verify_backup":
            backup_id = validate_backup_id(backup_id)
            self.inspector.completed_backup(backup_id)
        actor_user_id = validate_actor_user_id(requested_by_user_id)
        actor_login = validate_actor_login(requested_by_login)
        with self._lock:
            if self._stopping:
                raise AgentError("JOB_INTERRUPTED", "Backup agent is stopping")
            if self.active_job() is not None:
                raise AgentError("JOB_CONFLICT", "Another backup operation is already running")
            self._make_history_room()
            job = {
                "job_id": str(uuid.uuid4()),
                "operation": operation,
                "state": "queued",
                "phase": "queued",
                "backup_id": backup_id,
                "requested_at": _utc_now(),
                "started_at": None,
                "finished_at": None,
                "success": None,
                "exit_code": None,
                "safe_message": "Backup operation is queued",
                "last_error": None,
                "requested_by_user_id": actor_user_id,
                "requested_by_login": actor_login,
                "audit_claim_id": None,
                "audit_claimed_at": None,
                "audit_reconciled_at": None,
            }
            self._jobs.append(job)
            self._save_state()
            accepted = self._public_job(job)
            thread = threading.Thread(target=self._run_job, args=(job["job_id"],), daemon=True)
            thread.start()
            return accepted

    def claim_terminal_audit(self) -> dict[str, Any]:
        now = datetime.now(timezone.utc)
        with self._lock:
            for job in self._jobs:
                if job["state"] not in TERMINAL_JOB_STATES or job.get("audit_reconciled_at") is not None:
                    continue
                claimed_at = job.get("audit_claimed_at")
                if claimed_at is not None:
                    claimed = datetime.fromisoformat(claimed_at.replace("Z", "+00:00"))
                    if (now - claimed).total_seconds() < self.config.audit_claim_ttl_seconds:
                        continue
                claim_id = str(uuid.uuid4())
                job["audit_claim_id"] = claim_id
                job["audit_claimed_at"] = now.isoformat()
                self._save_state()
                return {"claim_id": claim_id, "job": self._audit_job(job)}
        return {"claim_id": None, "job": None}

    def complete_terminal_audit(self, job_id: str, claim_id: str) -> dict[str, Any]:
        validated_job_id = validate_job_id(job_id)
        validated_claim_id = validate_job_id(claim_id)
        with self._lock:
            job = next((item for item in self._jobs if item["job_id"] == validated_job_id), None)
            if job is None:
                raise AgentError("JOB_NOT_FOUND", "Backup job was not found")
            if job["state"] not in TERMINAL_JOB_STATES:
                raise AgentError("AUDIT_JOB_NOT_TERMINAL", "Backup job is not ready for audit")
            if job.get("audit_claim_id") != validated_claim_id:
                raise AgentError("AUDIT_CLAIM_INVALID", "Backup audit claim is invalid")
            if job.get("audit_reconciled_at") is None:
                job["audit_reconciled_at"] = _utc_now()
                self._save_state()
            return {"job_id": validated_job_id, "audit_reconciled_at": job["audit_reconciled_at"]}

    def release_terminal_audit(self, job_id: str, claim_id: str) -> dict[str, Any]:
        validated_job_id = validate_job_id(job_id)
        validated_claim_id = validate_job_id(claim_id)
        with self._lock:
            job = next((item for item in self._jobs if item["job_id"] == validated_job_id), None)
            if job is None:
                raise AgentError("JOB_NOT_FOUND", "Backup job was not found")
            if job["state"] not in TERMINAL_JOB_STATES:
                raise AgentError("AUDIT_JOB_NOT_TERMINAL", "Backup job is not ready for audit")
            if job.get("audit_reconciled_at") is not None:
                return {"job_id": validated_job_id, "released": False}
            if job.get("audit_claim_id") != validated_claim_id:
                raise AgentError("AUDIT_CLAIM_INVALID", "Backup audit claim is invalid")
            job["audit_claim_id"] = None
            job["audit_claimed_at"] = None
            self._save_state()
            return {"job_id": validated_job_id, "released": True}

    def _set_job(self, job: dict[str, Any], **changes: Any) -> None:
        with self._lock:
            job.update(changes)
            self._save_state()

    def _run_job(self, job_id: str) -> None:
        with self._lock:
            job = next(item for item in self._jobs if item["job_id"] == job_id)
            operation = job["operation"]
            backup_id = job["backup_id"]
        state = "verifying" if operation == "verify_backup" else "running"
        phase = "verifying" if operation == "verify_backup" else "running"
        self._set_job(
            job,
            state=state,
            phase=phase,
            started_at=_utc_now(),
            safe_message="Backup verification is running" if state == "verifying" else "Backup creation is running",
        )
        before_backup_ids: set[str] = set()
        agent_error: AgentError | None = None
        exit_code: int | None = None
        try:
            if operation == "create_backup":
                before_backup_ids = self.inspector.completed_backup_ids()
            with self._lock:
                if self._stopping:
                    raise AgentError("JOB_INTERRUPTED", "Backup operation was interrupted")
            exit_code = self._executor.run(
                operation,
                backup_id,
                timeout_seconds=self.config.executor_timeout_seconds,
                stop_event=self._stop_event,
            )
        except AgentError as exc:
            agent_error = exc
            logger.error("job_id=%s operation=%s agent_error=%s", job_id, operation, exc.code)
        except Exception:
            logger.exception("job_id=%s operation=%s executor_failure", job_id, operation)
            agent_error = AgentError("EXECUTOR_UNAVAILABLE", "Backup executor is unavailable")
        if self._stopping or (agent_error and agent_error.code == "JOB_INTERRUPTED"):
            self._set_job(
                job,
                state="interrupted",
                phase="interrupted",
                finished_at=_utc_now(),
                success=False,
                exit_code=exit_code,
                safe_message="Backup operation was interrupted",
                last_error="JOB_INTERRUPTED",
            )
            return
        if agent_error is None and exit_code == 0:
            if operation == "create_backup":
                try:
                    created_ids = self.inspector.completed_backup_ids() - before_backup_ids
                    latest_id = self.inspector.latest_completed_backup_id()
                except AgentError as exc:
                    logger.error("job_id=%s operation=%s result_error=%s", job_id, operation, exc.code)
                    created_ids = set()
                    latest_id = None
                backup_id = latest_id if latest_id in created_ids else (max(created_ids) if created_ids else None)
                if backup_id is None:
                    self._set_job(
                        job,
                        state="failed",
                        phase="error",
                        finished_at=_utc_now(),
                        success=False,
                        exit_code=0,
                        safe_message="Backup command finished without publishing a completed backup",
                        last_error="JOB_RESULT_UNAVAILABLE",
                    )
                    return
            self._set_job(
                job,
                state="succeeded",
                phase="completed",
                backup_id=backup_id,
                finished_at=_utc_now(),
                success=True,
                exit_code=0,
                safe_message="Backup verification completed" if operation == "verify_backup" else "Backup creation completed",
                last_error=None,
            )
        else:
            operation_error = "VERIFY_FAILED" if operation == "verify_backup" else "BACKUP_EXECUTION_FAILED"
            reported_errors = {
                "BACKUP_BUSY", "BACKUP_EXECUTION_FAILED", "VERIFY_FAILED",
                "EXECUTOR_UNAVAILABLE", "EXECUTOR_TIMEOUT",
            }
            error_code = (
                agent_error.code
                if agent_error is not None and agent_error.code in reported_errors
                else operation_error
            )
            safe_messages = {
                "BACKUP_BUSY": "Another backup operation is already running",
                "BACKUP_EXECUTION_FAILED": "Backup creation failed",
                "VERIFY_FAILED": "Backup verification failed",
                "EXECUTOR_UNAVAILABLE": "Backup executor is unavailable",
                "EXECUTOR_TIMEOUT": "Backup executor timed out",
            }
            self._set_job(
                job,
                state="failed",
                phase="error",
                finished_at=_utc_now(),
                success=False,
                exit_code=exit_code,
                safe_message=safe_messages.get(error_code, "Backup operation failed"),
                last_error=error_code,
            )

    def stop(self) -> None:
        with self._lock:
            self._stopping = True
            self._stop_event.set()
        deadline = time.monotonic() + 2
        while self.active_job() is not None and time.monotonic() < deadline:
            time.sleep(0.05)


class AgentProtocol:
    def __init__(self, inspector: BackupInspector, jobs: BackupJobManager | None = None) -> None:
        self.inspector = inspector
        self.jobs = jobs

    def handle(self, payload: object) -> dict[str, Any]:
        if not isinstance(payload, dict):
            raise AgentError("INVALID_REQUEST", "Request must be a JSON object")
        if set(payload) != {"protocol_version", "request_id", "operation", "params"}:
            raise AgentError("INVALID_REQUEST", "Request fields are invalid")
        if payload.get("protocol_version") != PROTOCOL_VERSION:
            raise AgentError("PROTOCOL_MISMATCH", "Unsupported backup agent protocol version")
        request_id = payload.get("request_id")
        try:
            parsed_request_id = str(uuid.UUID(str(request_id)))
        except (ValueError, TypeError, AttributeError) as exc:
            raise AgentError("INVALID_REQUEST_ID", "Request identifier is invalid") from exc
        if request_id != parsed_request_id:
            raise AgentError("INVALID_REQUEST_ID", "Request identifier is invalid")
        operation = payload.get("operation")
        params = payload.get("params")
        if not isinstance(params, dict):
            raise AgentError("INVALID_PARAMS", "Request parameters are invalid")
        if operation == "status":
            if params:
                raise AgentError("INVALID_PARAMS", "Status does not accept parameters")
            data = self.inspector.status()
        elif operation == "list_backups":
            if set(params) - {"page", "limit"}:
                raise AgentError("INVALID_PARAMS", "List parameters are invalid")
            page, limit = params.get("page", 1), params.get("limit", 25)
            if not isinstance(page, int) or isinstance(page, bool) or not isinstance(limit, int) or isinstance(limit, bool):
                raise AgentError("INVALID_PAGINATION", "Backup pagination is invalid")
            data = self.inspector.list_backups(page, limit)
        elif operation == "get_backup":
            if set(params) != {"backup_id"}:
                raise AgentError("INVALID_PARAMS", "Backup detail parameters are invalid")
            data = self.inspector.backup_item(validate_backup_id(params.get("backup_id")))
        elif operation == "create_backup":
            if set(params) != {"requested_by_user_id", "requested_by_login"}:
                raise AgentError("INVALID_PARAMS", "Create backup parameters are invalid")
            if self.jobs is None:
                raise AgentError("INTERNAL_ERROR", "Backup jobs are unavailable")
            data = self.jobs.create_job(
                "create_backup",
                requested_by_user_id=validate_actor_user_id(params.get("requested_by_user_id")),
                requested_by_login=validate_actor_login(params.get("requested_by_login")),
            )
        elif operation == "verify_backup":
            if set(params) != {"backup_id", "requested_by_user_id", "requested_by_login"}:
                raise AgentError("INVALID_PARAMS", "Backup verification parameters are invalid")
            if self.jobs is None:
                raise AgentError("INTERNAL_ERROR", "Backup jobs are unavailable")
            data = self.jobs.create_job(
                "verify_backup",
                backup_id=validate_backup_id(params.get("backup_id")),
                requested_by_user_id=validate_actor_user_id(params.get("requested_by_user_id")),
                requested_by_login=validate_actor_login(params.get("requested_by_login")),
            )
        elif operation == "get_job":
            if set(params) != {"job_id"}:
                raise AgentError("INVALID_PARAMS", "Backup job parameters are invalid")
            if self.jobs is None:
                raise AgentError("INTERNAL_ERROR", "Backup jobs are unavailable")
            data = self.jobs.get_job(validate_job_id(params.get("job_id")))
        elif operation == "get_active_job":
            if params:
                raise AgentError("INVALID_PARAMS", "Active backup job does not accept parameters")
            if self.jobs is None:
                raise AgentError("INTERNAL_ERROR", "Backup jobs are unavailable")
            data = {"job": self.jobs.active_job()}
        elif operation == "claim_job_audit":
            if params:
                raise AgentError("INVALID_PARAMS", "Backup audit claim does not accept parameters")
            if self.jobs is None:
                raise AgentError("INTERNAL_ERROR", "Backup jobs are unavailable")
            data = self.jobs.claim_terminal_audit()
        elif operation in {"complete_job_audit", "release_job_audit"}:
            if set(params) != {"job_id", "claim_id"}:
                raise AgentError("INVALID_PARAMS", "Backup audit acknowledgement parameters are invalid")
            if self.jobs is None:
                raise AgentError("INTERNAL_ERROR", "Backup jobs are unavailable")
            job_id = validate_job_id(params.get("job_id"))
            claim_id = validate_job_id(params.get("claim_id"))
            data = (
                self.jobs.complete_terminal_audit(job_id, claim_id)
                if operation == "complete_job_audit"
                else self.jobs.release_terminal_audit(job_id, claim_id)
            )
        else:
            raise AgentError("UNKNOWN_OPERATION", "Backup agent operation is not supported")
        return {"protocol_version": PROTOCOL_VERSION, "request_id": parsed_request_id, "ok": True, "data": data}


def error_response(request_id: object, error: AgentError) -> dict[str, Any]:
    safe_request_id = request_id if isinstance(request_id, str) and len(request_id) <= 64 else None
    return {
        "protocol_version": PROTOCOL_VERSION,
        "request_id": safe_request_id,
        "ok": False,
        "error": {"code": error.code, "message": error.safe_message},
    }


class BackupAgentRequestHandler(socketserver.StreamRequestHandler):
    def handle(self) -> None:
        server = self.server
        assert isinstance(server, BackupAgentServer)
        self.connection.settimeout(server.config.io_timeout_seconds)
        raw = self.rfile.readline(server.config.request_max_bytes + 2)
        request_id: object = None
        try:
            if not raw.endswith(b"\n") or len(raw) > server.config.request_max_bytes + 1:
                raise AgentError("REQUEST_TOO_LARGE", "Backup agent request is too large")
            try:
                payload = json.loads(raw.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError) as exc:
                raise AgentError("INVALID_JSON", "Backup agent request contains invalid JSON") from exc
            if isinstance(payload, dict):
                request_id = payload.get("request_id")
            response = server.protocol.handle(payload)
        except AgentError as exc:
            response = error_response(request_id, exc)
            logger.warning("request_id=%s result=%s", request_id or "-", exc.code)
        except Exception:
            response = error_response(request_id, AgentError("INTERNAL_ERROR", "Backup metadata could not be read"))
            logger.exception("request_id=%s result=internal_error", request_id or "-")
        encoded = (json.dumps(response, ensure_ascii=True, separators=(",", ":")) + "\n").encode("utf-8")
        if len(encoded) > server.config.response_max_bytes:
            encoded = (json.dumps(error_response(request_id, AgentError("RESPONSE_TOO_LARGE", "Backup metadata response is too large"))) + "\n").encode("utf-8")
        try:
            self.wfile.write(encoded)
        except (BrokenPipeError, ConnectionResetError, socket.timeout):
            return


class BackupAgentServer(socketserver.ThreadingUnixStreamServer):
    daemon_threads = True
    allow_reuse_address = False

    def __init__(
        self,
        config: AgentConfig,
        inspector: BackupInspector,
        jobs: BackupJobManager | None = None,
    ) -> None:
        self.config = config
        self.protocol = AgentProtocol(inspector, jobs)
        super().__init__(str(config.socket_path), BackupAgentRequestHandler)


def _prepare_socket_path(config: AgentConfig) -> int:
    parent = config.socket_path.parent
    if not parent.is_dir() or parent.is_symlink():
        raise RuntimeError("Agent runtime directory is unavailable or unsafe")
    existing = None
    try:
        existing = config.socket_path.lstat()
    except FileNotFoundError:
        pass
    if existing is not None:
        if not stat.S_ISSOCK(existing.st_mode) or existing.st_uid != os.geteuid():
            raise RuntimeError("Refusing to replace an unsafe socket path")
        config.socket_path.unlink()
    return grp.getgrnam(config.socket_group).gr_gid


def serve(config: AgentConfig) -> None:
    socket_gid = _prepare_socket_path(config)
    inspector = BackupInspector(config)
    jobs = BackupJobManager(config, inspector)
    server = BackupAgentServer(config, inspector, jobs)
    os.chown(config.socket_path, -1, socket_gid)
    os.chmod(config.socket_path, 0o660)
    stop_event = threading.Event()

    def stop(_signum: int, _frame: object) -> None:
        stop_event.set()

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    server.timeout = 1
    logger.info("OfficeChat backup agent started")
    try:
        while not stop_event.is_set():
            server.handle_request()
    finally:
        jobs.stop()
        server.server_close()
        try:
            config.socket_path.unlink()
        except FileNotFoundError:
            pass
        logger.info("OfficeChat backup agent stopped")


def main() -> int:
    parser = argparse.ArgumentParser(description="OfficeChat backup metadata and job agent")
    parser.add_argument("--config", default="/etc/officechat/backup-agent.conf")
    parser.add_argument("--check-config", action="store_true")
    arguments = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    try:
        config = load_agent_config(Path(arguments.config))
        if arguments.check_config:
            return 0
        serve(config)
    except (AgentError, OSError, RuntimeError, ValueError) as exc:
        logger.error("Backup agent failed to start: %s", exc)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
