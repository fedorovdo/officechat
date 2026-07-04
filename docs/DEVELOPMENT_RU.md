# Разработка OfficeChat

## Backend-тесты

Локальный backend-сервис Docker Compose собирается из стадии `development`, которая устанавливает зависимости из `apps/backend/requirements-dev.txt` и включает каталог `apps/backend/tests`. Runtime-стадия образа остаётся без pytest.

Стандартный запуск полного набора backend-тестов:

```powershell
docker compose exec backend python -m pytest -q
```

Короткая команда `docker compose exec backend pytest -q` также доступна, но форма через `python -m pytest` является основной.

## Audit Log

Admin UI: `http://localhost:3100/ru/admin/audit`. Для проверки создайте пользователя, измените роль/статус, выполните password reset и bot token rotation, затем убедитесь, что секретные значения отсутствуют в details и CSV. Каждый response содержит `X-Request-ID`.

Настройки: `AUDIT_RETENTION_DAYS=365`, `AUDIT_MAX_EXPORT_ROWS=10000`. Автоматическое удаление audit events в v0.1 отключено.

## Проверка истечения сессии

1. Войдите в `/ru/app` и измените либо удалите `officechat.access_token` в DevTools.
2. После reload приложение должно перейти на `/ru/login`, не запуская API/WebSocket storm.
3. Настройки языка, sidebar, уведомлений и emoji должны сохраниться.
4. Ответ `403` не должен завершать сессию; недоступность backend также не удаляет JWT.
5. Явный logout должен завершаться локально даже при остановленном backend.

Для разработки допустим документированный `APP_SECRET_KEY=change-me-in-production`. В production задайте длинный постоянный секрет. Docker Compose не генерирует его при перезапуске. Изменение `APP_SECRET_KEY`/`JWT_SECRET` инвалидирует все выданные токены. В backend logs WebSocket URL должен отображаться как `?token=[REDACTED]`.

Управление хранением доступно по `/ru/admin/storage`. Retention выключен по умолчанию. Безопасный flow: сохранить настройки, выполнить `POST /api/admin/retention/dry-run`, проверить backup, включить retention, повторить preview и подтвердить `POST /api/admin/retention/run`. Автоматического scheduler в v0.1 нет.

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
- `ATTACHMENT_MAX_UPLOAD_SIZE_MB`
- `ATTACHMENT_MAX_FILES_PER_MESSAGE`
- `ATTACHMENT_MAX_TOTAL_SIZE_MB`
- `ALLOWED_UPLOAD_EXTENSIONS`
- `UPLOADS_DIR`

Локальная учетная запись из `.env.example`:

- username: `admin`
- password: `admin12345`

Страница входа: http://localhost:3100/ru/login

Страница управления пользователями: http://localhost:3100/ru/admin/users

Доступ к управлению пользователями есть только у ролей `superadmin` и `admin`.

На странице управления можно создавать пользователей, менять отображаемое имя, email, роль, активность и сбрасывать пароль локальным пользователям. Роль `superadmin` может редактировать только другой `superadmin`.

Отключение пользователя выполняется через `is_active=false`. Пользователь не удаляется физически, чтобы сохранить авторство сообщений, историю групп и будущий audit trail.

## Groups

Страница групп: http://localhost:3100/ru/groups

`superadmin` и `admin` могут создавать группы. Владельцы групп могут управлять участниками своей группы.

Архивация группы выполняется через `is_active=false`, восстановление - через `is_active=true`. Группы не удаляются физически: это безопаснее для истории сообщений, вложений и будущего аудита. Обычные пользователи и user app видят только активные группы, а admin-страница групп запрашивает архивированные группы через `GET /api/groups?include_inactive=true`.

## Messages

Сообщения в группах доступны через REST API и блок на странице деталей группы. Участники группы могут читать и отправлять текстовые сообщения. Автор может редактировать и удалять свои сообщения. Владельцы, модераторы группы, `admin` и `superadmin` могут удалять сообщения.

WebSocket-подключение для онлайн-обновлений сообщений доступно по адресу `ws://localhost:8100/api/ws/groups/{groupId}?token=...`. Отправка, редактирование и удаление сообщений остаются REST-операциями. Текущая реализация WebSocket рассчитана на один backend-инстанс; для нескольких инстансов позже нужен Valkey pub/sub или другой брокер.

Реакции, typing indicators и read receipts пока не реализованы.

## Files

Вложения для сообщений в группах, личных разговорах и discussions сохраняются локально в Docker volume backend. В контейнере путь по умолчанию:

```text
/data/uploads
```

Plural upload endpoints: `POST /api/groups/{groupId}/messages/with-attachments`, `POST /api/direct/conversations/{conversationId}/messages/with-attachments` и `POST /api/discussions/{discussionId}/messages/with-attachments`. Поле `files` повторяется. Старые `/with-attachment` endpoints остаются совместимыми. Download требует membership в нужном контексте.

По умолчанию разрешены расширения `txt,log,csv,md,json,xml,yaml,yml,ini,conf,pdf,doc,docx,xls,xlsx,png,jpg,jpeg,webp,zip`. Лимиты: `ATTACHMENT_MAX_UPLOAD_SIZE_MB=25` на файл, `ATTACHMENT_MAX_FILES_PER_MESSAGE=10`, `ATTACHMENT_MAX_TOTAL_SIZE_MB=50`. MIME `application/octet-stream` допустим при разрешённом extension. Executable/script denylist остаётся обязательным. Volume `/data/uploads` включается в backup. Antivirus scanning, S3, resumable uploads и backend thumbnails пока не реализованы.

Frontend показывает PNG/JPEG/WebP inline через authenticated Blob fetch; обычный `<img src="protected-url">` не используется, token в URL не добавляется. MIME ответа проверяется повторно, object URLs освобождаются. SVG, PDF и документы не preview-ятся. Backend thumbnails и image compression пока отсутствуют.

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

В user app доступна отдельная панель профиля. Она показывает сведения об аккаунте, позволяет изменить собственное отображаемое имя и загрузить, заменить или удалить аватар. Поддерживаются PNG, JPG/JPEG и WebP до `AVATAR_MAX_UPLOAD_SIZE_MB` (по умолчанию 5 MB). Аватары сохраняются в `/data/uploads/avatars/users/{user_id}/`; uploads volume нужно включать в резервное копирование. Подробности: `docs/PROFILE_RU.md`. UI-настройки пока не сохраняются в backend.

Уведомления браузера включаются в настройках app shell. Текущая версия frontend-only: настройка хранится в `localStorage` (`officechat.notifications.enabled`), уведомления работают только пока OfficeChat открыт в браузере и только после разрешения браузера и ОС. В настройках есть кнопка `Тест уведомления`, кнопка `Как включить уведомления` и диагностический блок с `Notification.permission`, значением `localStorage`, `document.visibilityState`, фокусом окна, последней попыткой, результатом и причиной пропуска. Подробная инструкция: `docs/NOTIFICATIONS_RU.md`.

Текущая версия получает события для browser notifications через персональный канал `WS /api/ws/me`. Он доставляет `user.group.message.created` и `user.direct.message.created` для текущего пользователя, а открытые чаты продолжают использовать свои group/direct WebSocket каналы. Service worker, server push, email и mobile push уведомления запланированы позже.

Раздел Users в боковой панели открывает личные сообщения между активными пользователями. Bot users исключены из личных сообщений в этой версии. Direct composer поддерживает текст с файлом и file-only сообщения.

Боковая панель user app поддерживает локальный поиск по группам и пользователям. Группы фильтруются по имени и `slug`, пользователи - по отображаемому имени и `username`. Обычный список пользователей для личных сообщений скрывает неактивные аккаунты, текущего пользователя и bot users.

User app использует полноэкранную messenger-style раскладку: изменяемая по ширине и сворачиваемая панель чатов, центральный чат с собственной прокруткой и необязательная правая панель обсуждения. Ширина sidebar, свернутое состояние и вкладка `Все чаты` / `Группы` / `Личные` хранятся только в `localStorage`. На небольших экранах v0.1 использует базовый режим одного видимого экрана за раз.

В composer `Enter` отправляет сообщение, `Shift+Enter` вставляет новую строку, а `Ctrl+Enter` сохраняется для обратной совместимости. Компактная кнопка вложения доступна в group, direct и discussion composer.

## Direct messages

Личные сообщения доступны в user app shell:

```text
http://localhost:3100/ru/app
```

Backend endpoints:

```text
GET /api/direct/conversations
POST /api/direct/conversations
GET /api/direct/conversations/{conversation_id}/messages
POST /api/direct/conversations/{conversation_id}/messages
PATCH /api/direct/conversations/{conversation_id}/messages/{message_id}
DELETE /api/direct/conversations/{conversation_id}/messages/{message_id}
WS /api/ws/direct/{conversation_id}?token=...
```

Личные сообщения видны только участникам разговора. Роли `superadmin` и `admin` не дают специального доступа к чужим private conversations в MVP.

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

Компонент `components/EmojiPicker.tsx` используется в composer групповых, личных сообщений и обсуждений. Он работает только со стандартными Unicode emoji, не требует внешней библиотеки и сохраняет до 20 недавних emoji в `localStorage` под ключом `officechat.emoji.recent`. При изменении набора или UI picker необходимо проверить вставку в позицию курсора, поиск RU/EN, закрытие по `Escape` и адаптивную раскладку.

## Остановка

```powershell
docker compose down
```
