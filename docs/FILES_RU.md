# Вложения OfficeChat

Direct and Discussion Attachments v0.1 дополняет существующие групповые вложения. Локальные файлы теперь поддерживаются в группах, личных разговорах и обсуждениях сообщений.

## Хранилище

Backend хранит файлы в Docker volume, смонтированном как `UPLOADS_DIR=/data/uploads`. Внутри используются безопасные случайные имена и разбиение по контексту и дате:

```text
/data/uploads/{group_id}/{year}/{month}/{day}/
/data/uploads/direct/{conversation_id}/{year}/{month}/{day}/
/data/uploads/discussions/{discussion_id}/{year}/{month}/{day}/
```

Оригинальное имя сохраняется только как metadata. Оно не используется как путь к файлу. `storage_path` и `stored_filename` не возвращаются публичным API.

## API

```text
POST /api/groups/{group_id}/messages/with-attachment
GET /api/groups/{group_id}/attachments/{attachment_id}/download

POST /api/direct/conversations/{conversation_id}/messages/with-attachment
GET /api/direct/conversations/{conversation_id}/attachments/{attachment_id}/download

POST /api/discussions/{discussion_id}/messages/with-attachment
GET /api/discussions/{discussion_id}/attachments/{attachment_id}/download
```

Upload использует `multipart/form-data`: `file` обязателен, `body` необязателен. Direct upload также принимает необязательный `reply_to_message_id`. Разрешены сообщения только с файлом.

Скачивание защищено JWT и проверкой membership. Attachment id нельзя использовать через другой group, conversation или discussion. При ошибке DB-транзакции сохранённый файл удаляется.

## Лимиты

```text
MAX_UPLOAD_SIZE_MB=25
ALLOWED_UPLOAD_EXTENSIONS=txt,log,csv,md,json,xml,yaml,yml,ini,conf,pdf,doc,docx,xls,xlsx,png,jpg,jpeg,webp,zip
```

Пустые, слишком большие и файлы с запрещённым расширением отклоняются. Правила едины для групп, личных разговоров и обсуждений.

Для текстовых и конфигурационных файлов поддерживаются обычные MIME-варианты: `text/plain` для `txt/log/ini/conf`, `text/csv` и `application/csv`, JSON, XML и YAML MIME-типы. Некоторые браузеры отправляют `application/octet-stream`; такой MIME не блокирует файл с разрешённым расширением. Безопасность определяется extension allowlist, а не только предоставленным браузером MIME.

Исполняемые и скриптовые форматы `exe,com,bat,cmd,ps1,msi,dll,scr,js,vbs,jar,sh,apk` заблокированы отдельным denylist и не могут быть включены через `ALLOWED_UPLOAD_EXTENSIONS`.

## Вставка изображений из буфера обмена

В group, direct и discussion composer можно вставить скриншот через `Ctrl+V`. Поддерживаются clipboard-изображения PNG, JPEG и WebP. Frontend создаёт безопасное имя вида `screenshot-2026-07-02-221530.png`, показывает локальный thumbnail и отправляет файл через существующий multipart endpoint.

В v0.1 сообщение содержит только одно вложение. Если файл уже выбран, вставленное изображение заменяет его с явным уведомлением. После удаления, успешной отправки, смены чата или unmount временный object URL освобождается. Обычная вставка многострочного текста не перехватывается.

## Inline preview отправленных изображений

PNG, JPEG и WebP отображаются непосредственно в group, direct и discussion messages. Frontend выполняет authenticated fetch защищённого `download_url`, повторно проверяет MIME ответа, создаёт временный Blob URL и освобождает его при unmount или смене attachment. Bearer token не попадает в image URL.

Клик по изображению открывает простой полноэкранный lightbox; `Escape`, кнопка закрытия и клик по overlay закрывают его. Имя, размер и защищённая загрузка оригинала остаются доступны. SVG намеренно не preview-ится. PDF, Office documents, text files и archives продолжают отображаться обычной строкой файла.

## Эксплуатация

Volume uploads необходимо резервировать вместе с PostgreSQL. Одна база без volume не восстановит содержимое вложений.

## Ограничения v0.1

- Нет antivirus scanning.
- Нет S3/MinIO или другого object storage.
- Нет image preview, gallery и thumbnails.
- Нет backend thumbnail generation, image compression и gallery.
- Нет drag-and-drop.
- Нет нескольких вложений в одном сообщении.
- Нет автоматической retention cleanup.
- Боты пока не загружают файлы через incoming webhook.
