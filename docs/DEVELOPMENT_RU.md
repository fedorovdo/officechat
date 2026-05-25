# Разработка OfficeChat

Локальная разработка рассчитана на Windows и Docker Desktop.

## Первый запуск

```powershell
copy .env.example .env
docker compose up -d --build
```

## Локальные адреса

- Frontend: http://localhost:3100
- Backend: http://localhost:8100
- Backend root: http://localhost:8100/
- Backend docs: http://localhost:8100/docs
- Groups: http://localhost:3100/ru/groups

## Auth

Саморегистрация отключена. Первый локальный superadmin создается при старте backend, если в базе еще нет пользователей.

Переменные окружения:

- `APP_SECRET_KEY`
- `ACCESS_TOKEN_EXPIRE_MINUTES`
- `BOOTSTRAP_SUPERADMIN_USERNAME`
- `BOOTSTRAP_SUPERADMIN_PASSWORD`
- `BOOTSTRAP_SUPERADMIN_DISPLAY_NAME`
- `MESSAGE_MAX_LENGTH`
- `MAX_UPLOAD_SIZE_MB`
- `ALLOWED_UPLOAD_EXTENSIONS`
- `UPLOADS_DIR`

Локальная учетная запись из `.env.example`:

- username: `admin`
- password: `admin12345`

Страница входа: http://localhost:3100/ru/login

Страница управления пользователями: http://localhost:3100/ru/admin/users

Доступ к управлению пользователями есть только у ролей `superadmin` и `admin`.

На странице управления можно создавать пользователей, менять отображаемое имя, email, роль, активность и сбрасывать пароль локальным пользователям. Роль `superadmin` может редактировать только другой `superadmin`.

## Groups

Страница групп: http://localhost:3100/ru/groups

`superadmin` и `admin` могут создавать группы. Владельцы групп могут управлять участниками своей группы.

## Messages

Сообщения в группах доступны через REST API и блок на странице деталей группы. Участники группы могут читать и отправлять текстовые сообщения. Автор может редактировать и удалять свои сообщения. Владельцы, модераторы группы, `admin` и `superadmin` могут удалять сообщения.

WebSocket-подключение для онлайн-обновлений сообщений доступно по адресу `ws://localhost:8100/api/ws/groups/{groupId}?token=...`. Отправка, редактирование и удаление сообщений остаются REST-операциями. Текущая реализация WebSocket рассчитана на один backend-инстанс; для нескольких инстансов позже нужен Valkey pub/sub или другой брокер.

Реакции, typing indicators, read receipts и личные сообщения пока не реализованы.

## Files

Вложения для сообщений в группах сохраняются локально в Docker volume backend. В контейнере путь по умолчанию:

```text
/data/uploads
```

Отправка файла выполняется через `POST /api/groups/{groupId}/messages/with-attachment`. Скачивание выполняется через `GET /api/groups/{groupId}/attachments/{attachmentId}/download` и требует доступ к группе.

По умолчанию разрешены расширения `pdf,doc,docx,xls,xlsx,png,jpg,jpeg,txt,zip`, лимит размера - `25` MB. Antivirus scanning, S3, previews, thumbnails, drag-and-drop и retention cleanup пока не реализованы.

## Проверка сервисов

```powershell
docker compose ps
curl http://localhost:8100/
curl http://localhost:8100/health
curl http://localhost:8100/api/system/info
curl http://localhost:8100/api/db-check
curl http://localhost:8100/api/cache-check
curl.exe -X POST http://localhost:8100/api/auth/login -H "Content-Type: application/json" -d "{\"username\":\"admin\",\"password\":\"admin12345\"}"
```

## Backend

Backend находится в `apps/backend`.

Основные файлы:

- `app/main.py`
- `app/core/config.py`
- `app/api/routes`
- `app/db`
- `app/services`

## Frontend

Frontend находится в `apps/frontend`.

Словари интерфейса:

- `dictionaries/ru.json`
- `dictionaries/en.json`

Новые строки интерфейса желательно добавлять в словари, а не хардкодить в компонентах.

## Остановка

```powershell
docker compose down
```
