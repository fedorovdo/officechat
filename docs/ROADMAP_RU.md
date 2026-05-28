# Roadmap OfficeChat

## Этап 0: Scaffold

- Monorepo структура.
- Docker Compose.
- FastAPI backend.
- Next.js frontend.
- PostgreSQL и Valkey.
- Базовая документация.

## Этап 1: Основа продукта

- Пользователи, роли и локальная аутентификация.
- Административное создание пользователей.
- Простые личные и групповые чаты.
- REST API для базовых сущностей.
- Миграции базы данных.
- User app shell: отдельный пользовательский интерфейс `/ru/app` рядом с admin routes `/ru/admin/*`.
- Локальные настройки интерфейса: язык, сторона sidebar, размер шрифта, accent color.
- Базовые direct messages между пользователями: REST API, WebSocket updates, UI в `/ru/app`.
- Локальные sidebar notifications: unread indicators, last message previews, recent activity ordering через frontend `localStorage`.
- Базовые browser notifications во frontend: разрешение браузера, тестовая кнопка, диагностика, setup guide, настройка в `localStorage`, уведомления при неактивной вкладке.
- Персональный WebSocket канал `WS /api/ws/me` для событий новых групповых и личных сообщений текущего пользователя.

## Этап 2: Realtime

- WebSocket messaging.
- Presence через Valkey.
- Доставка и статусы сообщений.
- Backend read receipts и server-side unread counters.
- Базовые уведомления в интерфейсе.
- Service worker и server push notifications для уведомлений без открытой вкладки.
- Стандартная поддержка emoji в сообщениях чата.
- Вложения в direct messages.
- Read receipts и typing indicators для групп и direct messages.

## Этап 3: Файлы и администрирование

- Загрузка файлов в локальный volume.
- Ограничения размера и типа файлов.
- Административные настройки.
- Audit log для важных действий.

## Этап 3.5: UX профилей

- Страница профиля пользователя.
- Backend user_preferences для сохранения пользовательских настроек интерфейса.
- Загрузка аватара или фотографии профиля.
- Отображение аватаров в сообщениях.
- Отображение аватаров в списках пользователей и участников групп.

## Этап 4: Боты и интеграции

- Bot API foundation.
- Системные webhooks.
- Локальные AI-провайдеры, включая Ollama.
- OpenAI-compatible провайдеры с явным включением администратором.

## Этап 5: Production hardening

- nginx reverse proxy.
- TLS.
- Безопасные cookie и headers.
- Backup/restore documentation.
- LDAP/AD provider.
