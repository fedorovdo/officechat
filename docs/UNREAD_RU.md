# Unread Counters и Read Receipts

OfficeChat v0.1 хранит состояние чтения как high-water mark: одна строка `chat_read_states` на сочетание пользователь + тип чата + чат. Строки на каждое сообщение или получателя сообщения не создаются.

## Порядок сообщений

Read marker содержит `last_read_message_created_at` и `last_read_message_id`. Сравнение всегда выполняется по паре `(created_at, id)`, поэтому одинаковые timestamps имеют стабильный UUID tie-breaker. Редактирование не меняет `created_at` и не делает сообщение непрочитанным повторно.

Удалённые и архивные сообщения не входят в unread count. Закрепление и открепление сообщения не меняет high-water marker и не создаёт новое unread-сообщение; если закреплённое сообщение удаляется или архивируется, его pin снимается отдельно от read state. Удаление только физического файла вложения не меняет состояние сообщения. Retention cleanup отправляет `unread.refresh`, после чего клиенты повторно загружают authoritative summary.

## Совместимость существующей истории

Миграция `20260704_0017` создаёт read state для существующих участников групп, direct conversations и discussions с маркером на последнем сообщении на момент deployment. Поэтому старая история не превращается в непрочитанную. Для memberships, созданных или восстановленных позже, используется lazy initialization до последнего существующего сообщения; первое последующее сообщение становится unread.

## API

```text
GET  /api/unread
POST /api/read-state
POST /api/read-state/mark-all-current-read
GET  /api/read-state/direct/{conversation_id}/receipt
```

`GET /api/unread` возвращает общий, категорийный и per-chat count, first/newest unread IDs и mention count. Запрос использует bounded набор grouped queries по трём типам чатов, а не отдельный count на строку sidebar.

`POST /api/read-state` проверяет доступ и принадлежность сообщения чату, не двигает marker назад и является idempotent. Обычные действия чтения не записываются в Audit Log.

Mention count строится только по структурированным `MessageMention` для групповых сообщений. Текст сообщения повторно не парсится; mentions в direct/discussion остаются будущим расширением.

## Исправление исторических счётчиков

В настройках уведомлений доступно явное действие `Исправить старые непрочитанные`. Оно предназначено только для исторически зависших счётчиков, созданных старыми версиями OfficeChat, и не требуется для обычной ежедневной работы. Перед запуском пользователь подтверждает операцию.

`POST /api/read-state/mark-all-current-read` не принимает `user_id` и работает только для текущего активного пользователя. В одной транзакции backend:

- заново определяет доступные пользователю активные группы, direct conversations и discussions;
- выбирает последнее существующее сообщение каждого доступного чата по канонической паре `(created_at, id)`;
- двигает high-water marker только вперёд;
- помечает прочитанными только связанные записи Notification Center с `category="messages"`;
- оставляет calendar, announcement, system, moderation и другие немесседжевые уведомления без изменений.

Ответ содержит authoritative total, отдельные group/direct/discussion counts, Notification Center unread count и число обработанных сообщений/чатов. После commit персональный `WS /api/ws/me` получает `unread.refresh` и, при необходимости, `notifications.messages_read`, поэтому открытые вкладки и PWA повторно загружают серверное состояние. App Badge следует общему authoritative total и очищается при нуле.

Граница операции задаётся конкретными последними message IDs и timestamps, выбранными внутри транзакции. Сообщение, появившееся после этой границы, остаётся непрочитанным. Повторный запуск идемпотентен и возвращает ноль обработанных сообщений, если новых зависших счётчиков нет. Автоматически при обновлении OfficeChat эта операция не запускается.

## Видимость и несколько устройств

Frontend отправляет mark-read только для непрерывного префикса входящих unread-сообщений, начиная с `first_unread_message_id`. Каждое сообщение в префиксе должно быть минимум на 60% видно внутри реального scroll container не менее 500 мс, а окно всё это время должно иметь `visibilityState === "visible"` и `document.hasFocus() === true`. Если первая unread-запись не загружена из-за pagination, marker не двигается. Blur, скрытие окна, быстрый scroll, смена чата и unmount отменяют таймеры.

События `unread.updated` идут через существующий `WS /api/ws/me`, поэтому чтение в одной вкладке или на другом устройстве обновляет все активные сессии. После reconnect frontend всегда повторно загружает `GET /api/unread`. Дополнительные WebSocket на элементы sidebar не создаются.

## Direct read receipts

Direct conversation room получает participant-only событие `direct.read`. UI показывает `Отправлено` или `Прочитано` только у последнего исходящего сообщения. Администратор не получает read state чужой личной переписки по роли; endpoint доступен только участникам conversation. Group/discussion read receipts в v0.1 не предоставляются.

## Ограничения

- Нет group/discussion read receipts и списка прочитавших.
- Нет отдельной истории read events.
- Межинстансная доставка WebSocket по-прежнему требует будущий Valkey pub/sub.
- Обычное сообщение считается видимым при 60% собственной площади. Для сообщения выше области прокрутки используется безопасный fallback: оно должно занимать не менее 60% видимой высоты области непрерывно 500 мс.
- Загрузка исторического контекста через Message Search не двигает high-water marker. Автоматический mark-read временно отключается до возврата пользователя к последним сообщениям, поэтому переход к старому результату не очищает новые unread counters.

## Центр уведомлений

Chat unread counters, direct read receipts, announcement unread и notification-center unread остаются отдельными хранилищами. Продвижение chat marker batch-операцией помечает прочитанными только связанные `category="messages"` notifications до подтверждённого сообщения; calendar, announcement, system и moderation записи не затрагиваются. Событие `notifications.messages_read` синхронизирует колокольчик в открытых вкладках.
