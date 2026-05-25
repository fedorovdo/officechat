# File Attachments Foundation OfficeChat

File Attachments Foundation v0.1 добавляет базовые локальные вложения для сообщений в группах.

Файлы хранятся локально в Docker volume, который монтируется в backend как:

```text
/data/uploads
```

Путь настраивается переменной окружения:

```text
UPLOADS_DIR=/data/uploads
```

## Как это работает

Отправка сообщения с файлом выполняется через REST endpoint:

```text
POST /api/groups/{group_id}/messages/with-attachment
```

Запрос использует `multipart/form-data`:

- `file` - обязательный файл;
- `body` - необязательный текст сообщения.

Backend:

- проверяет JWT bearer token;
- проверяет доступ пользователя к группе;
- проверяет размер и расширение файла;
- создает сообщение;
- сохраняет файл в подпапку по `group_id` и дате;
- создает запись `message_attachments`;
- отправляет `message.created` через WebSocket.

Оригинальное имя файла хранится только как metadata. Для хранения используется безопасное уникальное имя, сгенерированное backend.

## Скачивание

Скачивание выполняется через защищенный endpoint:

```text
GET /api/groups/{group_id}/attachments/{attachment_id}/download
```

Пользователь должен иметь доступ к группе. API не раскрывает внутренний `storage_path`.

## Лимиты

Переменные окружения:

```text
MAX_UPLOAD_SIZE_MB=25
ALLOWED_UPLOAD_EXTENSIONS=pdf,doc,docx,xls,xlsx,png,jpg,jpeg,txt,zip
```

Пустые файлы отклоняются. Файлы больше лимита отклоняются. Расширения вне списка отклоняются.

## Ограничения v0.1

- Нет antivirus scanning.
- Нет S3/object storage.
- Нет image preview.
- Нет thumbnails.
- Нет drag-and-drop.
- Нет file retention cleanup.
- Нет direct messages.
