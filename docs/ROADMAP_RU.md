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
- Reply-to-message для групповых и личных сообщений: компактная цитата исходного сообщения без thread/discussion view.
- Базовые `@username` mentions в групповых сообщениях: определение активных участников группы, подсветка и mention-aware browser notifications.
- Базовые message discussions из групповых сообщений: правая боковая панель, участники, text-only сообщения и WebSocket updates.
- Messenger UI v0.1: полноэкранная трехрегионная раскладка, resizable/collapsible sidebar, вкладки чатов, компактные сообщения и закрепленный composer.
- Emoji Picker v0.1: стандартные Unicode emoji в групповых, личных и discussion composer, RU/EN поиск и локальный список часто используемых emoji.

## Этап 2: Realtime

- WebSocket messaging.
- Presence через Valkey.
- Доставка и статусы сообщений.
- Backend read receipts и server-side unread counters.
- Базовые уведомления в интерфейсе.
- Service worker и server push notifications для уведомлений без открытой вкладки.
- Реакции, custom emoji, стикеры и GIF.
- Расширение discussions: отдельный sidebar список, вложения, direct-message discussions и более развитое представление цепочек.
- Autocomplete и profile links для mentions, поддержка mentions в direct messages.
- Вложения в direct messages.
- Read receipts и typing indicators для групп и direct messages.

## Этап 3: Файлы и администрирование

- Загрузка файлов в локальный volume.
- Ограничения размера и типа файлов.
- Административные настройки.
- Audit log для важных действий.

## Этап 3.5: UX профилей

- Базовая панель профиля пользователя с просмотром аккаунта и изменением отображаемого имени реализована.
- Расширенная страница профиля пользователя.
- Backend user_preferences для сохранения пользовательских настроек интерфейса.
- Локальная загрузка, замена и удаление аватара пользователя реализованы.
- Отображение аватаров с initials fallback в messenger messages, headers и списках реализовано.
- Cropping, image editing и расширенное управление фотографией профиля запланированы позже.

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
