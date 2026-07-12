#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "${SCRIPT_DIR}/lib.sh"

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  cat <<'EOF_HELP'
Usage: verify-install.sh [--dry-run]
Checks OfficeChat service health without printing secrets.
EOF_HELP
  exit 0
fi
if [[ "${1:-}" == "--dry-run" ]]; then set_dry_run; fi

require_docker_compose

failures=0
compose ps || failures=$((failures + 1))
if compose exec -T backend python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=5).read()" >/dev/null 2>&1; then
  pass "Backend /health responds"
else
  warn "Backend /health failed"; failures=$((failures + 1))
fi
if compose exec -T backend python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/ready', timeout=5).read()" >/dev/null 2>&1; then
  pass "Backend /ready responds"
else
  warn "Backend /ready failed"; failures=$((failures + 1))
fi
if compose exec -T backend alembic current >/dev/null; then
  pass "Alembic current works"
else
  warn "Alembic current failed"
  failures=$((failures + 1))
fi
if is_dry_run; then
  warn "Uploads writable mutation probe skipped in dry-run mode"
else
  if compose exec -T backend python -c "from pathlib import Path; p=Path('/data/uploads/.verify'); p.write_text('ok'); p.unlink()" >/dev/null; then
    pass "Uploads are writable"
  else
    warn "Uploads writable check failed"
    failures=$((failures + 1))
  fi
fi
if compose logs --tail=100 backend 2>/dev/null | grep -Eiq 'Traceback|QueuePool|ValidationError'; then
  warn "Recent backend logs contain possible errors"
else
  pass "Recent backend logs have no known fatal patterns"
fi

if [[ "$failures" -gt 0 ]]; then
  fail "${failures} verification check(s) failed"
fi
pass "OfficeChat verification completed"
