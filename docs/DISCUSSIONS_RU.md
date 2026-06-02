# Обсуждения сообщений OfficeChat

Message Threads / Discussions v0.1 добавляет отдельные обсуждения, которые создаются из сообщений группового чата. В code и API используется термин `discussion`; в русскоязычном UI используется название `Обсуждение`.

## Основная идея

Пользователь открывает групповой чат, нажимает `Обсудить` у сообщения и получает отдельную боковую панель. В панели доступны:

- preview исходного сообщения;
- список участников;
- добавление участника по username;
- текстовые сообщения обсуждения;
- редактирование и мягкое удаление собственных сообщений;
- WebSocket live updates;
- отправка по `Ctrl+Enter`.

Для одного исходного сообщения создается одно обсуждение. Повторное нажатие `Обсудить` возвращает существующее обсуждение.

## Модели

`Discussion` хранит:

- исходную группу и исходное сообщение;
- необязательный title;
- создателя;
- признак активности;
- даты создания и обновления.

`DiscussionMember` хранит участника обсуждения и роль:

- `owner`;
- `member`.

Создатель обсуждения автоматически добавляется с ролью `owner`. Нельзя удалить последнего owner.

`DiscussionMessage` хранит текстовые сообщения обсуждения. Удаление мягкое: запись остается в базе данных, а UI показывает удаленное сообщение.

## Права доступа

- Создать обсуждение может пользователь, которому доступно исходное сообщение группы.
- Читать и отправлять сообщения обсуждения могут только участники обсуждения.
- Управлять участниками могут discussion owner, владелец исходной группы, `admin` и `superadmin`.
- Добавлять можно только активных non-bot пользователей, которые состоят в исходной группе.
- Редактировать сообщение может только автор.
- Удалить сообщение может автор, discussion owner или глобальный администратор с доступом к исходной группе.

## REST API

```text
POST /api/discussions
GET /api/discussions/{discussion_id}
GET /api/discussions/by-message/{message_id}
POST /api/discussions/{discussion_id}/members
DELETE /api/discussions/{discussion_id}/members/{member_id}
GET /api/discussions/{discussion_id}/messages
POST /api/discussions/{discussion_id}/messages
PATCH /api/discussions/{discussion_id}/messages/{message_id}
DELETE /api/discussions/{discussion_id}/messages/{message_id}
```

Создание или открытие обсуждения:

```json
{
  "source_group_id": "...",
  "source_message_id": "...",
  "title": "Optional title"
}
```

Добавление участника:

```json
{
  "username": "dmitrii",
  "role": "member"
}
```

## WebSocket

Онлайн-обновления обсуждения доступны по endpoint:

```text
WS /api/ws/discussions/{discussion_id}?token=...
```

События:

- `discussion.message.created`;
- `discussion.message.updated`;
- `discussion.message.deleted`;
- `discussion.member.added`;
- `discussion.member.removed`.

Персональный канал `WS /api/ws/me` получает `user.discussion.message.created` для browser notifications участников.

## Ограничения v0.1

- Обсуждения создаются только из групповых сообщений.
- Нет обсуждений для direct messages.
- Нет файловых вложений в обсуждениях.
- Нет отдельного списка обсуждений или sidebar section.
- Нет nested threads.
- Нет read receipts.
- Нет typing indicators.
- WebSocket manager работает в single-instance режиме; для нескольких backend-инстансов позже нужен Valkey pub/sub.
