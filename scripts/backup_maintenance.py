#!/usr/bin/env python3
"""Allowlisted backup deletion/retention executor. Never accepts filesystem paths from HTTP."""
from __future__ import annotations

import argparse
import fcntl
import hashlib
import json
import os
import re
import shutil
import stat
import sys
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

CONFIG = Path('/etc/officechat/backup.conf')
STATE = Path('/var/lib/officechat-backup-agent/maintenance')
RELEASE_LOCK = Path('/tmp/officechat-release.lock')
ID = re.compile(r'officechat-backup-[0-9]{8}-[0-9]{6}Z')
UUID = re.compile(r'[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}')


class MaintenanceError(Exception):
    pass


def now():
    return datetime.now(timezone.utc)


def read_json(path, limit=524288):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, 'rb') as stream:
        if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
            raise MaintenanceError('UNSAFE_BACKUP')
        data = stream.read(limit + 1)
    if len(data) > limit:
        raise MaintenanceError('UNSAFE_BACKUP')
    return json.loads(data)


def atomic_json(path, data):
    temporary = path.with_name('.' + uuid.uuid4().hex)
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, 'w') as stream:
            json.dump(data, stream, ensure_ascii=True)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def config_values(path=CONFIG):
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o077:
        raise MaintenanceError('UNSAFE_CONFIG')
    result = {}
    for line in path.read_text().splitlines():
        if line.strip() and not line.lstrip().startswith('#'):
            key, value = line.split('=', 1)
            result[key.strip()] = value.strip().strip('\"\'')
    return result


def mounted_paths():
    result = {}
    for line in Path('/proc/self/mountinfo').read_text().splitlines():
        left, right = line.split(' - ', 1)
        unescape = lambda s: re.sub(r'\\([0-7]{3})', lambda m: chr(int(m[1], 8)), s)
        result[unescape(left.split()[4])] = right.split()[0]
    return result


def roots(values, location):
    if location not in {'local', 'offsite', 'both'}:
        raise MaintenanceError('INVALID_PARAMS')
    result = {}
    for name, key in (('local', 'BACKUP_ROOT'), ('offsite', 'OFFSITE_ROOT')):
        if location != 'both' and location != name:
            continue
        raw = values.get(key, '/var/backups/officechat/production' if name == 'local' else '')
        if not raw:
            if location == 'both':
                continue
            raise MaintenanceError('OFFSITE_NOT_MOUNTED')
        path = Path(raw)
        if not path.is_absolute() or str(path.resolve()) != raw or len(path.parts) < 3:
            raise MaintenanceError('UNSAFE_BACKUP')
        if name == 'offsite' and mounted_paths().get(raw) not in {'cifs', 'nfs', 'nfs4'}:
            raise MaintenanceError('OFFSITE_NOT_MOUNTED')
        if not path.is_dir():
            raise MaintenanceError('BACKUP_ROOT_UNAVAILABLE')
        result[name] = path
    if len(set(result.values())) != len(result):
        raise MaintenanceError('UNSAFE_BACKUP')
    return result


def regular(path):
    try:
        return stat.S_ISREG(path.lstat().st_mode)
    except FileNotFoundError:
        return False


def inventory(root):
    result = {}
    for path in root.iterdir():
        if not ID.fullmatch(path.name) or not stat.S_ISDIR(path.lstat().st_mode):
            continue
        try:
            datetime.strptime(path.name[18:], '%Y%m%d-%H%M%SZ')
            complete = regular(path / 'SUCCESS')
            try:
                if not stat.S_ISDIR((path / 'metadata').lstat().st_mode):
                    raise MaintenanceError('UNSAFE_BACKUP')
                metadata = read_json(path / 'metadata/manifest.json')
                if not isinstance(metadata, dict):
                    raise MaintenanceError('UNSAFE_BACKUP')
            except (OSError, ValueError, TypeError, MaintenanceError):
                metadata, complete = {}, False
            info = path.lstat()
            digest = hashlib.sha256(json.dumps(metadata, sort_keys=True).encode()).hexdigest()
            result[path.name] = {'complete': complete, 'verified': complete and metadata.get('verification_status') == 'passed',
                                 'protected': os.path.lexists(path / 'PROTECTED'),
                                 'identity': [info.st_dev, info.st_ino, info.st_mtime_ns, digest]}
        except (OSError, ValueError, TypeError, MaintenanceError):
            continue
    return result


def retained_last(items):
    verified = [key for key, item in items.items() if item['verified']]
    complete = [key for key, item in items.items() if item['complete']]
    return max(verified or complete, default=None)


def validate_policy(policy):
    if (not isinstance(policy, dict) or set(policy) != {'mode', 'days'}
            or policy['mode'] not in {'gfs', 'days', 'disabled'}
            or type(policy['days']) is not int or not 1 <= policy['days'] <= 3650):
        raise MaintenanceError('INVALID_PARAMS')
    return policy


def policy(values):
    return validate_policy({'mode': values.get('RETENTION_MODE', 'gfs'),
                            'days': int(values.get('RETENTION_DAYS', '30'))})


def preview(values, params, current=None):
    current = current or now()
    if set(params) != {'backup_ids', 'location', 'include_protected'}:
        raise MaintenanceError('INVALID_PARAMS')
    ids = params['backup_ids']
    if (not isinstance(ids, list) or not 1 <= len(ids) <= 50 or len(set(ids)) != len(ids)
            or any(not isinstance(key, str) or not ID.fullmatch(key) for key in ids)
            or type(params['include_protected']) is not bool):
        raise MaintenanceError('INVALID_PARAMS')
    result = []
    for location, root in roots(values, params['location']).items():
        items = inventory(root)
        last = retained_last(items)
        for key in ids:
            item = items.get(key)
            reason = ('MISSING_OR_INCOMPLETE' if item is None else 'LAST_VERIFIED_COPY' if key == last
                      else 'PROTECTED' if item['protected'] and not params['include_protected'] else None)
            result.append({'backup_id': key, 'location': location, 'reason': reason,
                           'protected': bool(item and item['protected']), 'incomplete': bool(item and not item['complete']),
                           'identity': item['identity'] if item else None,
                           'root_identity': [root.stat().st_dev, root.stat().st_ino]})
    return result


def remove_backup(root, key, expected):
    # Python's fd-based rmtree does not follow symlinks; reject nested mountpoints too.
    if not shutil.rmtree.avoids_symlink_attacks or not ID.fullmatch(key):
        raise MaintenanceError('UNSAFE_BACKUP')
    path = root / key
    if any(name == str(path) or name.startswith(str(path) + '/') for name in mounted_paths()):
        raise MaintenanceError('UNSAFE_BACKUP')
    if inventory(root).get(key, {}).get('identity') != expected:
        raise MaintenanceError('PREVIEW_EXPIRED')
    fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        info = os.stat(key, dir_fd=fd, follow_symlinks=False)
        if not stat.S_ISDIR(info.st_mode) or [info.st_dev, info.st_ino, info.st_mtime_ns] != expected[:3]:
            raise MaintenanceError('PREVIEW_EXPIRED')
        shutil.rmtree(key, dir_fd=fd)
    finally:
        os.close(fd)


def execute_delete(values, data, directory=STATE):
    params = data['params']
    if set(params) != {'preview_id', 'confirm_protected'} or type(params['confirm_protected']) is not bool or not UUID.fullmatch(params['preview_id']):
        raise MaintenanceError('INVALID_PARAMS')
    previous = read_json(directory / (params['preview_id'] + '.json'))
    if (previous['operation'] != 'preview_delete' or previous['state'] != 'succeeded'
            or previous['requested_by_user_id'] != data['requested_by_user_id']
            or now() - datetime.fromisoformat(previous['finished_at']) > timedelta(minutes=10)):
        raise MaintenanceError('PREVIEW_EXPIRED')
    plan = preview(values, previous['params'])
    if plan != previous['targets'] or previous['config_hash'] != hashlib.sha256(CONFIG.read_bytes()).hexdigest():
        raise MaintenanceError('PREVIEW_EXPIRED')
    if any(item['protected'] and item['reason'] is None for item in plan) and not params['confirm_protected']:
        raise MaintenanceError('PROTECTED')
    locations = roots(values, previous['params']['location'])
    data['results'] = []
    for item in plan:
        outcome = {'backup_id': item['backup_id'], 'location': item['location'], 'result': 'skipped', 'reason': item['reason']}
        if not item['reason']:
            try:
                # Recheck the last verified copy and protection immediately before each deletion.
                fresh = preview(values, previous['params'])
                candidate = next(v for v in fresh if v['backup_id'] == item['backup_id'] and v['location'] == item['location'])
                if candidate != item:
                    raise MaintenanceError('PREVIEW_EXPIRED')
                remove_backup(locations[item['location']], item['backup_id'], item['identity'])
                outcome.update(result='deleted', reason=None)
            except (OSError, MaintenanceError):
                outcome.update(result='failed', reason='DELETE_FAILED')
        data['results'].append(outcome)
        atomic_json(directory / (data['request_id'] + '.json'), data)
        print(json.dumps({'actor': data['requested_by_user_id'], **outcome}), flush=True)
    if any(item['result'] == 'failed' for item in data['results']):
        raise MaintenanceError('DELETE_FAILED')


def save_policy(values, params):
    validate_policy(params)
    text = CONFIG.read_text()
    for key, value in (('RETENTION_MODE', params['mode']), ('RETENTION_DAYS', str(params['days']))):
        pattern = re.compile(r'^' + key + r'\s*=.*$', re.M)
        if len(pattern.findall(text)) > 1:
            raise MaintenanceError('UNSAFE_CONFIG')
        text = pattern.sub(key + '=' + value, text) if pattern.search(text) else text.rstrip('\n') + '\n' + key + '=' + value + '\n'
    temporary = CONFIG.with_name('.backup-retention-' + uuid.uuid4().hex)
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, 'w') as stream:
            stream.write(text)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, CONFIG)
    finally:
        temporary.unlink(missing_ok=True)


def rotate(root, days, dry_run=False, current=None):
    if type(days) is not int or not 1 <= days <= 3650:
        raise MaintenanceError('INVALID_PARAMS')
    items = inventory(root)
    last = retained_last(items)
    cutoff = (current or now()) - timedelta(days=days)
    for key, item in sorted(items.items()):
        created = datetime.strptime(key[18:], '%Y%m%d-%H%M%SZ').replace(tzinfo=timezone.utc)
        if not item['complete'] or key == last or item['protected'] or created >= cutoff:
            continue
        print(('DRY-RUN: rotate ' if dry_run else 'Rotating old backup: ') + str(root / key), flush=True)
        if not dry_run:
            remove_backup(root, key, item['identity'])


def preview_retention(values, params):
    validate_policy(params)
    cutoff = now() - timedelta(days=params['days'])
    result = []
    for location, root in roots(values, 'both').items():
        items = inventory(root)
        last = retained_last(items)
        for key, item in sorted(items.items()):
            created = datetime.strptime(key[18:], '%Y%m%d-%H%M%SZ').replace(tzinfo=timezone.utc)
            if not item['complete'] or params['mode'] != 'days' or created >= cutoff:
                continue
            result.append({'backup_id': key, 'location': location, 'protected': item['protected'],
                           'reason': 'LAST_VERIFIED_COPY' if key == last else 'PROTECTED' if item['protected'] else None})
            if len(result) > 1000:
                raise MaintenanceError('CATALOG_TOO_LARGE')
    return result


def boot_id():
    return Path('/proc/sys/kernel/random/boot_id').read_text().strip()


def recover(request_id, only_previous_boot=False):
    if not UUID.fullmatch(request_id):
        return
    path = STATE / (request_id + '.json')
    if not path.exists():
        return
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) != 0o600:
        raise MaintenanceError('UNSAFE_CONFIG')
    data = read_json(path)
    if only_previous_boot and data.get('boot_id') == boot_id():
        return
    owner = RELEASE_LOCK / 'maintenance-owner'
    if regular(owner) and owner.read_text().strip() == request_id:
        owner.unlink()
        RELEASE_LOCK.rmdir()
    if data.get('state') in {'queued', 'running'}:
        data.update(state='failed', error_code='MAINTENANCE_INTERRUPTED', finished_at=now().isoformat())
        atomic_json(path, data)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('request_id', nargs='?')
    parser.add_argument('--rotate-root')
    parser.add_argument('--days', type=int)
    parser.add_argument('--last-verified-root')
    parser.add_argument('--dry-run', action='store_true')
    parser.add_argument('--recover', action='store_true')
    parser.add_argument('--recover-all', action='store_true')
    args = parser.parse_args()
    if args.recover_all:
        if STATE.is_dir() and not STATE.is_symlink():
            for path in STATE.glob('*.json'):
                recover(path.stem, only_previous_boot=True)
        return 0
    if args.recover:
        recover(args.request_id or '')
        return 0
    if args.last_verified_root:
        print(retained_last(inventory(Path(args.last_verified_root))) or "")
        return 0
    if args.rotate_root:
        rotate(Path(args.rotate_root), args.days, args.dry_run)
        return 0
    if not args.request_id or not UUID.fullmatch(args.request_id):
        return 1
    path = STATE / (args.request_id + '.json')
    info = path.lstat()
    if info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) != 0o600:
        return 1
    data = read_json(path)
    if data.get('request_id') != args.request_id or data.get('state') != 'queued':
        return 1
    data.update(state='running', boot_id=boot_id())
    atomic_json(path, data)
    release_lock = RELEASE_LOCK
    acquired = False
    try:
        values = config_values()
        lock_path = Path(values.get('LOCK_FILE', '/run/lock/officechat/backup.lock'))
        lock_path.parent.mkdir(parents=True, exist_ok=True)
        with lock_path.open('a') as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                release_lock.mkdir(mode=0o700)
                acquired = True
                (release_lock / 'maintenance-owner').write_text(args.request_id)
            except (BlockingIOError, FileExistsError):
                raise MaintenanceError('MAINTENANCE_BUSY')
            operation = data['operation']
            if operation == 'preview_delete':
                data['targets'] = preview(values, data['params'])
                data['config_hash'] = hashlib.sha256(CONFIG.read_bytes()).hexdigest()
            elif operation == 'preview_retention':
                data['targets'] = preview_retention(values, data['params'])
            elif operation == 'delete':
                execute_delete(values, data)
            elif operation == 'retention':
                save_policy(values, data['params'])
            else:
                raise MaintenanceError('INVALID_PARAMS')
        data['state'] = 'succeeded'
    except Exception as exc:
        data.update(state='failed', error_code=str(exc) if isinstance(exc, MaintenanceError) else 'MAINTENANCE_FAILED')
    finally:
        if acquired:
            (release_lock / 'maintenance-owner').unlink(missing_ok=True)
            release_lock.rmdir()
        data['finished_at'] = now().isoformat()
        atomic_json(path, data)
        print(json.dumps({key: data.get(key) for key in ('request_id', 'operation', 'requested_by_user_id', 'state', 'error_code')}), flush=True)
    return 0 if data['state'] == 'succeeded' else 1


if __name__ == '__main__':
    sys.exit(main())
