# Личные сообщения OfficeChat

Direct Messages Foundation v0.1 добавляет базовые личные сообщения между активными пользователями OfficeChat.

## Основные правила

- Личная переписка доступна только двум участникам разговора.
- `superadmin` и `admin` не получают специального права читать чужие личные сообщения в MVP.
- Неактивные пользователи не могут создавать разговоры и отправлять сообщения.
- Пользователи с ролью `bot` не участвуют в личных сообщениях в этой версии.
- Пустые сообщения запрещены.
- Максимальная длина сообщения использует общий лимит `MESSAGE_MAX_LENGTH`.
- Сообщение может быть ответом на другое сообщение в том же разговоре.
- Автор может редактировать и удалять только свои личные сообщения.
- Удаленные сообщения остаются в базе данных и отображаются как удаленные.

## API

```text
GET /api/direct/conversations
POST /api/direct/conversations
GET /api/direct/conversations/{conversation_id}/messages
POST /api/direct/conversations/{conversation_id}/messages
POST /api/direct/conversations/{conversation_id}/messages/with-attachment
GET /api/direct/conversations/{conversation_id}/attachments/{attachment_id}/download
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
  "body": "Привет",
  "reply_to_message_id": "..."
}
```

`reply_to_message_id` необязателен. Если он указан, исходное сообщение должно существовать в том же direct conversation. Нельзя ответить на сообщение из другого разговора. Отвечать на удаленное сообщение можно; в preview будет показано, что исходное сообщение удалено.

Ответы API содержат компактный preview исходного сообщения:

```json
{
  "reply_to": {
    "id": "...",
    "sender": {
      "id": "...",
      "username": "dmitrii",
      "display_name": "Дмитрий"
    },
    "body_preview": "Короткий фрагмент исходного сообщения",
    "is_deleted": false,
    "created_at": "..."
  }
}
```

Это не thread/discussion view: frontend показывает только одну компактную цитату над сообщением.

## Вложения

Direct composer принимает текст с файлом или только файл. Multipart endpoint поддерживает `file`, необязательный `body` и необязательный `reply_to_message_id`. Скачивание доступно только двум участникам разговора; административная роль не даёт доступа к чужому файлу. WebSocket `direct.message.created` и персональное событие содержат только metadata вложения, без содержимого файла.

Скриншот PNG/JPEG/WebP можно вставить в direct composer через `Ctrl+V`, в том числе вместе с текстом или reply. Показываются thumbnail, безопасное timestamp-имя и размер. В v0.1 доступно одно вложение; pasted image заменяет выбранный файл.

Отправленные PNG/JPEG/WebP отображаются inline и открываются в lightbox. Preview получает Blob через participant-only endpoint с bearer token; Download original использует тот же защищённый доступ. Ошибка preview не мешает читать сообщение или скачать файл.

## WebSocket

Реакции на direct messages используют `PUT/DELETE /api/direct/conversations/{conversation_id}/messages/{message_id}/reactions` с JSON body `{ "emoji": "👍" }`. Событие `direct.message.reactions.updated` обновляет reaction chips и точные счётчики у обоих участников без перезагрузки истории. Администраторы не получают специального доступа к реакциям или сообщениям чужих разговоров.

Онлайн-обновления доступны по endpoint:

```text
WS /api/ws/direct/{conversation_id}?token=...
WS /api/ws/me?token=...
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

В direct chat UI можно нажать `Ответить` у сообщения, увидеть preview над composer, отменить ответ и отправить сообщение с привязкой к исходному. Получатель видит такой же quoted preview через REST/WebSocket payload.

В Sidebar Notifications v0.1 для direct users добавлены локальные индикаторы непрочитанных сообщений, preview последнего сообщения, короткое время активности и сортировка по недавней активности. Состояние хранится в `localStorage` текущего браузера.

Browser Notifications v0.2 показывает уведомления браузера по новым личным сообщениям, если OfficeChat открыт, уведомления включены в настройках, браузер/ОС разрешили уведомления и текущая вкладка не активна. В настройках есть кнопка `Тест уведомления` и диагностика последней попытки: событие, message id, sender/current user, выбранный чат, `Notification.permission`, `localStorage`, `document.visibilityState`, фокус окна, результат и причина пропуска.

Если разговор уже известен frontend, WebSocket `direct.message.*` обновляет открытый чат. Для новых разговоров используется простой refresh списка direct conversations примерно раз в 20 секунд. Полноценные backend read receipts и server-side unread counters запланированы позже.

Начиная с Personal Notification WebSocket v0.1, browser notifications в user app shell используют персональный канал `WS /api/ws/me` и событие `user.direct.message.created`. Это позволяет получить уведомление даже если конкретный direct conversation еще не открыт в UI. Conversation-specific канал `WS /api/ws/direct/{conversation_id}` остается для обновления открытого чата.

## Ограничения v0.1

- Поддерживается только набор `👍 ❤️ 😂 ✅ 🔥 👀 🎉 😮 😢 👎`; custom reactions отсутствуют.
- Уведомления о реакциях не отправляются.

- Нет read receipts.
- Нет server-side unread counters.
- Нет синхронизации unread state между браузерами/устройствами.
- Нет service worker и push-уведомлений без открытой вкладки.
- Нет typing indicators.
- Нет thread/discussion view для ответов.
- Нет direct messages для bot users.
- Нет специального admin-доступа к чужим личным перепискам.
- WebSocket manager пока single-instance; для нескольких backend-инстансов позже нужен Valkey pub/sub или другой broker.
