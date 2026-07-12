# Backup and restore

OfficeChat хранит данные в PostgreSQL и файлы в uploads volume. Надежный backup должен включать оба слоя как один набор.

## Backup

Windows:

```powershell
.\scripts\backup-postgres.ps1 -Destination backups -RetentionDays 14
```

Linux:

```bash
DESTINATION=backups RETENTION_DAYS=14 ./scripts/backup-postgres.sh
```

Backup создает каталог вида:

```text
backups/officechat_2026-07-11_190000/
  officechat_2026-07-11_190000.dump
  officechat_uploads_2026-07-11_190000.tar.gz
  metadata.json
```

`metadata.json` содержит дату создания, имя dump, имя uploads archive и текущую Alembic revision.

## Restore

Restore является destructive operation. Перед restore backend должен быть остановлен. Скрипты требуют явное подтверждение:

```text
RESTORE OFFICECHAT
```

Windows:

```powershell
.\scripts\restore-postgres.ps1 -BackupDir backups\officechat_2026-07-11_190000
```

Linux:

```bash
./scripts/restore-postgres.sh backups/officechat_2026-07-11_190000
```

После restore:

```bash
docker compose exec backend alembic current
curl http://localhost:8100/ready
```

## Recovery test

Backup нельзя считать проверенным только потому, что `pg_dump` завершился успешно.

Периодически выполняйте recovery test:

1. создать тестовые сообщения, вложения, pins и broadcast;
2. создать database + uploads backup;
3. восстановить backup в отдельную test environment;
4. запустить сервисы;
5. проверить login;
6. проверить group/direct/discussion messages;
7. скачать attachment;
8. проверить pins;
9. проверить broadcasts;
10. проверить Alembic revision и `/ready`.

## Release bundle backup/update/rollback

В release install `officechatctl backup` создает PostgreSQL dump, архив uploads и metadata в `/var/backups/officechat`.
Перед `update-linux.sh` backup выполняется по умолчанию. Флаг `--no-backup` разрешен только с явным предупреждением.

`rollback-linux.sh VERSION` выполняет только image rollback и не откатывает базу. Полное восстановление из backup доступно через `rollback-linux.sh --full-restore BACKUP_DIR` и требует точного подтверждения:

```text
RESTORE OFFICECHAT
```
