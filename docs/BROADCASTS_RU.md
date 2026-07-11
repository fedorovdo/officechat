# Broadcast Announcements v0.1

## Назначение

Broadcast Announcements — отдельный механизм корпоративных объявлений. Он не создаёт по одному direct message на каждого получателя: текст объявления хранится один раз, а таблица получателей хранит статус доставки, прочтения и скрытия.

## Доступ

Создавать, просматривать preview, отправлять, смотреть свою историю и отзывать рассылки может только пользователь с эффективным правом `can_broadcast`. Роли `admin`, `moderator` или владелец группы сами по себе не дают это право. Bot, disabled и service users не могут быть отправителями.

Обычный пользователь может видеть только объявления, адресованные ему:

- `GET /api/announcements`
- `GET /api/announcements/unread`
- `GET /api/announcements/{announcement_id}`
- `POST /api/announcements/{announcement_id}/read`
- `POST /api/announcements/{announcement_id}/dismiss`

Открытие объявления помечает его прочитанным.

## Отправка

Sender flow:

1. Подготовить заголовок, текст, приоритет и аудиторию.
2. Выполнить `POST /api/broadcasts/preview`.
3. Проверить точное число получателей и confirmation token.
4. Выполнить `POST /api/broadcasts`.
5. Выполнить `POST /api/broadcasts/{broadcast_id}/send` с `expected_recipient_count`, `confirmation_token` и `idempotency_key`.

Для срочной рассылки всем активным пользователям UI требует дополнительное подтверждение словом `РАЗОСЛАТЬ`.

## Аудитория

Поддерживаются аудитории:

- `all_active_users`
- `selected_groups`
- `selected_users`

Из получателей исключаются отключённые пользователи, bot users и service/system users. Для `selected_users` невалидные пользователи отклоняются как ошибка, чтобы отправитель не думал, что они получили объявление.

## WebSocket

Используется существующий персональный канал:

```text
WS /api/ws/me?token=...
```

События:

- `announcement.created`
- `announcement.read`
- `announcement.retracted`

Это отдельный unread counter для объявлений; он не смешивается с unread counters чатов.

## Безопасность и аудит

Audit Log записывает только безопасные metadata: тип аудитории, приоритет, количество получателей и технические счётчики. Заголовок, тело объявления, usernames получателей, confirmation token и idempotency key не пишутся в audit details.

Rate limiting выполняется через Valkey. Текущие переменные:

- `BROADCAST_TITLE_MAX_LENGTH=160`
- `BROADCAST_BODY_MAX_LENGTH=10000`
- `BROADCAST_MAX_RECIPIENTS=10000`
- `BROADCAST_MAX_PER_HOUR=10`
- `BROADCAST_PREVIEW_TTL_SECONDS=300`
- `BROADCAST_RETENTION_DAYS=365`

## Ограничения v0.1

- Нет scheduled announcements.
- Нет rich text/markdown rendering.
- Нет обязательного подтверждения прочтения.
- Нет вложений в объявлениях.
- WebSocket delivery single-instance; для production multi-instance нужен Valkey pub/sub.
