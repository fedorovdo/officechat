# Calendar Events v0.1

OfficeChat Calendar добавляет корпоративный календарь для встреч, событий на весь день, обучения, обслуживания и видеоконференций.

## Доступ

- Просмотр события доступен только получателям из снимка аудитории, создателю события и superadmin.
- Создание, изменение, перенос и отмена требуют права `can_manage_calendar`.
- `superadmin` получает это право неявно через систему разрешений.
- `admin`, `moderator`, `group_owner` и обычные пользователи не получают право автоматически.
- Только `superadmin` может назначать и отзывать `can_manage_calendar` в управлении пользователями.
- Ботам специальные права календаря не назначаются.

## Аудитория

Поддерживаются аудитории:

- `all_active_users` - все активные пользователи, кроме ботов и системных записей.
- `selected_groups` - активные участники выбранных групп, с удалением дублей.
- `selected_users` - выбранные активные пользователи.

OfficeChat сохраняет снимок получателей в `calendar_event_recipients`. Если состав группы меняется позже, старое событие остаётся доступным исходным получателям. При изменении аудитории события снимок пересчитывается: удалённые получатели теряют будущий доступ, новые получают доступ после обновления.

## Время

- События с временем хранят `starts_at` и `ends_at` в UTC.
- Исходный IANA timezone сохраняется в поле `timezone`, например `Europe/Moscow`.
- События на весь день используют календарные даты `all_day_start_date` и `all_day_end_date`, а не полночь UTC.
- Конец события не может быть раньше начала.
- Ссылки конференций принимаются только с `http` или `https`.

## Напоминания

В v0.1 поддержаны напоминания:

- в момент начала;
- за 15 минут;
- за 30 минут;
- за 1 час;
- за 1 день.

Напоминания сохраняются в `calendar_reminder_deliveries`. Отдельный сервис `calendar-worker` периодически выбирает наступившие строки, создаёт запись Notification Center и помечает доставку. База данных остаётся источником истины, поэтому перезапуск backend/worker не должен создавать дубликаты.

## WebSocket и уведомления

Используется существующий персональный канал:

- `WS /api/ws/me?token=...`

События:

- `calendar.event_created`
- `calendar.event_updated`
- `calendar.event_cancelled`
- `calendar.reminder`

Notification Center получил категорию `calendar` и настройки:

- `calendar_events_enabled`
- `calendar_reminders_enabled`
- `calendar_changes_enabled`

Счётчики календаря не смешиваются с непрочитанными чатами.

## API

- `GET /api/calendar/events`
- `GET /api/calendar/events/{event_id}`
- `POST /api/calendar/events`
- `PATCH /api/calendar/events/{event_id}`
- `POST /api/calendar/events/{event_id}/cancel`
- `POST /api/calendar/events/{event_id}/restore`
- `GET /api/calendar/manage/events`
- `POST /api/calendar/events/preview-audience`

## UI

В `/ru/app` добавлен раздел `Календарь` с представлениями:

- День
- Неделя
- Месяц
- Список

Пользователи видят доступные им события и подробности. Пользователи с `can_manage_calendar` видят форму создания/редактирования, предпросмотр аудитории, перенос и отмену.

## Ограничения v0.1

- Повторяющиеся события не реализованы.
- RSVP/ответы участников не реализованы.
- Google Calendar, Outlook, CalDAV и ICS-подписки не реализованы.
- Фоновая push-доставка без открытого браузера не реализована.
- Для live-доставки из отдельного worker в multi-instance production нужен Valkey pub/sub или другой брокер.
