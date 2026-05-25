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
- Backend docs: http://localhost:8100/docs

## Проверка сервисов

```powershell
docker compose ps
curl http://localhost:8100/health
curl http://localhost:8100/api/system/info
curl http://localhost:8100/api/db-check
curl http://localhost:8100/api/cache-check
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
