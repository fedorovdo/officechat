#!/usr/bin/env bash
set -Eeuo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
test_dir="$(mktemp -d)"
trap 'rm -rf -- "$test_dir"' EXIT
mkdir -p "$test_dir/bin" "$test_dir/assets" "$test_dir/release"

version=0.1.0-test-upgrade
name="officechat-${version}-linux-amd64.tar.gz"
printf '%s\n' "$version" >"$test_dir/release/VERSION"
printf '{"version":"%s","backend_image":"ghcr.io/fedorovdo/officechat-backend:%s","frontend_image":"ghcr.io/fedorovdo/officechat-frontend:%s"}\n' \
  "$version" "$version" "$version" >"$test_dir/release/RELEASE.json"
cat >"$test_dir/release/update-linux.sh" <<'EOF_UPDATE'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$OFFICECHAT_TEST_UPDATER_MARKER"
EOF_UPDATE
(
  cd "$test_dir/release"
  sha256sum VERSION RELEASE.json update-linux.sh >CHECKSUMS.sha256
)
tar -C "$test_dir" -czf "$test_dir/assets/$name" release
(
  cd "$test_dir/assets"
  sha256sum "$name" >"${name}.sha256"
)

cat >"$test_dir/bin/id" <<'EOF_ID'
#!/usr/bin/env bash
[[ "$1" == "-u" ]] || exit 1
printf '0\n'
EOF_ID
cat >"$test_dir/bin/curl" <<'EOF_CURL'
#!/usr/bin/env bash
set -Eeuo pipefail
output=""
url=""
while (($#)); do
  case "$1" in
    --output) output="$2"; shift 2 ;;
    --connect-timeout|--max-time|--max-filesize|--proto|--proto-redir|--retry)
      shift 2 ;;
    --*) shift ;;
    *) url="$1"; shift ;;
  esac
done
[[ -n "$output" && -n "$url" ]] || exit 2
cp "$OFFICECHAT_TEST_ASSETS/${url##*/}" "$output"
EOF_CURL
chmod +x "$test_dir/bin/id" "$test_dir/bin/curl"
cat >"$test_dir/bin/docker" <<'EOF_DOCKER'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$OFFICECHAT_TEST_DOCKER_LOG"
[[ "${OFFICECHAT_TEST_DOCKER_FAIL:-0}" == 0 ]]
EOF_DOCKER
chmod +x "$test_dir/bin/docker"

run_upgrade() {
  env PATH="$test_dir/bin:$PATH" \
    OFFICECHAT_TEST_ASSETS="$test_dir/assets" \
    OFFICECHAT_TEST_UPDATER_MARKER="$test_dir/updater-called" \
    OFFICECHAT_TEST_DOCKER_LOG="$test_dir/docker-called" \
    OFFICECHAT_RELEASE_BASE_URL=https://example.test/releases/download \
    bash "$script_dir/upgrade-linux.sh" "$@"
}

bash "$script_dir/upgrade-linux.sh" --help >/dev/null
run_upgrade "$version" --dry-run >/dev/null
[[ "$(cat "$test_dir/updater-called")" == "$version --dry-run" ]]
[[ ! -e "$test_dir/docker-called" ]]
rm -f "$test_dir/updater-called"

run_upgrade "$version" >/dev/null
[[ "$(cat "$test_dir/updater-called")" == $'0.1.0-test-upgrade --dry-run\n0.1.0-test-upgrade' ]]
[[ "$(wc -l <"$test_dir/docker-called")" == 2 ]]
rm -f "$test_dir/updater-called" "$test_dir/docker-called"

if OFFICECHAT_TEST_DOCKER_FAIL=1 run_upgrade "$version" >"$test_dir/failed.log" 2>&1; then
  echo 'Failed GHCR preflight was accepted' >&2
  exit 1
fi
[[ "$(cat "$test_dir/updater-called")" == "$version --dry-run" ]]
rm -f "$test_dir/updater-called" "$test_dir/docker-called"

printf '%s\n' "${name}: bad sidecar" >"$test_dir/assets/${name}.sha256"
if run_upgrade "$version" >"$test_dir/failed.log" 2>&1; then
  echo 'Checksum mismatch was accepted' >&2
  exit 1
fi
[[ ! -e "$test_dir/updater-called" ]]
(
  cd "$test_dir/assets"
  sha256sum "$name" >"${name}.sha256"
)

python3 - "$test_dir/assets/$name" <<'PY'
import io
import sys
import tarfile

with tarfile.open(sys.argv[1], "w:gz") as archive:
    entry = tarfile.TarInfo("release/../escaped")
    entry.size = 1
    archive.addfile(entry, io.BytesIO(b"x"))
PY
(
  cd "$test_dir/assets"
  sha256sum "$name" >"${name}.sha256"
)
if run_upgrade "$version" >"$test_dir/failed.log" 2>&1; then
  echo 'Unsafe archive was accepted' >&2
  exit 1
fi
[[ ! -e "$test_dir/updater-called" && ! -e "$test_dir/escaped" ]]

printf 'release upgrade verification tests passed\n'
