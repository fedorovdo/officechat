# WebSocket Real-time OfficeChat

WebSocket Real-time v0.1 добавляет базовые онлайн-обновления для сообщений в группах. REST API остается источником истины: отправка, редактирование и удаление сообщений по-прежнему выполняются через REST endpoints, а WebSocket используется только для получения событий.

## Endpoint

```text
WS /api/ws/groups/{group_id}?token=...
WS /api/ws/direct/{conversation_id}?token=...
```

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

Frontend v0.1 после получения события просто перезагружает список сообщений. Это проще и надежнее для первого этапа, потому что REST API остается единым источником данных.

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

## Ограничение single-instance

Текущий connection manager хранит активные WebSocket-подключения в памяти одного backend-процесса. Это подходит для локальной разработки и одного экземпляра backend.

Для production с несколькими backend-инстансами нужно добавить Valkey pub/sub или другой брокер событий, чтобы событие из одного инстанса доставлялось клиентам, подключенным к другим инстансам.

## Ограничения v0.1

- Нет typing indicators.
- Нет read receipts.
- Нет direct message attachments.
- Нет file attachments.
- Нет reactions.
- Нет multi-instance pub/sub.
