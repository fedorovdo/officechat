# Обсуждения сообщений OfficeChat

Message Threads / Discussions v0.1 добавляет отдельные обсуждения, которые создаются из сообщений группового чата. В code и API используется термин `discussion`; в русскоязычном UI используется название `Обсуждение`.

## Основная идея

Пользователь открывает групповой чат, нажимает `Обсудить` у сообщения и получает отдельную боковую панель. В панели доступны:

- preview исходного сообщения;
- список участников;
- добавление участника по username;
- сообщения обсуждения с необязательными локальными вложениями;
- редактирование и мягкое удаление собственных сообщений;
- WebSocket live updates;
- отправка по `Enter`, новая строка по `Shift+Enter`; `Ctrl+Enter` сохраняется для обратной совместимости.

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

`DiscussionMessage` хранит сообщения обсуждения. `DiscussionMessageAttachment` хранит metadata локального файла. Удаление сообщения мягкое: запись остается в базе данных, а UI показывает удаленное сообщение.

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
POST /api/discussions/{discussion_id}/messages/with-attachment
GET /api/discussions/{discussion_id}/attachments/{attachment_id}/download
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

Добавление участника поддерживает обычный `username` и mention-style формат `@username`:

```json
{
  "username": "dmitrii",
  "role": "member"
}
```

## WebSocket

Discussion messages поддерживают реакции через `PUT/DELETE /api/discussions/{discussion_id}/messages/{message_id}/reactions` с JSON body `{ "emoji": "👍" }`. Реагировать могут только активные участники обсуждения. Событие `discussion.message.reactions.updated` обновляет reaction chips без полной перезагрузки discussion messages.

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

Созданное сообщение передаёт attachment metadata в REST, discussion WebSocket и персональный WebSocket. Содержимое файла через WebSocket не отправляется. Скачать файл может только участник соответствующего discussion.

Discussion composer поддерживает вставку PNG/JPEG/WebP screenshot через `Ctrl+V`. Изображение получает безопасное имя и thumbnail; при уже выбранном файле оно заменяет единственное вложение v0.1.

Desktop drag-and-drop работает внутри discussion panel и не расширяет её. Drop выбирает первый файл, сохраняет текст composer и заменяет ранее выбранное единственное вложение.

Отправленные PNG/JPEG/WebP загружаются через защищённый discussion endpoint и показываются inline в узкой боковой панели без её расширения. Клик открывает viewport-constrained lightbox; SVG и документы остаются обычными файлами.

## Ограничения v0.1

- Доступен только фиксированный набор `👍 ❤️ 😂 ✅ 🔥 👀 🎉 😮 😢 👎`.
- Нет custom reactions и уведомлений о реакциях.

- Обсуждения создаются только из групповых сообщений.
- Нет обсуждений для direct messages.
- Нет отдельного списка обсуждений или sidebar section.
- Нет nested threads.
- Нет read receipts.
- Нет typing indicators.
- WebSocket manager работает в single-instance режиме; для нескольких backend-инстансов позже нужен Valkey pub/sub.
