# Постоянное сохранение каталога сокета backup-agent

Для действующего тестового Debian RC13.39. Запускать под root в период,
когда не выполняются backup/restore, очистка, настройка хранилища или обновление.
Операция перезапускает только агент; контейнер backend не перезапускается.
Drop-in сохраняется после reboot, но каталог в `/run` при reboot создаётся заново.
Исправление исходного unit для будущих установок — commit `c1a7b17`
в ветке кандидата RC14 (первоначальное локальное исправление `692ff98`).

```bash
bash <<'BASH'
set -Eeuo pipefail
[[ "$EUID" -eq 0 ]] || { echo 'Нужен root'; exit 1; }
systemctl is-active --quiet officechat-backup-agent.service
for unit in officechat-backup.service officechat-backup-job.service; do
  state="$(systemctl show "$unit" -p ActiveState --value)"
  case "$state" in
    active|activating|deactivating) echo "Занята служба: $unit"; exit 1 ;;
  esac
done

check_dir="$(mktemp -d /root/officechat-socket-fix.XXXXXX)"
echo "CHECK_DIR=$check_dir"
trap 'echo "Проверка остановлена; диагностика: $check_dir" >&2' ERR
runtime_dir=/run/officechat-backup-agent
dropin_dir=/etc/systemd/system/officechat-backup-agent.service.d
dropin="$dropin_dir/90-preserve-runtime.conf"
inode_before="$(stat -c '%d:%i' "$runtime_dir")"
backend_before="$(docker inspect -f '{{.Id}} {{.State.StartedAt}}' officechat-backend-1)"
sha256sum /etc/officechat/backup.conf /etc/officechat/backup-agent.conf \
  /opt/officechat/.env > "$check_dir/config.sha256"

probe() {
  docker exec -i officechat-backend-1 python - <<'PY'
import asyncio
import json
from app.services.backup_agent import get_backup_agent_client

async def main():
    result = await get_backup_agent_client().request("status")
    if result.get("agent_status") != "available":
        raise RuntimeError("Agent is not available")
    keys = ("agent_status", "backup_health", "retention", "timer", "offsite", "warnings")
    print(json.dumps({k: result.get(k) for k in keys}, ensure_ascii=False))

asyncio.run(main())
PY
}

probe | tee "$check_dir/status.before.json"
mkdir -p "$dropin_dir"
if [[ -e "$dropin" ]]; then
  cp -a "$dropin" "$check_dir/dropin.before"
fi
printf '[Service]\nRuntimeDirectoryPreserve=yes\n' > "$dropin"
chmod 0644 "$dropin"
systemctl daemon-reload
[[ "$(systemctl show officechat-backup-agent.service -p RuntimeDirectoryPreserve --value)" == yes ]]

for round in 1 2; do
  systemctl restart officechat-backup-agent.service
  ready=0
  for attempt in {1..10}; do
    if probe > "$check_dir/status.after-$round.json" 2> "$check_dir/probe.error"; then
      ready=1
      break
    fi
    sleep 1
  done
  [[ "$ready" -eq 1 ]] || { cat "$check_dir/probe.error"; exit 1; }
  [[ "$(stat -c '%d:%i' "$runtime_dir")" == "$inode_before" ]]
  [[ "$(docker inspect -f '{{.Id}} {{.State.StartedAt}}' officechat-backend-1)" == "$backend_before" ]]
  sha256sum --check "$check_dir/config.sha256"
  cat "$check_dir/status.after-$round.json"
  echo "AGENT_RESTART_${round}=PASS"
done
echo 'BACKUP_AGENT_RUNTIME_FIX=PASS'
BASH
```

Успешный результат — два `AGENT_RESTART_N=PASS` и
`BACKUP_AGENT_RUNTIME_FIX=PASS`. Сохранить вывод для отчёта. При ошибке не
продолжать перезапуски или пересоздание backend: сначала проверить диагностику.

Это проверка рестарта агента. Полный reboot, обновление bundle и чистая
установка остаются отдельными этапами приёмки.
