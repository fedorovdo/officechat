# Архитектура OfficeChat

OfficeChat строится как monorepo с отдельными приложениями backend и frontend.

## Компоненты

- `apps/backend` - FastAPI API-сервис.
- `apps/frontend` - Next.js интерфейс.
- `postgres` - основная реляционная база данных.
- `valkey` - cache, presence и будущая очередь фоновых задач.
- `uploads` - Docker volume для локального хранения файлов MVP.
- `deploy/nginx` - место для будущей reverse proxy конфигурации.

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
