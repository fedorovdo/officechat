# Управление хранилищем OfficeChat

Admin page: `http://localhost:3100/ru/admin/storage`. Доступ разрешён только ролям `superadmin` и `admin`.

## Статистика

`GET /api/admin/storage/stats` возвращает агрегаты без message body и storage paths:

- общий фактический размер uploads volume и avatars;
- размер group/direct/discussion attachments;
- количество attachment metadata и отсутствующих файлов;
- active, archived и soft-deleted message counts;
- даты самой старой active и archived записи.

Direct-message content не раскрывается администратору.

## Attachment retention

При явном `attachment_retention_days` cleanup удаляет physical file, но сохраняет filename, MIME, size и attachment row. Поля `file_available=false` и `file_deleted_at` фиксируют результат. UI показывает `Файл удалён по политике хранения`, download endpoint возвращает `410 Gone`.

Файл сначала переименовывается во временный tracked path, metadata коммитится, затем temporary file удаляется. При DB rollback исходное имя восстанавливается. Missing files отмечаются недоступными и учитываются в summary.

## Backup и production

Перед включением retention нужны согласованные backup PostgreSQL и Docker volume `officechat_uploads` (`/data/uploads`). Один компонент без второго не обеспечивает полноценное восстановление.

Для production рекомендуется отдельный worker с Valkey distributed lock, метриками и alerting. До появления worker автоматическая очистка не запускается.
