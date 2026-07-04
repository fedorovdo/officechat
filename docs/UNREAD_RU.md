# Unread Counters и Read Receipts

OfficeChat v0.1 хранит состояние чтения как high-water mark: одна строка `chat_read_states` на сочетание пользователь + тип чата + чат. Строки на каждое сообщение или получателя сообщения не создаются.

## Порядок сообщений

Read marker содержит `last_read_message_created_at` и `last_read_message_id`. Сравнение всегда выполняется по паре `(created_at, id)`, поэтому одинаковые timestamps имеют стабильный UUID tie-breaker. Редактирование не меняет `created_at` и не делает сообщение непрочитанным повторно.

Удалённые и архивные сообщения не входят в unread count. Удаление только физического файла вложения не меняет состояние сообщения. Retention cleanup отправляет `unread.refresh`, после чего клиенты повторно загружают authoritative summary.

## Совместимость существующей истории

Миграция `20260704_0017` создаёт read state для существующих участников групп, direct conversations и discussions с маркером на последнем сообщении на момент deployment. Поэтому старая история не превращается в непрочитанную. Для memberships, созданных или восстановленных позже, используется lazy initialization до последнего существующего сообщения; первое последующее сообщение становится unread.

## API

```text
GET  /api/unread
POST /api/read-state
GET  /api/read-state/direct/{conversation_id}/receipt
```

`GET /api/unread` возвращает общий, категорийный и per-chat count, first/newest unread IDs и mention count. Запрос использует bounded набор grouped queries по трём типам чатов, а не отдельный count на строку sidebar.

`POST /api/read-state` проверяет доступ и принадлежность сообщения чату, не двигает marker назад и является idempotent. Обычные действия чтения не записываются в Audit Log.

Mention count строится только по структурированным `MessageMention` для групповых сообщений. Текст сообщения повторно не парсится; mentions в direct/discussion остаются будущим расширением.

## Видимость и несколько устройств

Frontend отправляет mark-read только когда чат выбран, сообщения успешно загружены, panel присутствует в layout и `document.visibilityState === "visible"`. Используется debounce 500 мс. Скрытая вкладка сохраняет unread state; при возврате видимый чат отмечается прочитанным до newest loaded message.

События `unread.updated` идут через существующий `WS /api/ws/me`, поэтому чтение в одной вкладке или на другом устройстве обновляет все активные сессии. После reconnect frontend всегда повторно загружает `GET /api/unread`. Дополнительные WebSocket на элементы sidebar не создаются.

## Direct read receipts

Direct conversation room получает participant-only событие `direct.read`. UI показывает `Отправлено` или `Прочитано` только у последнего исходящего сообщения. Администратор не получает read state чужой личной переписки по роли; endpoint доступен только участникам conversation. Group/discussion read receipts в v0.1 не предоставляются.

## Ограничения

- Нет group/discussion read receipts и списка прочитавших.
- Нет отдельной истории read events.
- Межинстансная доставка WebSocket по-прежнему требует будущий Valkey pub/sub.
- Frontend unit-test runner пока отсутствует; поведение frontend проверяется TypeScript/Next build и ручными browser checks.
- Загрузка исторического контекста через Message Search не двигает high-water marker. Автоматический mark-read временно отключается до возврата пользователя к последним сообщениям, поэтому переход к старому результату не очищает новые unread counters.
