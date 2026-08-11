# Центр резервного копирования OfficeChat

Центр резервного копирования — интерфейс для `superadmin`, предназначенный для просмотра состояния production-копий, ручного создания копии и изолированной проверки восстановления. Страница доступна по `/ru/admin/backups`. Она не удаляет, не скачивает и не восстанавливает копии, не меняет хранение, расписание или внешнее хранилище. Production-восстановление остаётся операцией уполномоченного администратора через CLI.

Схема хранения, автоматические копии, внешнее хранилище, восстановление и аварийный план описаны в документе [«Резервное копирование и восстановление»](BACKUP_RESTORE_RU.md).

## Что показывает страница

- доступность и состояние агента резервного копирования;
- последний запуск и последнюю успешную копию;
- состояние проверки и размер последней успешной копии;
- свободное место локального хранилища без раскрытия его пути;
- следующий запуск по расписанию и значения daily/weekly/monthly retention только для чтения;
- наличие внешнего хранилища и результат последнего копирования без раскрытия пути назначения;
- завершённые локальные копии: тип, версия, build, Alembic/PostgreSQL, компоненты, защита и предупреждения;
- текущую или последнюю наблюдаемую операцию, запущенную через браузер.

В список попадают только завершённые каталоги со строгим ID, например `officechat-backup-20260811-111632Z`. При отсутствующих или повреждённых метаданных интерфейс показывает безопасное предупреждение, но не пути, приватную конфигурацию или traceback.

## Кнопки и состояния операций

- **Создать резервную копию** после подтверждения запускает фиксированную команду полной локальной копии. OfficeChat продолжает работать; копия имеет режим согласованности `best_effort_live`.
- **Обновить** заново загружает состояние агента, хранилища, таймера, истории и операций.
- **Проверить копию** доступна в сведениях о завершённой копии. Она запускает существующую изолированную проверку `--verify-only` и не изменяет production-данные.

HTTP-запрос только создаёт асинхронную операцию на сервере, после чего страница опрашивает её состояние:

- `queued` — операция принята и ожидает worker;
- `running` — создаётся резервная копия;
- `verifying` — выполняется изолированная проверка;
- `succeeded` с фазой `completed` — операция успешно завершена;
- `failed` с фазой `error` — исполнитель или скрипт сообщил об ошибке;
- `interrupted` — агент остановился или перезапустился во время наблюдения за операцией.

Закрытие страницы не отменяет операцию. Очередь и отмена в этой версии не поддерживаются.

## Архитектура и граница доверия

```text
Браузер
  -> непривилегированный backend
  -> read-only bind каталога Unix socket
  -> защищённый root-агент резервного копирования
  -> фиксированная разрешённая команда systemctl
  -> фиксированный исполнитель systemd
  -> фиксированный backup- или verify-only-скрипт
```

У backend нет Docker socket, mount локального хранилища копий или каталога состояния агента. Frontend и calendar-worker не получают socket агента. Браузер не может передать executable, путь, argv, environment, systemd property или unit name.

Socket-facing unit `officechat-backup-agent.service` сохраняет:

```ini
NoNewPrivileges=true
CapabilityBoundingSet=
AmbientCapabilities=
```

Только `officechat-backup-job.service` и `officechat-backup-verify@.service` используют `NoNewPrivileges=false`. Их root-owned `ExecStart` зафиксированы release bundle. Так явный Docker/SELinux privilege tradeoff изолирован в двух узких исполнителях, а не в веб-приложении или socket-facing агенте.

Создание может запустить только:

```text
/opt/officechat/backup-production.sh --config /etc/officechat/backup.conf
```

Проверка может запустить только:

```text
/opt/officechat/restore-production.sh --config /etc/officechat/backup.conf --verify-only --backup-id <проверенный-backup-id>
```

Переключить этот протокол в режим restore невозможно.

## Конфликты и прерывание

Агент принимает только одну браузерную операцию создания или проверки. Ручные, автоматические, verify-only и restore-операции дополнительно используют общий lock `/run/lock/officechat/backup.lock`. Активная автоматическая копия или исполнитель приводит к безопасной ошибке `BACKUP_BUSY` для конкурирующего запуска.

Если агент перезапускается во время операции, OfficeChat записывает наблюдаемую job как `interrupted`. Локальный клиент `systemctl` завершается, но исполнитель `Type=oneshot` остаётся под управлением PID 1 и может продолжить работу. После рестарта агент проверяет активные исполнители и не разрешает конкурирующую операцию. Позднее завершение исполнителя не переписывает уже сохранённую interrupted job задним числом.

Не удаляйте lock-файл, не редактируйте `/var/lib/officechat-backup-agent/jobs.json` и не запускайте операцию повторно, пока не проверены исполнитель и журналы.

## Подтверждение rc13.3 на production

Release `0.1.0-rc13.3-backup-jobs-completion-fix` принят на RED OS/systemd 253 11 августа 2026 года. Браузерная копия `officechat-backup-20260811-111632Z` завершилась за 7 секунд, получила verification `passed` и итоговую job `state=succeeded`, `phase=completed`, `success=true`, `exit_code=0`.

После завершения systemd уже выгрузил identity неактивного static unit:

```text
InvocationID=
ExecMainStartTimestampMonotonic=0
```

Это ожидаемое поведение. В rc13.3 авторитетным результатом успешного `Type=oneshot` является завершение блокирующего `systemctl start UNIT`; success больше не зависит от опроса invocation identity после выполнения. При ненулевом результате stale metadata не может превратиться в success или `BACKUP_BUSY`: exit 75 считается busy только при доказанном новом failed invocation.

## Безопасная диагностика

```bash
sudo systemctl status officechat-backup-agent.service
sudo systemctl status officechat-backup-job.service
sudo systemctl list-units --all 'officechat-backup-verify@*.service'
sudo journalctl -u officechat-backup-agent.service --since today --no-pager
sudo journalctl -u officechat-backup-job.service --since today --no-pager
sudo stat -c '%U %G %a %n' /run/officechat-backup-agent/agent.sock
sudo lslocks --output COMMAND,PID,TYPE,PATH | grep -F '/run/lock/officechat/backup.lock'
```

Основные безопасные коды ошибок: `BACKUP_BUSY`, `BACKUP_EXECUTION_FAILED`, `VERIFY_FAILED`, `EXECUTOR_UNAVAILABLE`, `EXECUTOR_TIMEOUT`, `JOB_INTERRUPTED`. Подробности ищите в журнале соответствующего исполнителя; raw stderr и приватное содержимое копии намеренно не возвращаются браузеру.

На SELinux Enforcing дополнительно используйте:

```bash
getenforce
sudo ausearch -m AVC,USER_AVC -ts recent
sudo ls -Zd /run/officechat-backup-agent /var/backups/officechat /var/lib/officechat
```

Не отключайте SELinux, не делайте socket world-writable, не выдавайте backend доступ к Docker и не расширяйте allowlist исполнителя как способ диагностики.

## Установка и обновление

Release installer устанавливает скрипты, документацию, конфигурацию агента и пять backup units. `/etc/officechat/backup.conf` и `/etc/officechat/backup-agent.conf` создаются только при отсутствии и сохраняются при update. Агент включается и запускается; `officechat-backup.timer` включается только с `--enable-backup-timer` или последующей явной командой оператора.

Updater сохраняет enabled/active state агента, устанавливает фиксированные executor assets до `daemon-reload`, проверяет новый socket и пересоздаёт только backend, чтобы read-only bind указывал на текущий inode socket. Состояние и расписание timer не меняются.
