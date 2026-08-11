# Резервное копирование, проверка и восстановление OfficeChat

Это каноническое руководство оператора по резервному копированию и восстановлению данных приложения. Работа интерфейса и граница доверия между браузером и хостом описаны в документе [«Центр резервного копирования»](BACKUP_CENTER_RU.md).

## Область действия и пути по умолчанию

Установщик релиза использует следующие пути production-установки, если `/etc/officechat/backup.conf` не задаёт другие:

| Назначение | Путь |
| --- | --- |
| Приложение и скрипты релиза OfficeChat | `/opt/officechat` |
| Состояние приложения | `/var/lib/officechat` |
| Конфигурация резервного копирования | `/etc/officechat/backup.conf` |
| Локальное хранилище резервных копий | `/var/backups/officechat/production` |
| Состояние последнего запуска | `/var/backups/officechat/status/latest.json` |
| Состояние агента резервного копирования | `/var/lib/officechat-backup-agent` |
| Общая блокировка операций | `/run/lock/officechat/backup.lock` |

Backend и браузер не получают путь локального хранилища, каталог состояния агента, дамп базы данных, архив uploads или приватную конфигурацию. Установщик создаёт `backup.conf` с правами `0600` только при отсутствии файла; при обновлении существующая конфигурация сохраняется.

## Состав резервной копии

Обязательные компоненты:

- полный дамп PostgreSQL в custom format, включая будущие таблицы приложения;
- архив uploads, включая вложения и аватары;
- манифест и контрольные суммы SHA-256.

Настраиваемые дополнительные компоненты:

- публичная и приватная deployment-конфигурация при `BACKUP_DEPLOYMENT_CONFIG=yes`;
- best-effort RDB Valkey при `BACKUP_VALKEY=auto` или обязательный RDB при значении `yes`;
- внутренний Caddy CA при `BACKUP_CADDY_CA=yes` и доступном Caddy Compose project;
- абсолютные пути из colon-separated `BACKUP_EXTRA_PATHS`;
- используемые frontend/backend images с `--include-images` или `--pre-upgrade`.

Обычная команда не добавляет image tar files без `--include-images`. Флаг `--pre-upgrade` подразумевает `--include-images` и создаёт marker `PROTECTED`, поэтому автоматическая ротация не удаляет такую копию. PostgreSQL является authoritative source; runtime-состояние Valkey автоматически не восстанавливается.

Приватная deployment-конфигурация и Caddy CA содержат секреты. Plaintext-файлы `config/deployment-private.tar.gz`, `caddy/caddy-ca.tar.gz` и plaintext-архивы extra paths сохраняются локально, но по умолчанию исключаются из внешней копии. Публичный `AGE_RECIPIENT` создаёт зашифрованные варианты `.age`. Приватный age identity храните вне OfficeChat и вне backup repository.

## Жизненный цикл каталога и маркеры

ID формируется в UTC:

```text
officechat-backup-YYYYMMDD-HHMMSSZ
```

Последовательность создания:

```text
officechat-backup-....partial
  -> database, uploads и настроенные дополнительные компоненты
  -> manifest и SHA256SUMS
  -> проверка checksums
  -> verify-backup.sh при VERIFY_AFTER_BACKUP=yes
  -> SUCCESS
  -> PROTECTED только для --pre-upgrade
  -> атомарное переименование в officechat-backup-....
```

`SUCCESS` означает, что каталог полностью опубликован после настроенных проверок. Это ещё не доказательство успешного изолированного восстановления. При `VERIFY_AFTER_BACKUP=yes` (значение по умолчанию) manifest получает `verification_status=passed` после проверки manifest, checksums, списка PostgreSQL dump и структуры архивов. Если автоматическая проверка отключена, завершённая копия может иметь `verification_status=not_requested`.

`PROTECTED` создаётся только флагом `--pre-upgrade`, после проверки и непосредственно перед атомарным переименованием. Он защищает от GFS rotation, но не заменяет внешнее хранилище.

PostgreSQL и uploads снимаются последовательно, а не в одной общей транзакции. Manifest фиксирует режим `best_effort_live`. Если нужна строгая согласованность вложений, используйте проверенные root-owned lifecycle hooks, временно останавливающие запись.

## Ручное создание резервной копии

Обычная копия:

```bash
sudo /opt/officechat/backup-production.sh \
  --config /etc/officechat/backup.conf
```

Защищённая копия перед обновлением с текущими images:

```bash
sudo /opt/officechat/backup-production.sh \
  --config /etc/officechat/backup.conf \
  --pre-upgrade
```

Успешный вывод завершается строкой `Backup completed: <path>`. Безопасные проверки результата:

```bash
sudo cat /var/backups/officechat/status/latest.json
BACKUP_ID=officechat-backup-YYYYMMDD-HHMMSSZ
BACKUP_PATH="/var/backups/officechat/production/${BACKUP_ID}"
sudo test -f "${BACKUP_PATH}/SUCCESS" && echo 'SUCCESS present'
sudo test -f "${BACKUP_PATH}/PROTECTED" && echo 'PROTECTED present'
sudo lslocks --output COMMAND,PID,TYPE,PATH | grep -F '/run/lock/officechat/backup.lock'
```

Не редактируйте каталог копии, не создавайте маркеры вручную и не удаляйте файл блокировки. Сам файл может оставаться без активной блокировки; её владельца показывает `lslocks`.

## Автоматические копии по расписанию

Установщик добавляет `officechat-backup.timer` и `officechat-backup.service`. Таймер по умолчанию отключён, если установка не запускалась с `--enable-backup-timer`. Установленное расписание — ежедневно от 02:30 с `RandomizedDelaySec=15m`, `AccuracySec=1m` и `Persistent=true`; точное время следующего запуска берите из systemd, поскольку оно учитывает случайную задержку.

```bash
sudo systemctl status officechat-backup.timer
sudo systemctl list-timers --all officechat-backup.timer
sudo systemctl cat officechat-backup.timer
sudo journalctl -u officechat-backup.service --since today --no-pager
```

Явное включение и отключение автоматических копий:

```bash
sudo systemctl enable --now officechat-backup.timer
sudo systemctl disable --now officechat-backup.timer
```

Отключение таймера не отключает `officechat-backup-agent.service`: агент нужен для метаданных Backup Center и ручных браузерных операций. Операции по расписанию, из CLI и из браузера, а также проверка и восстановление используют общую блокировку; одновременно может выполняться только одна операция.

## Способы проверки

### Автоматическая структурная проверка

При `VERIFY_AFTER_BACKUP=yes` создание запускает `verify-backup.sh` до публикации `SUCCESS`. Проверяются формат manifest и обязательные компоненты, полный набор checksums, `pg_restore --list`, структура архивов, traversal/links/special files и настроенные ограничения архивов.

### Ручная структурная проверка

```bash
sudo /opt/officechat/verify-backup.sh \
  --config /etc/officechat/backup.conf \
  /var/backups/officechat/production/officechat-backup-YYYYMMDD-HHMMSSZ
```

### Изолированная проверка восстановления

Для локального backup ID:

```bash
sudo /opt/officechat/restore-production.sh \
  --config /etc/officechat/backup.conf \
  --verify-only \
  --backup-id officechat-backup-YYYYMMDD-HHMMSSZ
```

Для копии на внешнем хранилище передайте полный путь вместо `--backup-id`:

```bash
sudo /opt/officechat/restore-production.sh \
  --config /etc/officechat/backup.conf \
  --verify-only \
  /mnt/officechat-offsite/officechat-backup-YYYYMMDD-HHMMSSZ
```

Verify-only получает общий lock, повторяет структурную проверку, создаёт уникальные помеченные temporary Docker network/volume/container без production ports и mounts, восстанавливает полный dump во временный PostgreSQL, проверяет tables, relations, owners, extensions, Alembic revision и совместимость PostgreSQL major, а uploads распаковывает во временный каталог. Trap удаляет только ресурсы со своим restore-drill label.

Кнопка **Проверить копию** в Backup Center запускает тот же процесс `--verify-only --backup-id`. Каталог нельзя считать восстанавливаемым только потому, что он существует или содержит `SUCCESS`; регулярно выполняйте изолированный restore drill.

## Внешнее хранилище

### Что поддерживается сейчас

OfficeChat поддерживает один каталог назначения на файловой системе, заранее смонтированной операционной системой хоста. Встроенных клиентов NFS/SMB, объектного хранилища, S3, URL, удалённой оболочки или облачного API нет; учётные данные хранилища OfficeChat не принимает.

Точные параметры:

```ini
OFFSITE_ROOT=/mnt/officechat-offsite
REQUIRE_OFFSITE=yes
ALLOW_PLAINTEXT_PRIVATE_OFFSITE=no
REQUIRE_ENCRYPTED_PRIVATE=no
AGE_RECIPIENT=
```

Этот безопасный базовый пример копирует PostgreSQL, uploads, публичную конфигурацию, metadata и неприватные дополнительные компоненты. Plaintext private config, Caddy CA и extra-path archives исключаются. Чтобы передавать их зашифрованные варианты, установите `age`, задайте действительный публичный `AGE_RECIPIENT` и обычно включите `REQUIRE_ENCRYPTED_PRIVATE=yes`.

`OFFSITE_ROOT` должен заранее существовать как активная точка монтирования, не быть символической ссылкой, не пересекаться с данными приложения или локальных копий и находиться на другом устройстве файловой системы, чем `BACKUP_ROOT`. Исполнитель от имени root должен иметь возможность проверять свободное место, создавать, менять права, переименовывать и ротировать каталоги. Скрипт не создаёт отсутствующую точку монтирования и повторно проверяет её и устройство до и после передачи.

NFS, SMB/CIFS и отдельная локальная точка монтирования поверх внешнего хранилища являются допустимыми вариантами на уровне хоста. Аутентификация, шифрование транспорта, порядок подключения при загрузке и восстановление монтирования настраиваются в ОС. Используйте стабильную точку монтирования и проверьте доступ root: NFS root-squash или ограничивающее сопоставление пользователей SMB могут помешать нужным операциям. OfficeChat не хранит учётные данные сетевого хранилища.

### Копирование и ошибки

Локальная копия проверяется, получает `SUCCESS` и атомарно публикуется до внешней передачи. Затем OfficeChat:

1. проверяет mountpoint, отдельный device и свободное место;
2. создаёт `<backup-id>.partial` во внешнем хранилище;
3. использует `rsync -aHAX --numeric-ids`, если он доступен, иначе tar stream;
4. пересчитывает file-size metadata внешнего payload;
5. заново создаёт и проверяет checksums;
6. запускает `verify-backup.sh --allow-partial` для внешней копии;
7. атомарно переименовывает каталог в `<backup-id>`;
8. записывает локальные `metadata/offsite-receipt.json` и status в `latest.json`.

Возможные состояния: `not_configured`, `copied`, `skipped_not_mounted`, `failed`, `unknown`.

- При `REQUIRE_OFFSITE=no` отсутствующий/unmounted destination оставляет локальную копию валидной, а запуск завершается успешно со статусом `skipped_not_mounted`.
- При `REQUIRE_OFFSITE=yes` отсутствие конфигурации или mount делает общий запуск failed, но уже опубликованная локальная копия сохраняется.
- Если смонтированное хранилище не проходит проверку отдельного device, места, copy или verification, общий запуск завершается ошибкой независимо от `REQUIRE_OFFSITE`; локальная завершённая копия остаётся целой.

Копирование не имеет повторных попыток и отдельного сетевого тайм-аута. Операции через systemd и браузер ограничены шестью часами на уровне unit и агента; прямой запуск из CLI зависит от тайм-аутов файловой системы и ОС. Контролируйте сетевые точки монтирования, чтобы зависшее хранилище не оставляло фоновый процесс CLI без ограничения времени.

После успешного внешнего копирования одинаковая GFS-политика запускается независимо для локального и внешнего repositories. Rotation рассматривает только каталоги ожидаемого имени с `SUCCESS`, сохраняет newest successful и все `PROTECTED`, игнорирует partial, symlink и посторонние пути. Если текущая внешняя копия skipped или failed, внешняя rotation не запускается.

### Проверка настройки

```bash
mountpoint /mnt/officechat-offsite
findmnt /mnt/officechat-offsite
df -h /mnt/officechat-offsite
sudo /opt/officechat/backup-production.sh --config /etc/officechat/backup.conf
sudo cat /var/backups/officechat/status/latest.json
sudo find /mnt/officechat-offsite -mindepth 1 -maxdepth 1 -type d \
  -name 'officechat-backup-????????-??????Z' -print | sort -r
```

После этого выполните `verify-backup.sh` и `restore-production.sh --verify-only` для внешнего пути в staging acceptance window. Доступность mount сама по себе не доказывает наличие рабочей внешней копии.

## Выбор копии для восстановления

Список завершённых локальных копий без partial-каталогов:

```bash
sudo find /var/backups/officechat/production -mindepth 1 -maxdepth 1 -type d \
  -name 'officechat-backup-????????-??????Z' \
  -exec test -f '{}/SUCCESS' ';' -print | sort -r
```

До production restore изучите `metadata/manifest.json`, проверьте `officechat_version`, `build_sha`, `alembic_revision`, `postgresql_version`, detected components и warnings, затем выполните изолированный restore drill.

## Production-восстановление

Restore доступен только через CLI. Для копии в локальном repository:

```bash
BACKUP_ID=officechat-backup-YYYYMMDD-HHMMSSZ
sudo /opt/officechat/restore-production.sh \
  --config /etc/officechat/backup.conf \
  --production \
  --confirm-hostname "$(hostname)" \
  --confirm-backup "${BACKUP_ID}" \
  --yes \
  --backup-id "${BACKUP_ID}"
```

Production mode требует root и локальный TTY. Для non-interactive automation дополнительно нужен `--non-interactive`; он не заменяет `--production`, подтверждение hostname, backup ID и `--yes`. Для внешнего пути передайте его последним positional argument вместо `--backup-id`.

Скрипт:

1. проверяет выбранную копию до любых изменений;
2. предупреждает, если OfficeChat version копии отличается от установленной;
3. создаёт новую проверенную `--pre-upgrade` копию текущего production для rollback;
4. получает общий lock;
5. восстанавливает dump в новую staging database и проверяет tables, revision и ownership;
6. безопасно распаковывает uploads в staging directory;
7. останавливает backend, frontend и настроенные workers только после успешных staging checks;
8. атомарно переименовывает production/staged databases и сохраняет прежнюю database;
9. переключает uploads, сохраняя прежний каталог;
10. выполняет `alembic current`, `alembic upgrade head`, `alembic current` установленным backend image;
11. запускает application services и требует backend `/ready` и frontend `/api/health`;
12. запускает настроенный `POST_RESTORE_HOOK`.

При ошибке после остановки приложения services остаются остановленными для диагностики, а защищённая safety backup, rollback database и rollback uploads сохраняются. Не удаляйте их до operator acceptance.

Скрипт восстанавливает PostgreSQL и uploads. Он не восстанавливает автоматически `.env`, `backup.conf`, Caddy CA, Valkey RDB, дополнительные пути или сохранённые образы. Сначала подготовьте совместимую версию приложения и конфигурацию, а дополнительные компоненты восстанавливайте отдельными контролируемыми процедурами. Для внутреннего центра сертификации используйте отдельное руководство [«Резервное копирование и восстановление Caddy CA»](deployment/caddy-ca-backup-restore.md).

### Версии и миграции

- Неизвестный `backup_format_version` отклоняется.
- Target PostgreSQL major должен быть равен или новее major исходной БД из manifest.
- Alembic revision staging database должен совпасть с manifest копии.
- Отличающаяся OfficeChat version вызывает warning, но не автоматическую смену приложения.
- После переключения установленный release может обновить восстановленную schema до своего head.
- Database downgrade никогда не выполняется.

До restore установите тот же release, что записан в backup, или проверенный совместимый более новый. Если schema копии новее migration chain установленного приложения, migration/readiness ожидаемо завершится безопасной ошибкой с остановленным приложением; выберите совместимый release, а не пытайтесь выполнить downgrade.

Для защищённой pre-upgrade копии используются те же verify и production commands. Исходный release определяют `metadata/manifest.json`, `metadata/image-digests.txt`, `officechat_version` и `build_sha`. `images/backend.tar` и `images/frontend.tar` существуют только при включённых images. Загрузка сохранённых images и восстановление private config являются отдельными действиями оператора вне `restore-production.sh`.

## Полное восстановление после аварии

Если сервер или VM OfficeChat потеряны, но есть валидная внешняя application backup, действуйте в таком порядке:

1. Подготовьте поддерживаемый Linux amd64 host с Docker Engine, Compose v2, systemd, достаточным локальным storage и SELinux Enforcing, где применимо.
2. Установите OfficeChat release из manifest или проверенный совместимый более новый. Не открывайте client traffic.
3. Через installer и контролируемое восстановление секретов подготовьте `/opt/officechat`, `/var/lib/officechat`, private `.env`, `/etc/officechat/backup.conf` и права storage.
4. Подключите внешнюю копию как локально доступный mounted path; не изменяйте её содержимое.
5. Выполните структурную проверку и изолированный restore drill внешнего path.
6. Запустите подтверждённый production restore для этого path.
7. Проверьте Alembic current/head, backend `/ready` и frontend `/api/health`.
8. Проверьте вход администратора и обычного пользователя, group/direct messaging и WebSocket delivery.
9. Скачайте репрезентативное вложение/avatar и сравните ожидаемое содержимое.
10. Отдельно восстановите и проверьте optional components, включая Caddy CA для сохранения доверия LAN-клиентов.
11. Проверьте Backup Center, agent socket, timer, journals, локальное свободное место и off-site status.
12. Включите timer только после acceptance и создайте одну новую копию обычным путём.

Application backup OfficeChat защищает данные приложения и выбранную конфигурацию. Full VM/hypervisor backup защищает более широкий host, boot/system configuration и другие services. По возможности используйте оба механизма; ни один из них не отменяет проверку восстановления из независимой внешней копии.

## Модель безопасности

- `officechat-backup-agent.service`: `NoNewPrivileges=true`, пустые `CapabilityBoundingSet` и `AmbientCapabilities`.
- Только `officechat-backup-job.service` и `officechat-backup-verify@.service` используют `NoNewPrivileges=false` для фиксированных root-owned Docker workflows.
- Backend непривилегирован и не получает Docker socket, backup repository mount или agent state mount.
- Backend получает только read-only bind runtime-каталога Unix socket и supplementary group ID.
- Frontend и calendar-worker не получают agent socket.
- Restore не доступен через browser/API.

При диагностике не отключайте SELinux, не выдавайте backend доступ к Docker/host filesystem, не делайте agent socket world-writable, не редактируйте job state и не заменяйте фиксированные команды исполнителей.

## Матрица диагностики

| Симптом | Значение и безопасная диагностика | Что нельзя делать |
| --- | --- | --- |
| Операция выполняется необычно долго | Проверьте `systemctl status officechat-backup-job.service`, активные units проверки, `journalctl`, `pgrep -af 'backup-production|restore-production|verify-backup'` и `lslocks`. | Не перезапускайте агент и не завершайте процессы, пока не определён исполнитель под управлением PID 1. |
| `BACKUP_BUSY` | Активна scheduled/manual/verify/restore-операция или lock. Проверьте оба executor units, timer service и `lslocks`. | Не удаляйте `backup.lock` и не запускайте параллельный скрипт. |
| `EXECUTOR_UNAVAILABLE` | Агент не может проверить, опросить или запустить фиксированный unit. Проверьте `systemctl status`, `systemctl cat`, состояние `daemon-reload` и журнал агента. | Не расширяйте разрешённый argv и не делайте backend privileged. |
| `JOB_INTERRUPTED` | Агент остановился во время наблюдения; executor может продолжать работу под PID 1. Проверьте active units и journals. | Не редактируйте `jobs.json` и не повторяйте запуск, пока executor и lock не освободились. |
| Verification failed | Ошибка manifest, checksums, dump restore, PostgreSQL compatibility или uploads. Повторите точную verify-команду и изучите journal. | Не добавляйте `SUCCESS`, не редактируйте checksums и не восстанавливайте эту копию. |
| Внешнее хранилище не настроено | `OFFSITE_ROOT` пуст; локальные копии не защищают от потери сервера. | Не считайте локальный `SUCCESS` внешней защитой. |
| Внешнее хранилище недоступно | Проверьте `mountpoint`, `findmnt`, `df`, permissions, device identity и `latest.json`. | Не создавайте данные в несмонтированном destination path и не разрешайте plaintext private transfer без оценки риска. |
| Мало места | Проверьте `df -h`, retention, protected copies и последние успешные копии. | Не удаляйте произвольные каталоги или защищённые rollback copies. |
| Timer не запускался | Проверьте `systemctl list-timers --all`, status timer/service и journal. Из-за `Persistent=true` пропущенный запуск возможен после boot. | Не отключайте агент: timer и агент независимы. |
| Агент или socket недоступен | Проверьте status/journal агента и `stat` socket (`root:officechat-backup`, mode `0660`). | Не используйте mode `0777` и не монтируйте Docker socket в backend. |
| SELinux denial | Сохраняйте Enforcing; используйте `ausearch -m AVC,USER_AVC -ts recent` и `ls -Z` для runtime/data paths. | Не включайте permissive, не отключайте labels и не создавайте allow-all policy. |

## Краткая памятка оператора

```bash
# Обычная и защищённая копии
sudo /opt/officechat/backup-production.sh --config /etc/officechat/backup.conf
sudo /opt/officechat/backup-production.sh --config /etc/officechat/backup.conf --pre-upgrade

# Последний status, timer, агент и журналы
sudo cat /var/backups/officechat/status/latest.json
sudo systemctl list-timers --all officechat-backup.timer
sudo systemctl status officechat-backup-agent.service
sudo journalctl -u officechat-backup.service --since today --no-pager

# Структурная проверка
sudo /opt/officechat/verify-backup.sh --config /etc/officechat/backup.conf \
  /var/backups/officechat/production/officechat-backup-YYYYMMDD-HHMMSSZ

# Изолированная проверка восстановления
sudo /opt/officechat/restore-production.sh --config /etc/officechat/backup.conf \
  --verify-only --backup-id officechat-backup-YYYYMMDD-HHMMSSZ

# Lock и активные исполнители
sudo lslocks --output COMMAND,PID,TYPE,PATH | grep -F '/run/lock/officechat/backup.lock'
sudo systemctl status officechat-backup-job.service
sudo systemctl list-units --all 'officechat-backup-verify@*.service'
```

Полная команда production-восстановления, изменяющая данные, приведена только в разделе [«Production-восстановление»](#production-восстановление), вместе со всеми обязательными подтверждениями.
