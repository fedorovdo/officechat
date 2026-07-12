# Архитектура OfficeChat

## Branding metadata

Frontend хранит публичную конфигурацию продукта в `apps/frontend/lib/brand.ts` и использует общие компоненты `BrandLogo`/`BrandMark`. Backend `/health` отдаёт только безопасные metadata: service, product, version и опциональный короткий build SHA. Секреты, filesystem paths, database host/credentials и JWT-настройки не раскрываются. Подробнее: `docs/BRANDING_RU.md`.

## Гранулярные права

Помимо ролей OfficeChat использует таблицы `permissions` и `user_permissions`. Роли задают широкий доступ, а специальные права закрывают чувствительные будущие функции: `can_broadcast` и `can_pin_messages`. `superadmin` получает все активные права неявно, остальные пользователи - только через явные grants. JWT не хранит авторитетные права; backend проверяет их через `app/services/permissions.py`. После изменения grants affected user получает `permissions.updated` через `/api/ws/me`. Подробности: `docs/PERMISSIONS_RU.md`.

Pinned Messages v0.1 использует отдельную таблицу `pinned_messages` с polymorphic ссылкой на group/direct/discussion message через `chat_type`, `chat_id` и `message_id`. Backend проверяет обычный доступ к чату и эффективное `can_pin_messages`; роль admin не является отдельным обходом приватности direct/discussion. Удаление и retention-архивация сообщений снимают связанные pins, а selected room WebSocket доставляет `message.pinned`, `message.pin_updated` и `message.unpinned`.

## Audit subsystem

Централизованный `AuditEvent` хранится в PostgreSQL отдельно от chat messages и legacy `retention_audit`. Route/service boundary добавляет успешные admin events в ту же транзакцию, что и изменение данных. Неуспешные authentication/security events используют короткую отдельную session и rate-limited best-effort запись. Request ID middleware связывает HTTP response, server logs и audit event.

Audit subsystem не зависит от Valkey и не очищается chat retention policy. Все `details` проходят рекурсивный sanitizer до записи.

Retention subsystem использует singleton `retention_settings`, audit table и archive metadata на group/direct/discussion message tables. Attachment metadata сохраняется после удаления physical file. В v0.1 cleanup запускается только вручную: backend startup и миграции никогда не запускают retention jobs.

OfficeChat строится как monorepo с отдельными приложениями backend и frontend.

## Компоненты

- `apps/backend` - FastAPI API-сервис.
- `apps/frontend` - Next.js интерфейс.
- `postgres` - основная реляционная база данных.
- `valkey` - cache, presence и будущая очередь фоновых задач.
- `uploads` - Docker volume для локального хранения файлов MVP.
- `deploy/nginx` - место для будущей reverse proxy конфигурации.

## Presence и typing

Presence использует Valkey как первичное эфемерное хранилище подключений `/api/ws/me`. Каждая вкладка и устройство имеют отдельный connection ID и TTL; PostgreSQL хранит только `users.last_seen_at`, записываемый при переходе в offline после grace-периода. Heartbeat и typing никогда не записываются в PostgreSQL и не попадают в audit log.

Комнатные WebSocket-каналы групп, direct conversations и discussions передают только `typing.start`/`typing.stop` и агрегированный `typing.updated`, без текста черновика. HTTP API сообщений не зависит от Valkey presence и продолжает работать в degraded mode. Текущее состояние совместимо с одним backend-инстансом; межинстансная доставка событий потребует Valkey pub/sub.

## Unread high-water marks

`chat_read_states` хранит одну строку на пользователя и чат. Unread определяется сравнением `(message.created_at, message.id)` с `(last_read_message_created_at, last_read_message_id)`; own, deleted и archived messages исключаются. Summary выполняет bounded запросы по group/direct/discussion и не создаёт N+1 count на sidebar. Personal WebSocket синхронизирует counters, а direct room socket передаёт только последний marker другого участника без раскрытия полной read history.

## Поиск сообщений

`app/services/message_search.py` объединяет три permission-filtered SQL-ветки group/direct/discussion. PostgreSQL `simple` full-text search и GIN-индексы миграции `20260704_0018` обслуживают смешанный RU/EN body и имена вложений. Результаты сортируются по rank, `created_at`, `id` и продолжаются cursor pagination. Контекст target загружается отдельным endpoint с теми же membership-проверками и существующими message serializers. Поиск не использует Valkey, не создаёт Audit Log events и не журналирует raw `q`.

## Backend

Backend использует FastAPI и конфигурацию из переменных окружения. В первом scaffold доступны:

- `GET /health`
- `GET /api/system/info`
- `GET /api/db-check`
- `GET /api/cache-check`

Структура backend разделена на `core`, `api/routes`, `db` и `services`, чтобы позже добавить auth, users, conversations, messages, files и bots без смешивания слоев.

## Frontend

Frontend использует Next.js, React и TypeScript. Интерфейс сразу подготовлен к RU/EN через JSON-словари. Добавление новых языков должно происходить через расширение списка локалей и добавление нового словаря.

Frontend unit/component test layer построен на Vitest, jsdom и React Testing Library; тесты и общие factories находятся в `apps/frontend/tests`. Browser API изолированы resettable-моками, а неожиданные fetch-запросы запрещены, поэтому этот слой не требует работающего backend или браузерного окна. Он проверяет поведенческие границы session, WebSocket reconnect, unread/read state, search, presence/typing и admin UI, но не заменяет визуальные и сквозные проверки. Полноценный Playwright E2E слой запланирован отдельно.

## Развитие

Следующие архитектурные слои должны добавляться постепенно:

- модели данных и миграции;
- локальная аутентификация;
- роли и администрирование пользователей;
- чаты и сообщения;
- WebSocket gateway;
- файлы и политики хранения;
- боты и интеграции;
- production deployment profile.
# Release Candidate architecture notes

Production uses separate Docker runtime targets and `docker-compose.prod.yml`. Backend migrations are explicit and must be run before starting production services. `/health` is liveness-only; `/ready` checks PostgreSQL, Alembic revision, Valkey and writable uploads storage. Runtime WebSocket delivery is still single-instance; multi-instance production still needs Valkey pub/sub.

## Notification Center

Центр уведомлений хранится отдельно от chat read state и announcement recipient state. `notifications` содержит персональные события с короткими безопасными preview, `notification_preferences` хранит настройки категорий, а `/api/ws/me` синхронизирует create/read/dismiss/preferences между вкладками. Ошибки создания notification не должны блокировать основное действие сообщения, реакции, закрепления или рассылки.
## Calendar Events v0.1

Календарь использует PostgreSQL как источник истины: `calendar_events`, `calendar_event_recipients` и `calendar_reminder_deliveries`. Получатели хранятся снимком, чтобы изменения состава групп не переписывали старую аудиторию без явного обновления события. Напоминания доставляет отдельный `calendar-worker`; Notification Center и `/api/ws/me` остаются пользовательским каналом уведомлений.
