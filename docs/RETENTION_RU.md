# Политика хранения OfficeChat

## Связь с Audit Log

Изменение retention settings, dry-run и cleanup записываются и в legacy `retention_audit`, и в централизованный `audit_events`. Это сохраняет совместимость v0.1 и даёт единый admin search/export. Chat retention не удаляет `audit_events`; `AUDIT_RETENTION_DAYS` пока документирует будущую отдельную политику без автоматического удаления.

Retention and Storage Management v0.1 добавляет безопасную архивацию истории и управляемое удаление содержимого файлов. По умолчанию политика выключена: `retention_enabled=false`, `active_history_days=0`, `attachment_retention_days=null`. Миграция и запуск backend не архивируют и не удаляют существующие данные.

## Архив и удаление

Архивация не равна удалению. Архивное сообщение остаётся в PostgreSQL вместе с отправителем, reply, reactions, mentions и metadata вложений. Оно исчезает из активной истории и доступно участнику исходного чата через отдельный read-only endpoint:

```text
GET /api/groups/{group_id}/messages/archive
GET /api/direct/conversations/{conversation_id}/messages/archive
GET /api/discussions/{discussion_id}/messages/archive
```

Архивные сообщения нельзя редактировать, удалять, использовать как новую reply target или изменять их reactions. Архивация не создаёт WebSocket event. Права доступа совпадают с обычной историей; admin не получает доступ к чужим direct conversations.

Archive endpoints возвращают newest-first страницы, `limit` ограничен `100`, cursor `before` принимает message UUID.

Физическое удаление архивных сообщений по `delete_archived_after_days` намеренно не выполняется в v0.1. Поле зарезервировано для следующей версии после отдельного анализа каскадов replies, discussions, mentions и attachments.

## Настройки и API

```text
GET   /api/admin/retention/settings
PATCH /api/admin/retention/settings
POST  /api/admin/retention/dry-run
POST  /api/admin/retention/run
```

- `active_history_days=0` хранит активную историю бессрочно.
- `archive_enabled=true` разрешает перенос старых сообщений в архив после ручного запуска.
- `attachment_retention_days=null` не удаляет файл отдельно от истории.
- `cleanup_batch_size` ограничивает одну DB-транзакцию; default `500`.
- `cleanup_interval_hours` зарезервирован для будущего worker.

## Безопасный запуск

1. Сохранить настройки без включения retention.
2. Выполнить dry-run и проверить summary.
3. Проверить backup PostgreSQL и uploads volume.
4. Явно включить retention.
5. Повторить dry-run после последнего изменения настроек.
6. Подтвердить ручной запуск.

Backend отклоняет `/run`, если retention выключен, отсутствует актуальный dry-run или уже выполняется cleanup. Обработка идёт пакетами с commit на пакет. Ошибки записываются в summary.

## Audit и ограничения

`retention_audit` хранит old/new settings, dry-run summary, начало и результат cleanup, actor и timestamp. Тела private messages в audit и storage stats не записываются.

- Только ручной запуск, без scheduler/worker.
- Lock рассчитан на single-backend Docker deployment; multi-instance требует Valkey distributed lock.
- Нет permanent message deletion.
- Нет antivirus scanning, S3/MinIO и resumable uploads.
