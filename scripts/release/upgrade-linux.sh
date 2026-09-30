#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'EOF_HELP'
Usage: upgrade-linux.sh VERSION [--dry-run]

Download and verify the exact GitHub Release bundle, then run its updater.
Run as root on an existing OfficeChat server. This command does not select a
version automatically and never downloads deployment files from main.
EOF_HELP
}

[[ $# -gt 0 ]] || { usage; exit 2; }
case "$1" in --help|-h) usage; exit 0 ;; esac
[[ "$(id -u)" -eq 0 ]] || fail "Run as root"
version="$1"
shift
dry_run=0
case "${1:-}" in
  --dry-run) dry_run=1; shift ;;
esac
[[ $# -eq 0 ]] || fail "Unknown argument: $1"
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9._-]+)?$ ]] ||
  fail "Invalid OfficeChat version"

for command_name in curl python3 mktemp; do
  command -v "$command_name" >/dev/null 2>&1 ||
    fail "Required command not found: $command_name"
done

release_base="${OFFICECHAT_RELEASE_BASE_URL:-https://github.com/fedorovdo/officechat/releases/download}"
[[ "$release_base" == https://* ]] || fail "Release URL must use HTTPS"
asset_base="${release_base%/}/v${version}"
bundle_name="officechat-${version}-linux-amd64.tar.gz"
work_dir="$(mktemp -d "${TMPDIR:-/tmp}/officechat-upgrade.XXXXXX")"
trap 'rm -rf -- "$work_dir"' EXIT

for asset_name in "$bundle_name" "${bundle_name}.sha256"; do
  printf 'Downloading %s\n' "$asset_name"
  curl --fail --location --silent --show-error --retry 3 \
    --proto '=https' --proto-redir '=https' \
    --connect-timeout 15 --max-time 300 --max-filesize 33554432 \
    --output "${work_dir}/${asset_name}" "${asset_base}/${asset_name}" ||
    fail "Could not download ${asset_name}; installed version was not changed"
done

python3 - "$work_dir" "$bundle_name" "$version" <<'PY' ||
import hashlib
import os
from pathlib import Path, PurePosixPath
import re
import sys
import tarfile

root, name, version = Path(sys.argv[1]), sys.argv[2], sys.argv[3]
bundle = root / name
sidecar = root / (name + ".sha256")
line = sidecar.read_text(encoding="ascii").splitlines()
if len(line) != 1:
    raise SystemExit("Invalid checksum sidecar: expected one line")
match = re.fullmatch(r"([a-fA-F0-9]{64})  ?\*?([^\s]+)", line[0])
if not match or match.group(2) != name:
    raise SystemExit("Invalid checksum sidecar: unexpected digest or filename")
digest = hashlib.sha256(bundle.read_bytes()).hexdigest()
if digest != match.group(1).lower():
    raise SystemExit("Bundle SHA-256 mismatch")
print("PASS: Bundle SHA-256 verified")

release = root / "release"
seen = set()
total = 0
with tarfile.open(bundle, "r:gz") as archive:
    members = archive.getmembers()
    if not members or len(members) > 512:
        raise SystemExit("Invalid release archive member count")
    for member in members:
        path = PurePosixPath(member.name)
        parts = path.parts
        if (not parts or parts[0] != "release" or
                any(part in (".", "..") for part in member.name.split("/")) or
                "\\" in member.name or "\x00" in member.name or
                any(ord(char) < 32 for char in member.name) or
                str(path) in seen or not (member.isdir() or member.isfile())):
            raise SystemExit("Unsafe release archive member")
        seen.add(str(path))
        total += member.size
        if member.size > 16 * 1024 * 1024 or total > 64 * 1024 * 1024:
            raise SystemExit("Release archive exceeds size limit")
    for member in members:
        destination = root.joinpath(*PurePosixPath(member.name).parts)
        if member.isdir():
            destination.mkdir(mode=0o700, parents=True, exist_ok=True)
        else:
            destination.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            source = archive.extractfile(member)
            if source is None:
                raise SystemExit("Cannot read release file")
            with source, destination.open("xb") as output:
                while chunk := source.read(1024 * 1024):
                    output.write(chunk)
            destination.chmod(0o700 if member.mode & 0o111 else 0o600)

required = ("VERSION", "RELEASE.json", "CHECKSUMS.sha256", "update-linux.sh")
if any(not (release / item).is_file() for item in required):
    raise SystemExit("Required release file is missing")
if (release / "VERSION").read_text(encoding="ascii").strip() != version:
    raise SystemExit("Release version does not match requested version")

lines = (release / "CHECKSUMS.sha256").read_text(encoding="ascii").splitlines()
checked = set()
for line in lines:
    match = re.fullmatch(r"([a-fA-F0-9]{64})  \*?(.+)", line)
    if not match:
        raise SystemExit("Invalid inner checksum record")
    relative = PurePosixPath(match.group(2))
    if (relative.is_absolute() or any(part in (".", "..") for part in
            match.group(2).split("/")) or str(relative) in checked):
        raise SystemExit("Unsafe inner checksum path")
    checked.add(str(relative))
    file = release.joinpath(*relative.parts)
    if not file.is_file() or hashlib.sha256(file.read_bytes()).hexdigest() != match.group(1).lower():
        raise SystemExit("Inner release checksum mismatch")
expected = {str(path.relative_to(release)) for path in release.rglob("*")
            if path.is_file() and path.name != "CHECKSUMS.sha256"}
if checked != expected:
    raise SystemExit("Inner checksums do not cover all release files")
print("PASS: Inner release checksums verified")
PY
  fail "Release verification failed; installed version was not changed"

args=("$version")
if [[ "$dry_run" == "1" ]]; then
  args+=(--dry-run)
else
  printf 'Checking the target release update plan.\n'
  bash "${work_dir}/release/update-linux.sh" "$version" --dry-run
  command -v docker >/dev/null 2>&1 || fail "Docker is required for the image preflight"
  image_list="$(python3 - "${work_dir}/release/RELEASE.json" "$version" <<'PY'
import json
from pathlib import Path
import sys

metadata = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
version = sys.argv[2]
if metadata.get("version") != version:
    raise SystemExit("Release metadata version mismatch")
for service in ("backend", "frontend"):
    expected = f"ghcr.io/fedorovdo/officechat-{service}:{version}"
    if metadata.get(f"{service}_image") != expected:
        raise SystemExit("Unexpected release image reference")
    print(expected)
PY
  )" || fail "Release image metadata validation failed"
  while IFS= read -r image_ref; do
    printf 'Checking release image access: %s\n' "$image_ref"
    docker pull --quiet "$image_ref" >/dev/null ||
      fail "Cannot access release image; check root Docker GHCR login (read:packages)"
  done <<<"$image_list"
fi
printf 'Starting verified OfficeChat %s updater.\n' "$version"
bash "${work_dir}/release/update-linux.sh" "${args[@]}"
