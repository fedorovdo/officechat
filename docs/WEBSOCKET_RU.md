# WebSocket Real-time OfficeChat

## Безопасность сессии WebSocket

Group, direct, discussion и personal sockets используют общий bounded reconnect с задержками примерно 1, 2, 5, 10, 20 и до 30 секунд со случайным jitter. После успешного подключения backoff сбрасывается. Таймеры отменяются при unmount, выходе и глобальном событии истечения аутентификации.

Backend использует close code `4401` для недействительной аутентификации и `4403` для недостатка доступа. `4401` завершает frontend-сессию без последующих reconnect; `4403` показывает отказ в доступе, но не удаляет JWT.

Query-аутентификация остаётся временной архитектурой v0.1. Значения параметров `token`, `access_token`, `authorization` и `ticket` заменяются на `[REDACTED]` в Uvicorn logs. Для multi-instance deployment по-прежнему требуется Valkey pub/sub.

WebSocket Real-time v0.1 добавляет базовые онлайн-обновления для сообщений в группах. REST API остается источником истины: отправка, редактирование и удаление сообщений по-прежнему выполняются через REST endpoints, а WebSocket используется только для получения событий.

## Endpoint

```text
WS /api/ws/groups/{group_id}?token=...
WS /api/ws/direct/{conversation_id}?token=...
WS /api/ws/discussions/{discussion_id}?token=...
WS /api/ws/me?token=...
```

`/api/ws/me` также принимает heartbeat и доставляет `presence.updated`. Комнатные каналы принимают `typing.start`/`typing.stop` и отправляют авторизованным участникам `typing.updated`. Черновики и их текст через WebSocket не передаются. Подробности TTL, grace-периода и privacy rules описаны в [PRESENCE_RU.md](PRESENCE_RU.md).

Персональный канал доставляет `unread.updated` и `unread.refresh` для синхронизации вкладок и устройств. Direct room channel дополнительно доставляет participant-only `direct.read`. Отдельные unread WebSocket не создаются. Подробности описаны в [UNREAD_RU.md](UNREAD_RU.md).

Для локальной разработки клиент передает JWT bearer token в query-параметре `token`. Это удобно для MVP и отладки, но для production-сценариев нужно перейти на более строгую схему с secure cookies, короткими session-токенами или другим защищенным механизмом.

## Проверки доступа

При подключении backend проверяет:

- токен валиден;
- пользователь существует и активен;
- группа существует и активна;
- `superadmin` или `admin` может подключиться к любой активной группе;
- обычный пользователь, владелец, модератор или bot может подключиться только к группе, где он состоит участником.

Если проверка не проходит, WebSocket закрывается с policy violation.

## События

При изменении сообщений через REST API backend отправляет события участникам группы или direct conversation:

```json
{
  "type": "message.created",
  "group_id": "...",
  "message": {}
}
```

```json
{
  "type": "message.updated",
  "group_id": "...",
  "message": {}
}
```

```json
{
  "type": "message.deleted",
  "group_id": "...",
  "message_id": "...",
  "message": {}
}
```

Для message lifecycle событий frontend может обновить список из REST API, который остаётся источником истины. Реакции обновляются точечно без полной перезагрузки:

```json
{
  "type": "message.reactions.updated",
  "group_id": "...",
  "message_id": "...",
  "reactions": [
    {
      "emoji": "👍",
      "count": 2,
      "reacted_by_me": false,
      "users": []
    }
  ]
}
```

Direct message events:

```json
{
  "type": "direct.message.created",
  "conversation_id": "...",
  "message": {}
}
```

```json
{
  "type": "direct.message.updated",
  "conversation_id": "...",
  "message": {}
}
```

```json
{
  "type": "direct.message.deleted",
  "conversation_id": "...",
  "message_id": "...",
  "message": {}
}
```

Для direct reactions используется событие `direct.message.reactions.updated` с `conversation_id`, `message_id` и массивом `reactions`.

Если message создан с файлами, `message.attachments` содержит все вложения в upload order: filename, content type, size, created time и защищённый download URL. Содержимое файлов через WebSocket не передаётся.

Discussion events:

```json
{
  "type": "discussion.message.created",
  "discussion_id": "...",
  "message": {}
}
```

Также используются `discussion.message.updated`, `discussion.message.deleted`, `discussion.message.reactions.updated`, `discussion.member.added` и `discussion.member.removed`. Reaction events не отправляются в персональный `/api/ws/me` и не создают browser notifications.

`discussion.message.created` также включает массив attachment metadata. Персональные group/direct/discussion events переиспользуют тот же payload; для attachment-only сообщения preview показывает filename либо количество файлов.

Pinned message events отправляются в выбранный комнатный канал group, direct или discussion:

```json
{
  "type": "message.pinned",
  "chat_type": "group",
  "chat_id": "...",
  "message_id": "...",
  "pin_id": "...",
  "pin": {}
}
```

Также используются `message.pin_updated` и `message.unpinned`. REST остаётся источником истины: frontend после события обновляет список сообщений и `GET /api/pins`. Персональный `/api/ws/me` в v0.1 не рассылает отдельные pin events.

Personal notification events:

```json
{
  "type": "user.group.message.created",
  "group_id": "...",
  "group": {
    "id": "...",
    "name": "...",
    "slug": "..."
  },
  "mentioned_user_ids": ["..."],
  "message": {}
}
```

```json
{
  "type": "user.direct.message.created",
  "conversation_id": "...",
  "other_user": {},
  "message": {}
}
```

```json
{
  "type": "user.discussion.message.created",
  "discussion_id": "...",
  "discussion": {
    "id": "...",
    "title": "...",
    "source_group_id": "..."
  },
  "message": {}
}
```

Broadcast announcement events use the same personal channel and are separate from chat unread events:

```json
{
  "type": "announcement.created",
  "announcement": {
    "id": "...",
    "title": "...",
    "priority": "important",
    "sent_at": "...",
    "sender_user_id": "...",
    "sender_display_name": "..."
  },
  "unread_count": 1
}
```

```json
{
  "type": "announcement.read",
  "announcement_id": "...",
  "unread_count": 0
}
```

`announcement.retracted` uses the same compact shape as `announcement.read`.

Канал `WS /api/ws/me` подключается один раз для текущего пользователя и получает события по группам и личным разговорам, которые относятся к этому пользователю. Frontend browser notifications используют именно этот канал, чтобы уведомления не зависели от выбранного чата.

Сообщения discussion также отправляются через персональный канал участникам обсуждения. Это позволяет показать browser notification, даже если боковая панель discussion закрыта.

Для групповых сообщений payload `message` содержит массив `mentions`, а personal event содержит `mentioned_user_ids`. Это позволяет frontend показать более заметный sidebar indicator и mention-aware browser notification для упомянутого пользователя без отдельного WebSocket канала.

## Ограничение single-instance

Текущий connection manager хранит активные WebSocket-подключения в памяти одного backend-процесса. Это подходит для локальной разработки и одного экземпляра backend.

Для production с несколькими backend-инстансами нужно добавить Valkey pub/sub или другой брокер событий, чтобы событие из одного инстанса доставлялось клиентам, подключенным к другим инстансам.

## Ограничения v0.1

- Нет read receipts.
- Нет reactions.
- Нет mention autocomplete и profile links.
- Нет multi-instance pub/sub.
