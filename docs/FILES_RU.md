# Вложения OfficeChat

Attachment retention может удалить physical file с сохранением metadata. Такой файл получает `file_available=false`, download возвращает `410`, а UI показывает причину недоступности. Политика выключена по умолчанию и применяется только после актуального dry-run и подтверждённого admin run. Подробности: `docs/RETENTION_RU.md`.

Direct and Discussion Attachments v0.1 дополняет существующие групповые вложения. Локальные файлы теперь поддерживаются в группах, личных разговорах и обсуждениях сообщений.

## Хранилище

Backend хранит файлы в Docker volume, смонтированном как `UPLOADS_DIR=/data/uploads`. Внутри используются безопасные случайные имена и разбиение по контексту и дате:

```text
/data/uploads/groups/{group_id}/{year}/{month}/{day}/
/data/uploads/direct/{conversation_id}/{year}/{month}/{day}/
/data/uploads/discussions/{discussion_id}/{year}/{month}/{day}/
```

Оригинальное имя сохраняется только как metadata. Оно не используется как путь к файлу. `storage_path` и `stored_filename` не возвращаются публичным API.

## API

```text
POST /api/groups/{group_id}/messages/with-attachment
POST /api/groups/{group_id}/messages/with-attachments
GET /api/groups/{group_id}/attachments/{attachment_id}/download

POST /api/direct/conversations/{conversation_id}/messages/with-attachment
POST /api/direct/conversations/{conversation_id}/messages/with-attachments
GET /api/direct/conversations/{conversation_id}/attachments/{attachment_id}/download

POST /api/discussions/{discussion_id}/messages/with-attachment
POST /api/discussions/{discussion_id}/messages/with-attachments
GET /api/discussions/{discussion_id}/attachments/{attachment_id}/download
```

Plural upload использует `multipart/form-data`: поле `files` повторяется для каждого файла, `body` необязателен. Group/direct upload также принимает `reply_to_message_id`. Старые endpoints с полем `file` сохранены для совместимости.

Скачивание защищено JWT и проверкой membership. Attachment id нельзя использовать через другой group, conversation или discussion. Набор проверяется целиком, сообщение и строки attachments коммитятся один раз. При любой ошибке выполняется rollback и удаляются все файлы текущего запроса.

## Лимиты

```text
ATTACHMENT_MAX_UPLOAD_SIZE_MB=25
ATTACHMENT_MAX_FILES_PER_MESSAGE=10
ATTACHMENT_MAX_TOTAL_SIZE_MB=50
ALLOWED_UPLOAD_EXTENSIONS=txt,log,csv,md,json,xml,yaml,yml,ini,conf,pdf,doc,docx,xls,xlsx,png,jpg,jpeg,webp,zip
```

Пустые, слишком большие и файлы с запрещённым расширением отклоняются. Правила едины для групп, личных разговоров и обсуждений.

Для текстовых и конфигурационных файлов поддерживаются обычные MIME-варианты: `text/plain` для `txt/log/ini/conf`, `text/csv` и `application/csv`, JSON, XML и YAML MIME-типы. Некоторые браузеры отправляют `application/octet-stream`; такой MIME не блокирует файл с разрешённым расширением. Безопасность определяется extension allowlist, а не только предоставленным браузером MIME.

Исполняемые и скриптовые форматы `exe,com,bat,cmd,ps1,msi,dll,scr,js,vbs,jar,sh,apk` заблокированы отдельным denylist и не могут быть включены через `ALLOWED_UPLOAD_EXTENSIONS`.

## Вставка изображений из буфера обмена

В group, direct и discussion composer можно вставить скриншот через `Ctrl+V`. Поддерживаются clipboard-изображения PNG, JPEG и WebP. Frontend создаёт безопасное имя вида `screenshot-2026-07-02-221530.png`, показывает локальный thumbnail и отправляет файл через существующий multipart endpoint.

Clipboard image добавляется к уже выбранным файлам. До успешной отправки каждый image preview использует временный object URL; URL освобождается при удалении файла, очистке, отправке, смене чата или unmount. Обычная вставка текста не перехватывается.

## Drag-and-drop

На desktop несколько файлов можно перетащить в активную панель group, direct или discussion chat. Во время file drag показывается overlay; обычный text drag не перехватывается. Все допустимые dropped files добавляются к текущему выбору без автоматической отправки. `txt`, `log`, `csv`, `json`, `pdf`, `zip` и изображения обрабатываются одинаково по extension allowlist; browser MIME не ограничивает non-image drop.

Папки и пустые файлы отклоняются frontend, остальные проверки повторяет backend. File picker поддерживает `multiple`, clipboard paste добавляет screenshot. По умолчанию максимум `10` файлов, `25 MB` на файл и `50 MB` суммарно.

## Inline preview отправленных изображений

PNG, JPEG и WebP отображаются непосредственно в group, direct и discussion messages. Frontend выполняет authenticated fetch защищённого `download_url`, повторно проверяет MIME ответа, создаёт временный Blob URL и освобождает его при unmount или смене attachment. Bearer token не попадает в image URL.

Несколько изображений образуют компактную gallery. Lightbox показывает индекс, имя и оригинал, поддерживает `Escape`, `Left`/`Right`, кнопки навигации и закрытие. SVG не preview-ится. PDF, Office documents, text files и archives отображаются строками файла.

## Эксплуатация

Volume uploads необходимо резервировать вместе с PostgreSQL. Одна база без volume не восстановит содержимое вложений.

## Ограничения v0.1

- Нет antivirus scanning.
- Нет S3/MinIO или другого object storage.
- Нет backend thumbnail generation, image compression и gallery.
- Нет resumable/chunked uploads и server-side thumbnails/compression.
- Нет автоматической retention cleanup.
- Боты пока не загружают файлы через incoming webhook.
