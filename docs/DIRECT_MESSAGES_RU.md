# Личные сообщения OfficeChat

Direct Messages Foundation v0.1 добавляет базовые личные сообщения между активными пользователями OfficeChat.

## Основные правила

- Личная переписка доступна только двум участникам разговора.
- `superadmin` и `admin` не получают специального права читать чужие личные сообщения в MVP.
- Неактивные пользователи не могут создавать разговоры и отправлять сообщения.
- Пользователи с ролью `bot` не участвуют в личных сообщениях в этой версии.
- Пустые сообщения запрещены.
- Максимальная длина сообщения использует общий лимит `MESSAGE_MAX_LENGTH`.
- Автор может редактировать и удалять только свои личные сообщения.
- Удаленные сообщения остаются в базе данных и отображаются как удаленные.

## API

```text
GET /api/direct/conversations
POST /api/direct/conversations
GET /api/direct/conversations/{conversation_id}/messages
POST /api/direct/conversations/{conversation_id}/messages
PATCH /api/direct/conversations/{conversation_id}/messages/{message_id}
DELETE /api/direct/conversations/{conversation_id}/messages/{message_id}
```

Создание или открытие разговора:

```json
{
  "username": "dmitrii"
}
```

Отправка сообщения:

```json
{
  "body": "Привет"
}
```

## WebSocket

Онлайн-обновления доступны по endpoint:

```text
WS /api/ws/direct/{conversation_id}?token=...
```

Клиент передает JWT token в query-параметре `token` для локальной разработки. Backend проверяет токен, активность пользователя и участие в разговоре.

События:

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

## Frontend

Личные сообщения доступны в пользовательском app shell:

```text
http://localhost:3100/ru/app
```

В боковой панели раздел Users показывает активных обычных пользователей. При выборе пользователя frontend создает или открывает личный разговор и показывает чат в основной области.

В Sidebar Notifications v0.1 для direct users добавлены локальные индикаторы непрочитанных сообщений, preview последнего сообщения, короткое время активности и сортировка по недавней активности. Состояние хранится в `localStorage` текущего браузера.

Если разговор уже известен frontend, WebSocket `direct.message.*` обновляет preview и unread indicator. Для новых разговоров используется простой refresh списка direct conversations примерно раз в 20 секунд. Полноценные backend read receipts и server-side unread counters запланированы позже.

## Ограничения v0.1

- Нет вложений в личных сообщениях.
- Нет read receipts.
- Нет server-side unread counters.
- Нет синхронизации unread state между браузерами/устройствами.
- Нет typing indicators.
- Нет direct messages для bot users.
- Нет специального admin-доступа к чужим личным перепискам.
- WebSocket manager пока single-instance; для нескольких backend-инстансов позже нужен Valkey pub/sub или другой broker.
