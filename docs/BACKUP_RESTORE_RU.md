# Резервное копирование и восстановление OfficeChat

## Последовательное руководство оператора

### 1. Назначение резервного копирования
Backup защищает authoritative PostgreSQL и uploads, но локальная копия на той же VM не защищает от потери VM или диска.

### 2. Что входит в backup
В копию входят полный PostgreSQL dump, uploads, metadata/checksums, deployment-конфигурация и настроенные дополнительные компоненты.

### 3. Что не входит в backup
Job state Backup Center, runtime socket, временные restore-drill ресурсы и пересоздаваемое состояние не являются данными восстановления.

### 4. Каталог хранения
Каталог задаётся `BACKUP_ROOT` в root-owned `/etc/officechat/backup.conf`; backend и браузер этот путь не получают.

### 5. Структура backup
Завершённая копия имеет ID `officechat-backup-YYYYMMDD-HHMMSSZ`, manifest, `SHA256SUMS` и атомарный marker `SUCCESS`.

### 6. Создание backup через Backup Center
`superadmin` нажимает «Создать резервную копию» и подтверждает запуск. Выполняется одна host-side job; UI опрашивает её до terminal state.

### 7. Создание backup через CLI
```bash
sudo /opt/officechat/backup-production.sh --config /etc/officechat/backup.conf
```

### 8. Проверка backup через Backup Center
В окне завершённой копии нажмите «Проверить копию». Agent запускает только фиксированный verify-only argv для выбранного безопасного backup ID.

### 9. Проверка backup через CLI
```bash
sudo /opt/officechat/restore-production.sh --config /etc/officechat/backup.conf --verify-only --backup-id officechat-backup-YYYYMMDD-HHMMSSZ
```

### 10. Просмотр состояния timer
```bash
sudo systemctl status officechat-backup.timer
sudo systemctl list-timers officechat-backup.timer
```

### 11. Включение и выключение timer
```bash
sudo systemctl enable --now officechat-backup.timer
sudo systemctl disable --now officechat-backup.timer
```

### 12. Текущее расписание
Проверьте установленный unit командой `sudo systemctl cat officechat-backup.timer`; Backup Center расписание не редактирует.

### 13. Политика GFS 14/8/12
Defaults `KEEP_DAILY=14`, `KEEP_WEEKLY=8`, `KEEP_MONTHLY=12` применяются backup-скриптом. UI показывает значения только для чтения.

### 14. Защищённые pre-upgrade backups
`backup-production.sh --config /etc/officechat/backup.conf --pre-upgrade` создаёт копию с marker `PROTECTED`.

### 15. Освобождение места
Сначала проверьте `df -h` и GFS. Backup Center не удаляет и не prune-копии; удаление выполняет оператор по утверждённой процедуре.

### 16. Безопасный verify-only
Verify-only создаёт изолированные временные Docker resources, проверяет dump/uploads и очищает их; production PostgreSQL и uploads не изменяются.

### 17. Тестовое восстановление на клоне VM
Проверяйте disaster recovery на изолированном клоне с копией конфигурации и без доступа клиентов, затем выполняйте post-restore acceptance.

### 18. Production restore
Restore запускается только через SSH локальным уполномоченным оператором с полным набором подтверждений фактического CLI. Backup Center restore не запускает.

### 19. Восстановление на новой VM
Сначала установите совместимую OfficeChat/PostgreSQL среду и приватную конфигурацию, затем перенесите backup и следуйте production restore процедуре.

### 20. Что происходит с PostgreSQL
Restore разворачивает полный dump в staged database, проверяет Alembic revision и атомарно переключает базы. Автоматический database downgrade не выполняется.

### 21. Что происходит с uploads
Uploads распаковываются в staging, проверяются и переключаются с сохранением rollback-каталога до приёмки.

### 22. Что происходит с Valkey
Valkey не authoritative; durable данные находятся в PostgreSQL. Best-effort RDB может сохраняться, но runtime state безопасно перестраивается.

### 23. Что происходит с deployment config
Публичная и приватная конфигурация архивируются отдельно. Приватный archive требует защиты и никогда не должен публиковаться.

### 24. Что происходит с Caddy CA
Внутренний Caddy CA восстанавливается отдельно, чтобы сохранить доверие LAN-клиентов; он является секретным компонентом.

### 25. Проверки после restore
Проверьте `/ready`, frontend `/api/health`, Alembic current, вход пользователей, сообщения, uploads и журналы.

### 26. Rollback и safety backup
Перед production restore фактический скрипт создаёт защищённый pre-restore backup и сохраняет rollback database/uploads до operator acceptance.

### 27. Журналы и диагностика
Используйте `journalctl -u officechat-backup-agent.service`, `journalctl -u officechat-backup.service` и безопасные status endpoints; секреты не копируйте в обращения.

### 28. Типовые ошибки
Проверяйте свободное место, активный lock/timer job, `SUCCESS`, checksums, Docker, SELinux и доступность agent socket.

### 29. SELinux
SELinux не отключается. Сохраняются `:Z` для PostgreSQL/Valkey, `:z` для uploads и `ro,z` для agent socket; после ручного переноса используйте корректные contexts.

### 30. Ограничения Backup Center
Center не меняет schedule/GFS/off-site, не удаляет, не скачивает и не восстанавливает backup, не показывает dump/config и не поддерживает cancel/queue. Restore — только SSH/CLI.

## Архитектура

Production backup состоит из независимых, проверяемых компонентов:

- полный логический PostgreSQL dump в custom format (`pg_dump -Fc`);
- архив uploads с правами, владельцами, ACL, xattrs и SELinux labels;
- отдельные публичный и приватный архивы deployment-конфигурации;
- best-effort RDB snapshot Valkey;
- защищённый архив внутреннего Caddy CA;
- дополнительные каталоги из `BACKUP_EXTRA_PATHS`;
- metadata, SHA-256 checksums и атомарный `SUCCESS` marker;
- опциональные frontend/backend images для release/pre-upgrade backup.

Скрипты не используют фиксированные container names, Compose-generated names или
container IDs. Сервисы обнаруживаются через настроенные Compose-файлы и
`docker compose ... ps -q SERVICE`.

Текущая установка использует основной Compose и опциональные HTTPS/final version
overrides. `COMPOSE_OPTIONAL_FILES` добавляет оба слоя, если они существуют, и не
ломает установку при их отсутствии. Generated version override входит в публичные
deployment metadata, а приватный `.env` остаётся защищённым.

## Критичные данные

Обязательны для полноценного восстановления:

1. PostgreSQL: пользователи, сообщения, группы, обсуждения, уведомления, календарь,
   аудит, metadata вложений и Alembic revision.
2. Uploads: вложения и аватары.

Дополнительные критичные для конкретной установки данные:

- приватный deployment archive содержит `.env` и `backup.conf`;
- Caddy CA сохраняет доверие уже настроенных LAN-клиентов;
- внешние каталоги, явно перечисленные в `BACKUP_EXTRA_PATHS`.

Valkey сейчас не является authoritative source. Presence, typing, rate limits и
временные состояния восстанавливаются после запуска; durable calendar state
находится в PostgreSQL. RDB snapshot сохраняется best-effort и его сбой отмечается
warning в manifest. Не копируйте live Valkey/PostgreSQL data directories вслепую.

PostgreSQL dump имеет согласованный snapshot внутри БД, но dump и uploads
создаются последовательно и не являются общей транзакцией. По умолчанию это
`best_effort_live`, отражённый в manifest. Для строгой согласованности настройте
root-owned pre/post hooks, которые ставят запись вложений на паузу и гарантированно
снимают её. Регулярный restore drill должен дополнительно проверять выборку
вложений приложения.

`pg_dump` одной базы не сохраняет cluster roles. На новой VM application role и
database создаются installer/Compose из private `.env`; restore использует
`--no-owner --no-privileges`, поэтому восстановленные объекты принадлежат
настроенному `POSTGRES_USER`. Password hashes ролей в backup не включаются.
Valkey snapshot не восстанавливается production-скриптом автоматически:
authoritative данные находятся в PostgreSQL, а ephemeral state безопасно
перестраивается после запуска.

## Установка

Release installer:

- устанавливает скрипты в `/opt/officechat`;
- создаёт `/etc/officechat/backup.conf` с mode `0600`, только если файла ещё нет;
- никогда не перезаписывает существующий `backup.conf` при update;
- устанавливает `officechat-backup.service` и `.timer`;
- включает ежедневный timer только при явном флаге installer
  `--enable-backup-timer`; сначала проверьте конфигурацию вручную;
- сохраняет обратную совместимость конфигурации: неизвестные ключи отвергаются,
  новые ключи получают безопасные defaults.

Ручная установка:

```bash
sudo install -d -m 0755 /etc/officechat
sudo install -m 0600 deploy/backup/officechat-backup.conf.example /etc/officechat/backup.conf
sudo install -m 0755 scripts/backup-production.sh scripts/verify-backup.sh scripts/restore-production.sh /opt/officechat/
sudo install -d -m 0755 /opt/officechat/backup
sudo install -m 0644 scripts/backup/lib.sh /opt/officechat/backup/lib.sh
sudo install -m 0644 deploy/systemd/officechat-backup.* /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now officechat-backup.timer
```

Проверьте Compose paths в `backup.conf`. Для установки с HTTPS override:

```ini
COMPOSE_FILES=/opt/officechat/docker-compose.yml:/opt/officechat/docker-compose.https-override.yml
```

## Конфигурация

Основные параметры:

```ini
OFFICECHAT_DIR=/opt/officechat
OFFICECHAT_DATA_DIR=/var/lib/officechat
BACKUP_ROOT=/var/backups/officechat/production
OFFSITE_ROOT=
REQUIRE_OFFSITE=no
KEEP_DAILY=14
KEEP_WEEKLY=8
KEEP_MONTHLY=12
BACKUP_VALKEY=auto
VALKEY_DATA_PATH=/data/dump.rdb
BACKUP_CADDY_CA=yes
BACKUP_DEPLOYMENT_CONFIG=yes
BACKUP_PRIVATE_CONFIG=yes
REQUIRE_ENCRYPTED_PRIVATE=no
ALLOW_PLAINTEXT_PRIVATE_OFFSITE=no
AGE_RECIPIENT=
VERIFY_AFTER_BACKUP=yes
BACKUP_EXTRA_PATHS=
```

`BACKUP_EXTRA_PATHS` — colon-separated список абсолютных путей. Не включайте
`BACKUP_ROOT`, иначе скрипт остановится.

Lifecycle hooks выключены:

```ini
PRE_BACKUP_HOOK=
POST_BACKUP_HOOK=
POST_RESTORE_HOOK=
```

Hook должен быть абсолютным путём к executable wrapper. Аргументы и shell fragments
не принимаются; `eval` не используется. Файл должен принадлежать root, не быть
symlink или group/world-writable. Hook запускается с минимальным environment и
таймаутом `HOOK_TIMEOUT_SECONDS`. После выполненного pre-hook post-hook вызывается
также при аварийном завершении backup.

## Создание backup

```bash
sudo /opt/officechat/backup-production.sh --config /etc/officechat/backup.conf
sudo /opt/officechat/backup-production.sh --config /etc/officechat/backup.conf --dry-run
sudo /opt/officechat/officechatctl backup
```

Перед upgrade:

```bash
sudo /opt/officechat/backup-production.sh \
  --config /etc/officechat/backup.conf \
  --pre-upgrade
```

`--pre-upgrade` включает текущие images из `IMAGE_SERVICES` и создаёт `PROTECTED`,
поэтому GFS rotation не удаляет backup автоматически. Обычный `--include-images`
сохраняет те же dynamically discovered images без защиты от rotation.

Backup создаётся как `.partial`, проверяется и только затем атомарно переименовывается:

```text
officechat-backup-YYYYMMDD-HHMMSSZ/
  database/officechat.dump
  uploads/uploads.tar.gz
  config/deployment-public.tar.gz
  config/deployment-private.tar.gz
  valkey/valkey.rdb
  caddy/caddy-ca.tar.gz
  extra/*.tar.gz
  images/*.tar
  metadata/manifest.json
  metadata/SHA256SUMS
  metadata/versions.txt
  metadata/image-digests.txt
  metadata/compose-config.txt
  metadata/database-info.txt
  SUCCESS
```

Private config и Caddy CA содержат секреты и имеют mode `0600`. Их нельзя
публиковать или прикладывать к публичным issue. Plaintext private config,
Caddy CA и `BACKUP_EXTRA_PATHS` по умолчанию никогда не копируются off-site.
Чтобы перенести их, задайте публичный `AGE_RECIPIENT`: рядом будет создан
зашифрованный файл `.age`, а ключ расшифрования должен храниться отдельно.
`REQUIRE_ENCRYPTED_PRIVATE=yes` делает отсутствие recipient или утилиты `age`
ошибкой. Опция `ALLOW_PLAINTEXT_PRIVATE_OFFSITE=yes` является явным небезопасным
исключением и отражается warning в manifest.

Manifest v1 содержит format/script version, OfficeChat version, build SHA,
Alembic/PostgreSQL revision, Compose project, discovered/required/optional
components, images, timestamp, размеры, warnings и способ получения off-site
status. Фактический результат копирования хранится в
`metadata/offsite-receipt.json` и status-файле. Эти metadata не содержат пароли,
токены, `.env` или webhook URLs.

## Проверка

```bash
sudo /opt/officechat/verify-backup.sh \
  --config /etc/officechat/backup.conf \
  /path/officechat-backup-YYYYMMDD-HHMMSSZ
```

Проверяются schema/version manifest, `SUCCESS`, SHA256, `pg_restore --list`,
tar structure и path traversal. Не выводится содержимое private archive.

Полный restore drill:

```bash
sudo /opt/officechat/restore-production.sh \
  --config /etc/officechat/backup.conf \
  --verify-only \
  /path/officechat-backup-YYYYMMDD-HHMMSSZ
```

Drill создаёт случайные temporary network/container/volume с ownership labels, не публикует ports,
не подключает production volumes и удаляет всё через trap. Проверяются полный dump,
число public tables/relations, Alembic revision, PostgreSQL major compatibility,
owners/extensions и безопасная распаковка uploads. Архивы с traversal, links,
special files, setuid/setgid, duplicate names или превышением настроенных лимитов
отклоняются до extraction.
Содержимое сообщений и персональные данные не печатаются.

## GFS rotation

По умолчанию сохраняются 14 daily, 8 weekly и 12 monthly точек. Rotation:

- рассматривает только каталоги ожидаемого имени с `SUCCESS`;
- не следует symlink;
- не удаляет последний успешный backup;
- не удаляет `PROTECTED`;
- не затрагивает посторонние каталоги и активные `.partial`;
- журналирует каждый удаляемый каталог.

## Off-site / OMV2

Локальный backup на одном filesystem с production не защищает от потери сервера.
Смонтируйте OMV2 и настройте:

```ini
OFFSITE_ROOT=/mnt/omv2/officechat
REQUIRE_OFFSITE=yes
```

Любой настроенный `OFFSITE_ROOT` должен уже существовать и быть реальным mountpoint
на другом filesystem; скрипт не создаёт его. Проверяется свободное место. При
`REQUIRE_OFFSITE=yes` отсутствие mount блокирует общий результат, а при `no`
off-site копирование пропускается без записи на системный диск. Копирование идёт сначала
в `.partial`, затем checksums проверяются и каталог атомарно переименовывается.
Ошибка off-site не удаляет локальный backup. До подключения OMV2 PostgreSQL,
uploads, private config и CA всё ещё не защищены от потери локального диска.
PostgreSQL dump и uploads содержат корпоративные данные и остаются обычными
файлами внутри off-site backup. Размещайте `OFFSITE_ROOT` только на хранилище с
контролем доступа и шифрованием at rest/зашифрованным транспортом. Встроенный
`age`-режим защищает private config, Caddy CA и extra archives, но не заменяет
шифрование всего backup volume.

## Production restore

Production restore по умолчанию запрещён. Требуются одновременно:

```bash
sudo /opt/officechat/restore-production.sh \
  --config /etc/officechat/backup.conf \
  --production \
  --confirm-hostname "$(hostname)" \
  --confirm-backup officechat-backup-YYYYMMDD-HHMMSSZ \
  --yes \
  /path/officechat-backup-YYYYMMDD-HHMMSSZ
```

Для автоматизации без TTY требуется дополнительный явный `--non-interactive`;
он не заменяет `--production`, hostname/backup confirmations и `--yes`.

Скрипт сначала создаёт и проверяет защищённый pre-restore backup. PostgreSQL dump
восстанавливается в новую временную database без изменения рабочей базы, после
чего проверяются tables, Alembic revision и owners. Только затем application
services останавливаются, а базы переключаются через controlled rename. Исходная
database сохраняется под rollback-именем. Uploads распаковываются в отдельный
staging directory, проверяются и меняются местами; старый каталог также сохраняется.
После migrations сервисы считаются восстановленными только после backend `/ready`
и frontend `/api/health`. При ошибке после переключения приложение остаётся
остановленным, а rollback database/uploads и pre-restore backup не удаляются.

При несовпадении OfficeChat version выводится warning. Неизвестный
`backup_format_version` блокирует restore. Custom dump старой поддерживаемой версии
PostgreSQL разрешается восстанавливать в совместимую новую версию.

После disaster recovery на новой VM:

1. установить Docker Engine/Compose;
2. восстановить Compose и private config;
3. получить images или выполнить `docker load` из pre-upgrade backup;
4. выполнить restore;
5. восстановить Caddy CA вручную до запуска Caddy;
6. выполнить `restorecon -RFv /var/lib/officechat` при SELinux;
7. проверить `/ready`, `/api/health`, login и скачивание вложения;
8. сменить secrets, если backup мог быть скомпрометирован.

## Caddy CA

`caddy/caddy-ca.tar.gz` содержит private CA key. Восстанавливайте его только в
настроенный Caddy data volume, при остановленном Caddy, согласно
`docs/deployment/caddy-ca-backup-restore.md`. Никогда не используйте
`docker compose down -v` для Caddy.

## systemd и мониторинг

Timer запускается ежедневно около 02:30 с random delay до 15 минут:

```bash
systemctl list-timers officechat-backup.timer
journalctl -u officechat-backup.service
systemctl start officechat-backup.service
```

Статус для будущего Zabbix:

```text
/var/backups/officechat/status/latest.json
```

Проверяйте `current_result`, `last_run`, отдельный `last_success`, duration,
verification/off-site status, возраст backup и свободное место. Ошибка нового
запуска не стирает timestamp последнего успешного backup. Zabbix integration в
этот toolkit не входит.

Проводите isolated restore drill регулярно, например ежемесячно и перед крупными
обновлениями. Backup без успешного restore drill нельзя считать проверенным.

## Очистка и troubleshooting

GFS rotation выполняется после успешного backup. Она не удаляет `.partial`,
`PROTECTED`, symlink и посторонние каталоги. Собственный `.partial` аварийно
завершившегося процесса удаляется trap-ом; неизвестный старый `.partial` сначала
проверьте по journald и наличию активного процесса, затем удалите вручную.

При ошибке:

1. проверьте `systemctl status officechat-backup.service` и
   `journalctl -u officechat-backup.service`;
2. прочитайте `status/latest.json`, не публикуя private archives;
3. проверьте настроенные Compose files командой `docker compose ... config`;
4. убедитесь, что `postgres` и `backend` обнаруживаются через `compose ps -q`;
5. при off-site ошибке проверьте mountpoint и свободное место OMV2;
6. повторно запустите `verify-backup.sh` для последней копии с `SUCCESS`.

Не удаляйте локальный backup только потому, что off-site копирование завершилось
ошибкой. Сначала устраните причину и повторите backup.
