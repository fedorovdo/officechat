# Roadmap OfficeChat

## Audit Log v0.1

- Добавлены централизованные admin/security events, фильтры, детали и CSV export.
- Audit events отделены от chat retention и пока не удаляются автоматически.
- В будущем: подтверждаемая audit retention cleanup, trusted proxy configuration, внешний SIEM/syslog export и tamper-evident signing.

## Session hardening

- Реализована централизованная обработка `401`, локализованный возврат к login, остановка polling/WebSocket и безопасный локальный logout.
- Реализованы bounded WebSocket reconnect, close codes `4401`/`4403` и маскирование query-токенов в backend logs.
- На будущий production-этап остаются HttpOnly cookie sessions, CSRF-защита, ротация refresh tokens и отказ от WebSocket query token.

Retention and Storage Management v0.1 реализует disabled-by-default archive, attachment cleanup, mandatory dry-run, admin storage UI и audit. Для v0.2 запланированы отдельный worker, Valkey distributed lock и permanent deletion только после cascade audit.

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
- Message Reactions v0.1: фиксированный набор Unicode reactions, точные счётчики и real-time синхронизация для group/direct/discussion сообщений.
- Локальные защищённые вложения для group, direct и discussion сообщений с едиными лимитами и WebSocket metadata.
- Clipboard Image Paste v0.1: вставка PNG/JPEG/WebP скриншотов через `Ctrl+V` во всех трёх composer-ах с thumbnail и безопасным именем.
- Inline Image Previews v0.1: authenticated Blob preview PNG/JPEG/WebP и lightbox для group/direct/discussion messages.
- Drag-and-Drop Attachments v0.1: multi-file drop overlay в group/direct/discussion chats, включая text/config files.
- Multiple Attachments v0.1: до 10 файлов, общий лимит, атомарное сохранение и image gallery/lightbox.

## Этап 2: Realtime

- WebSocket messaging.
- Presence через Valkey, multi-tab heartbeat и persistent last seen реализованы в v0.1.
- Typing indicators для групп, direct messages и discussions реализованы в v0.1.
- Доставка и статусы сообщений.
- Server-side unread counters, multi-tab read-state sync и direct read receipts реализованы в v0.1.
- Базовые уведомления в интерфейсе.
- Service worker и server push notifications для уведомлений без открытой вкладки.
- Custom reactions, стикеры и GIF.
- Расширение discussions: отдельный sidebar список, direct-message discussions и более развитое представление цепочек.
- Autocomplete и profile links для mentions, поддержка mentions в direct messages.
- Away, do not disturb, пользовательский статус и настройки приватности presence.
- Group/discussion read receipts и список прочитавших.

## Message Search

- PostgreSQL Message Search v0.1 реализован: mixed-language `simple` indexes, глобальный/current-chat поиск, фильтры, cursor pagination, context и deep links.
- Следующие этапы: advanced syntax и exact phrases, saved searches и search history, optional OpenSearch, OCR/document-content search и административный eDiscovery с отдельными разрешениями.

## Branding and About

- Логотип и favicon.
- Страница или диалог About.
- Версия приложения и build information.
- Автор или организация.
- Ссылки на документацию и репозиторий.
- Информация о лицензии.

## Этап 3: Файлы и администрирование

- Загрузка файлов в локальный volume.
- Ограничения размера и типа файлов.
- Resumable uploads, antivirus scanning и backend thumbnails/compression.
- Backend thumbnails, image compression и previews PDF/documents.
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
