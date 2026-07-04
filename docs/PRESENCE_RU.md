# Presence, Last Seen и Typing Indicators

OfficeChat v0.1 показывает состояния `online`/`offline`, сохраняет время последней активности и передаёт эфемерные индикаторы набора текста в группах, личных чатах и обсуждениях.

## Архитектура presence

Основное эфемерное состояние хранится в Valkey:

- `presence:user:{user_id}:connections` — sorted set уникальных подключений вкладок и устройств с временем истечения;
- `presence:user:{user_id}:status` — последнее вычисленное состояние;
- `presence:user:{user_id}:last_activity` — служебное время последнего heartbeat;
- `typing:{room_type}:{room_id}:user:{user_id}:connections` — краткоживущие подключения, в которых пользователь печатает.

Персональный WebSocket `WS /api/ws/me?token=...` регистрирует уникальный connection ID. Frontend отправляет heartbeat раз в 25 секунд, connection TTL по умолчанию равен 90 секундам. Несколько вкладок и устройств учитываются отдельно: пользователь остаётся online, пока живо хотя бы одно подключение.

После закрытия последнего соединения backend ждёт grace-период 15 секунд. Если пользователь не переподключился, состояние меняется на offline, а `users.last_seen_at` один раз записывается в PostgreSQL. Heartbeat не пишет в PostgreSQL.

## Snapshot и приватность

`GET /api/presence?user_ids=...` принимает не более 100 идентификаторов. Обычный пользователь получает presence только для себя, участников общих групп и обсуждений, а также собеседников существующих личных разговоров. Администраторы могут запрашивать состояние пользователей для административного интерфейса.

Событие персонального канала:

```json
{
  "type": "presence.updated",
  "user_id": "...",
  "status": "offline",
  "last_seen_at": "2026-07-04T12:34:56Z"
}
```

Email, роль и другие данные профиля в presence-событие не включаются.

## Typing indicators

Выбранные комнатные WebSocket-каналы принимают `typing.start` и `typing.stop` и отправляют участникам `typing.updated`. Черновик или его текст не передаётся. Frontend ограничивает частоту start-событий, отправляет stop после 2,5 секунд бездействия, при blur, отправке сообщения, смене чата и unmount. Backend использует TTL 5 секунд и агрегирует состояние по пользователю, поэтому две вкладки не создают двух имён в индикаторе.

Доступ проверяется до подключения к группе, direct conversation или discussion. Presence и typing не создают audit events.

## Degraded mode

При временной недоступности Valkey сообщения и REST API продолжают работать. Presence отображается как offline/unknown, typing молча отключается, а backend пишет ограниченное по частоте предупреждение. Для нескольких backend-инстансов требуется будущий Valkey pub/sub: Valkey уже хранит общее состояние, но доставка WebSocket-событий пока остаётся single-instance.

## Настройки

```env
PRESENCE_CONNECTION_TTL_SECONDS=90
PRESENCE_HEARTBEAT_SECONDS=25
PRESENCE_OFFLINE_GRACE_SECONDS=15
TYPING_TTL_SECONDS=5
```

Значения валидируются при запуске. В будущем планируются away, busy/do-not-disturb, пользовательский статус и настройки приватности presence.
