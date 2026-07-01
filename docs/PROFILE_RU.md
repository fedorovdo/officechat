# Профиль пользователя OfficeChat

User Profile Foundation позволяет авторизованному активному пользователю просматривать сведения о своем аккаунте, изменять отображаемое имя и управлять собственным аватаром.

## API профиля

- `GET /api/auth/me` - текущий пользователь;
- `PATCH /api/auth/me` - изменение собственного `display_name`;
- `POST /api/auth/me/avatar` - загрузка или замена аватара через `multipart/form-data`;
- `DELETE /api/auth/me/avatar` - удаление собственного аватара;
- `GET /api/users/{user_id}/avatar` - получение изображения авторизованным пользователем.

Пользователь может изменять только собственный аватар. Администраторское редактирование чужих аватаров в v0.1 не поддерживается.

## Локальное хранение

Аватары сохраняются в backend uploads volume под `UPLOADS_DIR`:

```text
/data/uploads/avatars/users/{user_id}/
```

В базе данных хранится только внутренний относительный путь, content type и время обновления. Файловый путь не возвращается через API. После успешной замены старый файл удаляется; после удаления аватара metadata очищается и интерфейс возвращается к initials fallback.

Uploads volume необходимо включать в резервное копирование вместе с PostgreSQL. Восстановление только базы данных без uploads volume приведет к отсутствующим изображениям.

## Ограничения

По умолчанию разрешены:

- PNG (`image/png`);
- JPG/JPEG (`image/jpeg`);
- WebP (`image/webp`);
- максимальный размер `5 MB`.

Настройки:

```env
AVATAR_MAX_UPLOAD_SIZE_MB=5
ALLOWED_AVATAR_EXTENSIONS=png,jpg,jpeg,webp
```

Backend проверяет расширение, MIME type, размер и сигнатуру файла. SVG и исполняемые форматы не принимаются. Cropping, drag-and-drop, image editing, EXIF processing и remote object storage пока не реализованы.

## Cache refresh

`avatar_url` содержит version query на основе `avatar_updated_at`. После replacement URL меняется, поэтому браузер не использует устаревшее изображение. Frontend загружает защищенный avatar endpoint с bearer token и использует initials, если изображения нет или загрузка завершилась ошибкой.
