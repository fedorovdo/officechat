# OfficeChat Backup Center v0.1

Backup Center — раздел для `superadmin`, который показывает состояние production backup-системы OfficeChat и запускает ручное создание полной локальной копии или безопасный verify-only выбранной копии. Страница доступна по `/ru/admin/backups`. Она не удаляет и не восстанавливает копии, не меняет расписание, retention или off-site настройки.

## Архитектура

```text
Browser -> OfficeChat backend -> Unix socket -> officechat-backup-agent
                                             -> backup metadata
                                             -> fixed allowlisted backup/verify argv
                                             -> systemd timer status
```

Backend не получает backup root, Docker socket, systemd D-Bus или содержимое dump/uploads. Host-side agent работает отдельным root-owned systemd service, читает ограниченный набор metadata и запускает только фиксированные argv без shell. Протокол поддерживает чтение metadata/jobs, `create_backup`, `verify_backup` и безопасное подтверждение terminal audit claim. Клиент не может передать executable, config path, environment или дополнительные argv.

Job state хранится атомарно в root-owned `/var/lib/officechat-backup-agent` с mode `0700`; backend этот каталог не монтирует. Одновременно выполняется одна операция. После рестарта незавершённая job становится `interrupted`. Полный stdout/stderr остаётся в journald и не попадает в API или state JSON.

Terminal audit не зависит от открытой страницы и frontend polling. Job хранит только снимок ID/login инициатора. При любом последующем GET Backup Center backend атомарно получает один pending terminal claim, проверяет существующий audit по `job_id`, выполняет commit и лишь затем подтверждает reconciliation agent. При ошибке commit claim освобождается; при потере acknowledgement он восстанавливается после `AUDIT_CLAIM_TTL_SECONDS`, а проверка correlation в БД предотвращает дубликат.

Socket по умолчанию: `/run/officechat-backup-agent/agent.sock`. Он имеет mode `0660`, owner `root` и group `officechat-backup`. Только backend получает supplementary GID и read-only bind runtime-каталога. Frontend и calendar-worker socket не получают.

## Что отображается

- доступность agent и общее backup health;
- последний запуск и последняя успешная копия;
- verification и off-site status без destination path;
- свободное место backup root без раскрытия его пути;
- статус установленного timer;
- текущие read-only retention значения;
- история backup, version/build/Alembic/PostgreSQL metadata и обнаруженные компоненты.

Legacy backup без надёжного признака типа отображается как `unknown`. Повреждённые или отсутствующие metadata дают безопасное warning-состояние без traceback, config content или filesystem path.

## Установка и обновление

Release bundle содержит:

- `backup-agent.py`;
- `backup/officechat-backup-agent.conf.example`;
- `systemd/officechat-backup-agent.service`;
- этот документ и существующую документацию backup/restore.

Installer создаёт system group `officechat-backup`, устанавливает root-owned `/etc/officechat/backup-agent.conf`, запускает agent service и передаёт backend numeric GID. Существующий agent config при update не перезаписывается. `StateDirectory` создаётся systemd. Установка agent не запускает backup и не включает `officechat-backup.timer`: timer включается только отдельным явным решением оператора.

Uninstaller останавливает и отключает agent, удаляет его systemd unit, после чего systemd удаляет runtime-каталог с socket. Backup data, `/etc/officechat/backup.conf`, `/etc/officechat/backup-agent.conf` и system group сохраняются для восстановления или повторной установки.

## Диагностика

```bash
sudo systemctl status officechat-backup-agent.service
sudo journalctl -u officechat-backup-agent.service --since today
sudo stat /run/officechat-backup-agent/agent.sock
docker compose --env-file /opt/officechat/.env -f /opt/officechat/docker-compose.yml exec backend id
```

На production с SELinux Enforcing после ручного запуска через UI проверьте:

```bash
getenforce
sudo journalctl -u officechat-backup-agent.service --since today
sudo journalctl -u officechat-backup.service --since today
sudo ls -Zd /run/officechat-backup-agent /var/backups/officechat /var/lib/officechat
sudo find /var/backups/officechat/production -maxdepth 3 -type f \( -name manifest.json -o -name SUCCESS -o -name SHA256SUMS \) -print
```

Убедитесь, что backend видит только socket mount `ro,z`, а PostgreSQL/Valkey/uploads сохранили предусмотренные `:Z`/`:z` labels. SELinux отключать нельзя.

Если agent недоступен, `/api/admin/backups/status` возвращает HTTP 200 с `agent_status=unavailable`; list/detail возвращают безопасный 503. Обычная локальная разработка без systemd agent продолжает работать, а UI показывает понятное unavailable-состояние.

Создание и verify-only доступны в Backup Center после отдельного подтверждения. Те же операции через CLI:

```bash
sudo /opt/officechat/backup-production.sh --config /etc/officechat/backup.conf
```

```bash
/opt/officechat/restore-production.sh \
  --config /etc/officechat/backup.conf \
  --backup-id officechat-backup-YYYYMMDD-HHMMSSZ \
  --verify-only
```

В Backup Center намеренно нет кнопки restore. Production restore выполняется только через SSH и остаётся отдельной подтверждаемой disaster-recovery процедурой из [BACKUP_RESTORE_RU.md](BACKUP_RESTORE_RU.md).

## Безопасность metadata

API и UI не возвращают local/off-site paths, credentials, private config, dump filenames, upload filenames, usernames или message metadata. Agent не принимает произвольные пути, unit names или команды; backup ID проходит строгую full-match и realpath-проверку, а verify допускает только каталог с `SUCCESS`. Запросы и job history ограничены по размеру, symlink metadata и backup directories отклоняются, subprocess использует только фиксированный argv без shell. Backend container по-прежнему не получает Docker socket, backup root или state directory.
