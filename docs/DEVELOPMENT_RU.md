# Разработка OfficeChat

Локальная разработка рассчитана на Windows и Docker Desktop.

## Первый запуск

```powershell
copy .env.example .env
docker compose up -d --build
```

## Локальные адреса

- Frontend: http://localhost:3100
- User app: http://localhost:3100/ru/app
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

## Bots

Страница управления ботами: http://localhost:3100/ru/admin/bots

`superadmin` и `admin` могут создавать ботов, отключать их и перевыпускать токены. При создании бот получает связанного пользователя с ролью `bot` и `auth_provider="bot"`. Полный токен показывается только один раз при создании или перевыпуске.

Чтобы бот мог отправлять сообщения в группу, добавьте bot user в группу по username на странице деталей группы.

Incoming webhook:

```text
POST /api/bots/incoming/{token}
```

Пример:

```powershell
curl.exe -X POST http://localhost:8100/api/bots/incoming/PASTE_TOKEN_HERE -H "Content-Type: application/json" -d "{\"group_slug\":\"alerts\",\"title\":\"Zabbix alert\",\"severity\":\"high\",\"body\":\"CPU usage is above threshold\"}"
```

Webhook также принимает Zabbix-friendly поля `severity`, `status`, `host`, `ip`, `problem`, `trigger`, `event_id`, `url` и `timestamp`. Они форматируются в обычный plain text и рассылаются через текущий WebSocket `message.created`.

Пример monitoring payload:

```powershell
curl.exe -X POST http://localhost:8100/api/bots/incoming/PASTE_TOKEN_HERE -H "Content-Type: application/json" -d "{\"group_slug\":\"alerts\",\"severity\":\"high\",\"status\":\"problem\",\"title\":\"Disk space low\",\"host\":\"DC5\",\"ip\":\"192.168.1.100\",\"problem\":\"Free space on C: is less than 10%\",\"event_id\":\"12345\",\"url\":\"http://zabbix.local/tr_events.php?triggerid=12345\",\"body\":\"Check the server before the next backup window.\"}"
```

Outgoing webhooks, AI provider, вложения от бота, direct messages и отдельные scoped permissions для ботов пока не реализованы.

## User app shell

Основной пользовательский интерфейс чата доступен по адресу:

```text
http://localhost:3100/ru/app
```

Dashboard теперь служит входной точкой: основная кнопка открывает OfficeChat app shell, а admin-ссылки показываются только `superadmin` и `admin`.

Текущая локальная разработка использует один frontend port `3100`. Пользовательский app находится на `/ru/app`, административные страницы остаются на `/ru/admin/*`. В production позже можно разделить user/admin интерфейсы через nginx hostnames или отдельные frontend entrypoints.

Настройки app shell пока хранятся в `localStorage`: язык, сторона боковой панели, размер шрифта и акцентный цвет. Позже их нужно перенести в backend `user_preferences`.

Раздел Users в боковой панели является навигационной заготовкой для будущих direct messages. Личные сообщения в этой версии не реализованы.

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
