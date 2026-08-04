# OfficeChat Backup Center v0.1

Backup Center — read-only раздел для `superadmin`, который показывает состояние существующей production backup-системы OfficeChat. Страница доступна по `/ru/admin/backups`. Она не запускает создание, проверку, удаление, очистку или восстановление резервных копий и не изменяет расписание, retention или off-site настройки.

## Архитектура

```text
Browser -> OfficeChat backend -> Unix socket -> officechat-backup-agent
                                             -> backup metadata (read-only)
                                             -> systemd timer status
```

Backend не получает backup root, Docker socket, systemd D-Bus или содержимое dump/uploads. Host-side agent работает отдельным root-owned systemd service, читает только ограниченный набор metadata и возвращает нормализованный JSON. Поддерживаются только операции `status`, `list_backups` и `get_backup`.

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

Installer создаёт system group `officechat-backup`, устанавливает root-owned `/etc/officechat/backup-agent.conf`, запускает agent service и передаёт backend numeric GID. Существующий agent config при update не перезаписывается. Установка agent не запускает backup и не включает `officechat-backup.timer`: timer включается только отдельным явным решением оператора.

Uninstaller останавливает и отключает agent, удаляет его systemd unit, после чего systemd удаляет runtime-каталог с socket. Backup data, `/etc/officechat/backup.conf`, `/etc/officechat/backup-agent.conf` и system group сохраняются для восстановления или повторной установки.

## Диагностика

```bash
sudo systemctl status officechat-backup-agent.service
sudo journalctl -u officechat-backup-agent.service --since today
sudo stat /run/officechat-backup-agent/agent.sock
docker compose --env-file /opt/officechat/.env -f /opt/officechat/docker-compose.yml exec backend id
```

Если agent недоступен, `/api/admin/backups/status` возвращает HTTP 200 с `agent_status=unavailable`; list/detail возвращают безопасный 503. Обычная локальная разработка без systemd agent продолжает работать, а UI показывает понятное unavailable-состояние.

Проверьте выбранную копию только через серверный CLI:

```bash
/opt/officechat/restore-production.sh \
  --config /etc/officechat/backup.conf \
  --backup-id officechat-backup-YYYYMMDD-HHMMSSZ \
  --verify-only
```

В Backup Center намеренно нет кнопки restore. Production restore остаётся отдельной подтверждаемой disaster-recovery процедурой из [BACKUP_RESTORE_RU.md](BACKUP_RESTORE_RU.md).

## Безопасность metadata

API и UI не возвращают local/off-site paths, credentials, private config, dump filenames, upload filenames, usernames или message metadata. Agent не принимает произвольные пути, unit names или команды; backup ID проходит строгую full-match проверку. Запросы ограничены по размеру и времени, symlink metadata и backup directories отклоняются, subprocess использует только фиксированный `systemctl` argv без shell.
