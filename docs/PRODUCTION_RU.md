# Production deployment

## Branding and public metadata

Для production можно задать `OFFICECHAT_VERSION`, `OFFICECHAT_BUILD_SHA`, `OFFICECHAT_BUILD_DATE` и публичные `NEXT_PUBLIC_OFFICECHAT_*` переменные из `.env.production.example`. Эти значения отображаются на `/ru/about`, `/en/about`, frontend `/api/health` и backend `/health`. Не передавайте через них секреты или внутренние deployment details. По умолчанию frontend metadata использует `noindex,nofollow`; для публичной demo-инсталляции это нужно менять осознанно.

OfficeChat v0.1 RC has a separate production Compose file:

```bash
docker compose -f docker-compose.prod.yml config
docker compose -f docker-compose.prod.yml run --rm backend alembic upgrade head
docker compose -f docker-compose.prod.yml up -d
```

## Обязательные настройки

- `ENVIRONMENT=production`
- `DATABASE_URL`
- `APP_SECRET_KEY` или `JWT_SECRET`: постоянный секрет длиной не меньше 32 символов
- `PUBLIC_FRONTEND_URL`
- `PUBLIC_BACKEND_URL`
- `BACKEND_CORS_ORIGINS`

Приложение не должно запускаться в production с `change-me-in-production`, wildcard CORS или отсутствующим `DATABASE_URL`.

## Docker

- backend использует runtime target без `--reload` и без pytest;
- frontend использует `next build` и standalone runtime;
- PostgreSQL и Valkey не публикуют порты наружу;
- uploads хранятся в named volume;
- миграции выполняются отдельной командой перед стартом.

## Reverse proxy

Пока OfficeChat не доверяет forwarded headers автоматически. `X-Forwarded-For`, `X-Forwarded-Proto` и `X-Forwarded-Host` должны считаться доверенными только после явного включения trusted proxy режима в будущей настройке reverse proxy.

## Health checks

- `GET /health`: liveness, без проверки зависимостей.
- `GET /ready`: PostgreSQL, Alembic revision, Valkey, writable uploads.

`/ready` не раскрывает credentials или абсолютные пути.

## Security headers

Backend и frontend выставляют базовые security headers. HSTS включается backend только при HTTPS-запросе. Для локального HTTP режима HSTS не используется.
## Calendar Worker

Calendar Events v0.1 использует отдельный сервис `calendar-worker`, который доставляет наступившие напоминания из таблицы `calendar_reminder_deliveries`. В production сначала выполните миграции, затем запускайте стек:

```bash
docker compose -f docker-compose.prod.yml run --rm backend alembic upgrade head
docker compose -f docker-compose.prod.yml up -d
```

Для multi-instance fanout живых WebSocket-событий из worker позже нужен Valkey pub/sub или другой брокер.
