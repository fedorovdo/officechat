# Messages Foundation OfficeChat

Messages Foundation v0.1 добавляет базовые сообщения внутри групп через REST API. WebSocket Real-time v0.1 добавляет получение онлайн-обновлений для групповых сообщений. File Attachments Foundation v0.1 добавляет локальные вложения для сообщений в группах. Direct Messages Foundation v0.1 добавляет личные сообщения между пользователями без вложений. Реакции и прочтения в этой версии не реализованы.

Sidebar Notifications and Recent Activity v0.1 добавляет во frontend локальные индикаторы непрочитанных сообщений, preview последнего сообщения, короткое время активности и сортировку групп/пользователей по недавней активности. Состояние хранится в `localStorage`; backend read receipts и серверные unread counters пока не реализованы.

Browser Notifications v0.2 добавляет базовые уведомления браузера для новых сообщений, когда вкладка OfficeChat не активна. Это frontend-only механизм: пользователь включает уведомления в настройках app shell, браузер и ОС должны выдать разрешение, а вкладка OfficeChat должна оставаться открытой. В настройках есть кнопка `Тест уведомления` и диагностический блок, который показывает последнюю попытку уведомления, результат и причину пропуска.

Текущие групповые уведомления в app shell используют персональный WebSocket канал `WS /api/ws/me`, который получает событие `user.group.message.created` для релевантных групп. Service worker, server push и уведомления без открытой вкладки запланированы позже.

## Модель сообщения

Сообщение содержит:

- `group_id` - группа, в которой создано сообщение;
- `sender_user_id` - автор сообщения;
- `body` - текст сообщения;
- `message_type` - тип сообщения, по умолчанию `text`;
- `reply_to_message_id` - необязательная ссылка на сообщение, на которое отвечает пользователь;
- `is_deleted` - признак мягкого удаления;
- `edited_at` - дата редактирования;
- `created_at` и `updated_at`.

Удаленные сообщения остаются в базе данных. API возвращает их с `is_deleted=true`, а тело заменяется на `Message deleted`.

## Ответы на сообщения

Reply-to-message v0.1 позволяет отвечать на конкретное сообщение в группе без создания отдельного thread/discussion.

При отправке группового сообщения REST API принимает необязательное поле:

```json
{
  "body": "Согласен, берем этот вариант",
  "message_type": "text",
  "reply_to_message_id": "..."
}
```

Endpoint `POST /api/groups/{group_id}/messages/with-attachment` также принимает `reply_to_message_id` как необязательное поле `multipart/form-data`.

Правила:

- `reply_to_message_id` может быть `null`;
- сообщение, на которое отвечают, должно существовать в той же группе;
- нельзя ответить на сообщение из другой группы;
- отвечать на удаленные сообщения можно, preview покажет удаленное исходное сообщение.

В ответе API сообщение содержит компактный preview:

```json
{
  "reply_to": {
    "id": "...",
    "sender": {
      "id": "...",
      "username": "admin",
      "display_name": "OfficeChat Admin"
    },
    "body_preview": "Короткий фрагмент исходного сообщения",
    "is_deleted": false,
    "created_at": "..."
  }
}
```

Preview ограничен примерно 120 символами. В frontend он отображается как компактная цитата над текстом сообщения.

## Упоминания пользователей

Mentions Foundation v0.1 добавляет базовые упоминания через `@username` в групповых сообщениях.

При создании сообщения backend:

- находит шаблоны вида `@username` в тексте;
- сопоставляет их только с активными пользователями;
- создает mention только для пользователей, которые состоят в той же группе;
- пока игнорирует пользователей с ролью `bot`;
- безопасно игнорирует неизвестные username.

API возвращает mentions вместе с сообщением:

```json
{
  "mentions": [
    {
      "user_id": "...",
      "username": "dmitrii",
      "display_name": "Дмитрий"
    }
  ]
}
```

Frontend подсвечивает распознанные упоминания как обычный plain text без markdown и profile links. В composer показана небольшая подсказка о формате `@username`. Autocomplete пока не реализован. Для личных сообщений mentions в v0.1 не создаются.

## Обсуждения сообщений

Message Threads / Discussions v0.1 добавляет отдельные обсуждения, которые создаются из сообщений группового чата. В app shell у неудаленного сообщения доступна кнопка `Обсудить`. Она создает или открывает правую боковую панель с preview исходного сообщения, участниками и отдельным text-only чатом.

Обсуждения используют собственные REST endpoints и WebSocket канал `WS /api/ws/discussions/{discussion_id}?token=...`. Для одного исходного сообщения создается одно обсуждение. Подробнее: [DISCUSSIONS_RU.md](DISCUSSIONS_RU.md).

## Права доступа

Читать и отправлять сообщения могут:

- `superadmin` и `admin` в любой активной группе;
- участники активной группы с ролями `owner`, `moderator`, `member`;
- пользователи с глобальной ролью `bot`, если они добавлены в группу.

Редактировать сообщение может только его автор. Удалять сообщение может автор, владелец группы, модератор группы, `admin` или `superadmin`.

Неактивные пользователи не получают bearer token и не могут работать с API сообщений. Неактивные группы закрыты для чтения и отправки сообщений.

## Ограничения текста

Пустые сообщения запрещены. Максимальная длина текста задается переменной окружения:

- `MESSAGE_MAX_LENGTH=4000`

Значение по умолчанию - `4000` символов.

## API endpoints

- `GET /api/groups/{group_id}/messages`
- `POST /api/groups/{group_id}/messages`
- `PATCH /api/groups/{group_id}/messages/{message_id}`
- `DELETE /api/groups/{group_id}/messages/{message_id}`
- `POST /api/groups/{group_id}/messages/with-attachment`
- `GET /api/groups/{group_id}/attachments/{attachment_id}/download`
- `WS /api/ws/groups/{group_id}?token=...`
- `WS /api/ws/me?token=...`

`GET /api/groups/{group_id}/messages` поддерживает параметры:

- `limit` - по умолчанию `50`, максимум `100`;
- `before` - UUID сообщения, перед которым нужно загрузить более старые сообщения.

## WebSocket

REST API остается источником истины. Отправка, редактирование и удаление сообщений выполняются через REST, а WebSocket используется только для получения событий:

- `message.created`
- `message.updated`
- `message.deleted`

Для локальной разработки JWT token передается в query-параметре `token`. Текущая реализация работает в рамках одного backend-инстанса. Для production с несколькими инстансами нужен Valkey pub/sub или другой брокер событий.

Персональный канал `WS /api/ws/me` получает `user.group.message.created` для frontend browser notifications и sidebar activity. Редактирование и удаление пока остаются только в group-specific событиях.

Для группового personal event backend также передает `mentioned_user_ids`. Если текущий пользователь упомянут, frontend показывает более заметный sidebar indicator и использует mention-aware текст browser notification.

## Вложения

Сообщение может содержать локальные файловые вложения. Файлы сохраняются в Docker volume backend по пути `UPLOADS_DIR`, по умолчанию `/data/uploads`. Для хранения backend создает безопасное уникальное имя файла и подпапки по группе и дате. Оригинальное имя хранится только как metadata.

Переменные окружения:

- `MAX_UPLOAD_SIZE_MB=25`
- `ALLOWED_UPLOAD_EXTENSIONS=pdf,doc,docx,xls,xlsx,png,jpg,jpeg,txt,zip`

Пустые файлы, файлы больше лимита и файлы с запрещенными расширениями отклоняются.

## Frontend

На странице группы `/{locale}/groups/{groupId}` доступен простой блок сообщений:

- список сообщений;
- автор, username и время создания;
- компактная chat-like раскладка сообщений;
- BOT badge для сообщений от пользователей с ролью `bot`;
- сохранение переносов строк и перенос длинных URL/alert-строк;
- авто-прокрутка к новым сообщениям, если пользователь уже находится внизу;
- кнопка перехода к новым сообщениям, если пользователь читал старые сообщения;
- отправка по `Ctrl+Enter` из composer;
- отправка сообщения;
- ответ на сообщение с компактным preview над composer и в message bubble;
- подсветка распознанных `@username` mentions;
- открытие отдельного обсуждения сообщения через кнопку `Обсудить`;
- ручное обновление списка;
- онлайн-обновления через WebSocket;
- отправка файла с необязательным текстом;
- отображение и скачивание вложений;
- редактирование своих сообщений;
- удаление своих сообщений и модераторское удаление.

## Ограничения v0.1

- WebSocket работает только в single-instance режиме.
- Нет antivirus scanning.
- Нет S3/object storage.
- Нет image preview и thumbnails.
- Нет drag-and-drop.
- Нет file retention cleanup.
- Нет реакций.
- Нет статусов прочтения.
- Нет server push notifications и service worker.
- Нет typing indicators.
- Нет thread/discussion view для ответов.
- Нет autocomplete и profile links для mentions.
- Нет mentions в direct messages.
- Нет вложений, nested threads и отдельного sidebar списка для обсуждений.
- Нет вложений в личных сообщениях.
- Нет поиска по сообщениям.
