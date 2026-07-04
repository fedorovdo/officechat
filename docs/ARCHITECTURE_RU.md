# Архитектура OfficeChat

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

## Backend

Backend использует FastAPI и конфигурацию из переменных окружения. В первом scaffold доступны:

- `GET /health`
- `GET /api/system/info`
- `GET /api/db-check`
- `GET /api/cache-check`

Структура backend разделена на `core`, `api/routes`, `db` и `services`, чтобы позже добавить auth, users, conversations, messages, files и bots без смешивания слоев.

## Frontend

Frontend использует Next.js, React и TypeScript. Интерфейс сразу подготовлен к RU/EN через JSON-словари. Добавление новых языков должно происходить через расширение списка локалей и добавление нового словаря.

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
