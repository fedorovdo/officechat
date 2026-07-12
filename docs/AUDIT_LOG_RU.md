# Журнал аудита OfficeChat

## События специальных прав

Granular Permissions v0.1 пишет `permission.granted` и `permission.revoked` в категорию `security`. Actor - `superadmin`, target - пользователь, которому назначили или отозвали право. В `details` сохраняется только безопасный ключ `permission`, например `can_broadcast`; JWT, пароли, токены и session data не сохраняются.

Audit Log v0.1 хранит важные административные и security-события в неизменяемой таблице `audit_events`. Запись содержит снимок имени и роли инициатора, тип события, статус, целевой объект, прямой IP клиента, user agent, request ID и очищенные детали.

## Что записывается

- успешные и неуспешные входы, выходы, истёкшие и недействительные JWT;
- создание и изменение пользователей, роли, включение/отключение и сброс пароля;
- создание и изменение групп, архивирование и управление участниками;
- создание и изменение ботов, включение/отключение, ротация token и неуспешные webhook-вызовы;
- создание обсуждений и изменение состава участников;
- изменение профиля и avatar, отклонённые avatar uploads;
- изменение retention settings, dry-run и выполнение cleanup;
- закрепление, открепление и изменение заметки закреплённого сообщения (`message.pinned`, `message.unpinned`, `message.pin_note_updated`);
- выбранные попытки доступа к admin API без подходящей роли.

Обычная отправка сообщений не записывается. Для закреплений audit details содержат только безопасные идентификаторы и длину заметки; тело сообщения и полный текст заметки не сохраняются.

## Приватность

Sanitizer рекурсивно заменяет на `[REDACTED]` пароли, hashes, JWT, bearer authorization, bot/webhook tokens, cookies, message body, attachment content и storage paths. Строки ограничиваются по длине. Audit log не содержит private/direct message text и файлов.

IP берётся только из непосредственного соединения. Произвольный `X-Forwarded-For` не считается доверенным. Для production reverse proxy доверие к forwarded headers должно настраиваться отдельно.

## API и доступ

Только `superadmin` и `admin` могут использовать:

- `GET /api/admin/audit/events` — фильтры и обязательная пагинация;
- `GET /api/admin/audit/events/{event_id}` — очищенные детали;
- `GET /api/admin/audit/filters` — доступные категории, статусы и event types;
- `GET /api/admin/audit/export.csv` — UTF-8 CSV с BOM и теми же фильтрами.

Экспорт ограничен `AUDIT_MAX_EXPORT_ROWS`, по умолчанию 10000 строк. UI доступен по `/ru/admin/audit` и `/en/admin/audit`.

## Request ID и retention

Каждый HTTP response получает `X-Request-ID`; тот же UUID сохраняется в audit event. `AUDIT_RETENTION_DAYS=365` пока является документированной политикой: v0.1 автоматически не удаляет audit events. Обычный chat retention cleanup таблицу `audit_events` не затрагивает. Перед production-cleanup нужны backup, отдельное подтверждение и требования организации к срокам хранения.
## Calendar Events v0.1

Мутации календаря записывают безопасные события аудита: `calendar.event_created`, `calendar.event_updated`, `calendar.event_rescheduled`, `calendar.event_cancelled`, `calendar.event_restored`. В детали попадают тип события, тип аудитории, количество получателей, время и статус; название, описание, место, ссылка конференции и список получателей не сохраняются в Audit Log.
