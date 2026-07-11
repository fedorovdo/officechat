# Auth Foundation OfficeChat

## Специальные права

OfficeChat поддерживает granular permissions поверх ролей. В v0.1 доступны `can_broadcast` и `can_pin_messages`, но сами рассылки и закрепление сообщений ещё не реализованы. Эти права не выдаются автоматически ролям `admin`, `moderator`, `group_owner` или `user`; `superadmin` имеет все активные права неявно. Управлять явными grants может только `superadmin` через `/api/admin/users/{user_id}/permissions` и Admin Users drawer. `GET /api/auth/me` возвращает эффективные `permissions` для UI, но JWT не является источником истины.

## События аутентификации

Журнал аудита записывает `auth.login.succeeded`, `auth.login.failed`, `auth.logout`, `auth.session.expired` и `security.invalid_token`. Пароль и JWT не сохраняются; для rate-limited диагностики недействительного JWT используется только первые 12 hex-символов SHA-256 fingerprint.

## Усиление сессий v0.1

Frontend централизованно обрабатывает истёкший или недействительный JWT. Ответ `401` удаляет только `officechat.access_token`, останавливает polling и WebSocket reconnect, затем выполняет переход через `window.location.replace` на локализованный `/ru/login` или `/en/login`. Ответ `403` означает недостаток прав и не завершает сессию. Сетевые ошибки и ответы `500` также не удаляют действующий токен.

Перед загрузкой защищённой страницы frontend читает `exp` из JWT только для ранней UX-проверки. Backend остаётся единственным источником проверки подписи и авторизации. Явный выход выполняет backend-вызов по возможности, но всегда удаляет локальный токен и закрывает соединения, даже если сервер недоступен. Остальные настройки `localStorage` не очищаются.

`APP_SECRET_KEY` является постоянным JWT-секретом; также поддерживается имя `JWT_SECRET`. В production нельзя использовать development-значение. Изменение секрета делает недействительными все активные JWT. Автоматическая ротация при старте не выполняется. Перенос browser-сессий из `localStorage` в защищённые HttpOnly cookies остаётся задачей production hardening.

Настройки retention, storage statistics и ручной cleanup доступны только `superadmin`/`admin`. Эти полномочия не дают доступа к телам чужих direct messages или их archive endpoints; direct history остаётся participant-only.

OfficeChat Auth Foundation v0.1 добавляет локальную основу аутентификации без реализации чатов, WebSocket и LDAP/AD.

## Локальная аутентификация

В MVP используется локальная аутентификация по имени пользователя и паролю. Пароли хранятся только в виде bcrypt-хеша через `passlib`.

API использует bearer token:

- `POST /api/auth/login`
- `GET /api/auth/me`
- `POST /api/auth/logout`

Токен подписывается `APP_SECRET_KEY` и имеет срок действия из `ACCESS_TOKEN_EXPIRE_MINUTES`.

## Bootstrap superadmin

При старте backend проверяет таблицу пользователей. Если пользователей нет, создается первый superadmin из переменных окружения:

- `BOOTSTRAP_SUPERADMIN_USERNAME`
- `BOOTSTRAP_SUPERADMIN_PASSWORD`
- `BOOTSTRAP_SUPERADMIN_DISPLAY_NAME`

Если пользователи уже существуют, bootstrap не создает и не перезаписывает учетные записи.

Локальные значения по умолчанию:

- username: `admin`
- password: `admin12345`
- display name: `OfficeChat Admin`

Эти значения подходят только для разработки.

## Роли

Роли подготовлены с начала проекта:

- `superadmin`
- `admin`
- `group_owner`
- `moderator`
- `user`
- `bot`

На этапе v0.1 endpoints `/api/admin/users` доступны только ролям `superadmin` и `admin`.

Frontend-страница управления пользователями доступна по адресу:

- http://localhost:3100/ru/admin/users

Эта страница видна и доступна только пользователям с ролями `superadmin` и `admin`. Остальные пользователи получают дружелюбное сообщение об отказе в доступе.

## User Management v0.2

Администраторская страница поддерживает базовые действия:

- создание пользователя;
- изменение `display_name`;
- изменение или очистку `email`;
- изменение `role`;
- включение и отключение `is_active`;
- сброс пароля для локальных пользователей.

Отключение пользователя является soft cleanup действием: запись пользователя не удаляется физически. Это сохраняет авторство сообщений, историю групп и будущий audit trail. Отключенный пользователь не может войти и получить новый bearer token. Bot users тоже можно отключать; это блокирует активность бота, если текущая логика проверяет активность связанного пользователя.

Ограничения:

- `username` не меняется после создания;
- `auth_provider` не меняется через UI;
- пароль меняется только через отдельное действие сброса;
- обычный `admin` не может назначать роль `superadmin`;
- обычный `admin` не может редактировать существующих `superadmin`;
- ни один пользователь не может отключить собственную учетную запись;
- сброс пароля доступен только для пользователей с `auth_provider=local`.

Групповые роли (`owner`, `moderator`, `member`) применяются внутри конкретной группы и описаны в `docs/GROUPS_RU.md`.

## Почему нет саморегистрации

OfficeChat ориентирован на корпоративные и закрытые self-hosted среды. По умолчанию пользователей создает администратор, чтобы избежать случайного доступа в локальных сетях и при будущей публикации в интернет.

Публичный endpoint регистрации намеренно не добавлен.

## Будущий LDAP/AD

LDAP/AD не входит в MVP. Модель пользователя уже содержит поля `auth_provider` и `external_id`, чтобы позже добавить внешние провайдеры без переписывания бизнес-логики.

Для внешних пользователей `password_hash` может быть `NULL`, а вход будет делегирован соответствующему provider.
# RC production auth notes

Production startup rejects missing or weak `APP_SECRET_KEY`/`JWT_SECRET`. Use a persistent random secret of at least 32 characters; changing it invalidates all existing JWT sessions. `DATABASE_URL`, exact CORS origins and public frontend/backend URLs are required in production.
