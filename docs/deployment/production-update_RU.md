# Безопасное production-обновление

Запускайте обновление из распакованного bundle целевой версии:

```bash
sudo ./officechatctl update VERSION
```

`RELEASE.json` связывает версию с точным commit SHA, UTC build date и именами
backend/frontend images. Updater отклоняет повреждённые или несовпадающие metadata
до изменения production-файлов.

## Порядок Compose

Все эксплуатационные команды используют стек:

1. `/opt/officechat/docker-compose.yml`;
2. опциональный `/opt/officechat/docker-compose.https-override.yml`;
3. опциональный управляемый updater файл
   `/opt/officechat/docker-compose.version-override.yml`.

Финальный override закрепляет backend и calendar-worker на точном backend image,
а frontend на точном frontend image. Он также задаёт публичные version, revision и
build date. Legacy HTTPS override может содержать старые image tags, но не
редактируется и не может перекрыть последний слой. Не используйте ручные команды
с неполным списком `-f`.

До mutation updater собирает staging stack из копии `.env`, нового base Compose,
существующего HTTPS override и временного final override. Проверяются resolved
images, localhost bind frontend, public network, SELinux labels и изоляция socket.
Resolved config и secrets не выводятся. Metadata в `.env` и final override
заменяются атомарно.

При ошибке migration или readiness восстанавливаются предыдущие Compose, final
override, `.env`, agent/executor units, config/executable агента, backup scripts и application containers. Database
downgrade не выполняется. Backup data, `backup.conf`, HTTPS override, Caddy volumes,
PostgreSQL data и uploads не удаляются.

Updater независимо сохраняет enabled и active state backup agent. Он устанавливает фиксированные executor assets до `daemon-reload`, перезапускает agent только если тот был active, проверяет новый socket как `root:officechat-backup` mode `0660` и принудительно пересоздаёт backend, чтобы bind mount получил текущий inode socket. Timer и расписание backup не меняются. Тот же порядок применяется при rollback частично выполненного update.

Перед обновлением выполните процедуру защищённой pre-upgrade копии из документа
[«Резервное копирование, проверка и восстановление»](../BACKUP_RESTORE_RU.md).
После обновления проверьте [Центр резервного копирования](../BACKUP_CENTER_RU.md),
сокет агента, состояние таймера и последнюю успешную копию. Каноническая
процедура production-восстановления находится в руководстве по резервному
копированию и здесь не дублируется.

## Acceptance на SELinux Enforcing

На RED OS/RHEL-like хосте не отключайте SELinux:

```bash
getenforce
sudo systemctl restart officechat-backup-agent
sudo stat -c '%U %G %a' /run/officechat-backup-agent/agent.sock
sudo systemctl status officechat-backup-job.service
sudo journalctl -u officechat-backup-job.service --since today
sudo ausearch -m AVC,USER_AVC -ts recent
sudo ls -Zd /run/officechat-backup-agent /var/lib/officechat/{postgres,valkey,uploads}
sudo /opt/officechat/officechatctl restart
sudo /opt/officechat/officechatctl health
```

Socket должен оставаться `root:officechat-backup` mode `0660`. Только backend
получает read-only bind с shared SELinux label и supplementary GID. Calendar-worker
и frontend не должны видеть socket. После пересоздания backend проверьте статус
Backup Center. Не используйте `label=disable`, privileged и world-writable socket.
