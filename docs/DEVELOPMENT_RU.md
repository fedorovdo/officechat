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

## Auth

Саморегистрация отключена. Первый локальный superadmin создается при старте backend, если в базе еще нет пользователей.

Переменные окружения:

- `APP_SECRET_KEY`
- `ACCESS_TOKEN_EXPIRE_MINUTES`
- `BOOTSTRAP_SUPERADMIN_USERNAME`
- `BOOTSTRAP_SUPERADMIN_PASSWORD`
- `BOOTSTRAP_SUPERADMIN_DISPLAY_NAME`

Локальная учетная запись из `.env.example`:

- username: `admin`
- password: `admin12345`

Страница входа: http://localhost:3100/ru/login

Страница управления пользователями: http://localhost:3100/ru/admin/users

Доступ к управлению пользователями есть только у ролей `superadmin` и `admin`.

На странице управления можно создавать пользователей, менять отображаемое имя, email, роль, активность и сбрасывать пароль локальным пользователям. Роль `superadmin` может редактировать только другой `superadmin`.

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
