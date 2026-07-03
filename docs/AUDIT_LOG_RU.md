# Журнал аудита OfficeChat

Audit Log v0.1 хранит важные административные и security-события в неизменяемой таблице `audit_events`. Запись содержит снимок имени и роли инициатора, тип события, статус, целевой объект, прямой IP клиента, user agent, request ID и очищенные детали.

## Что записывается

- успешные и неуспешные входы, выходы, истёкшие и недействительные JWT;
- создание и изменение пользователей, роли, включение/отключение и сброс пароля;
- создание и изменение групп, архивирование и управление участниками;
- создание и изменение ботов, включение/отключение, ротация token и неуспешные webhook-вызовы;
- создание обсуждений и изменение состава участников;
- изменение профиля и avatar, отклонённые avatar uploads;
- изменение retention settings, dry-run и выполнение cleanup;
- выбранные попытки доступа к admin API без подходящей роли.

Обычная отправка сообщений не записывается.

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
