# Уведомления OfficeChat

## Как это работает сейчас

OfficeChat получает события через backend Notification Center и персональный WebSocket, а системное уведомление показывает frontend открытого приложения. Окно OfficeChat может быть свёрнуто, скрыто другой программой или находиться без фокуса, но приложение должно оставаться запущенным.

Для доставки событий в открытый app shell используется персональный WebSocket канал:

```text
WS /api/ws/me?token=...
```

Канал получает события `user.group.message.created`, `user.direct.message.created` и `user.discussion.message.created`. Frontend обновляет sidebar и authoritative unread state и вызывает Notifications API, только если окно скрыто или не имеет фокуса и сообщение отправлено другим пользователем. Повторные события подавляются по message id и notification tag.

В установленном Chromium PWA общий серверный счётчик непрочитанных сообщений передаётся в `navigator.setAppBadge()`. При нуле и logout badge очищается через `navigator.clearAppBadge()`. В браузерах без Badging API эта возможность просто пропускается.

## Настройка в OfficeChat

1. Откройте `/ru/app`.
2. Откройте `Настройки`.
3. Включите `Показывать уведомления о новых сообщениях`.
4. Нажмите `Разрешить уведомления Windows`.
5. Нажмите `Тест уведомления`.
6. Если уведомление не появилось, смотрите диагностический блок в настройках.

## Chrome и Edge

1. Нажмите значок слева от адреса сайта.
2. Откройте настройки сайта.
3. Разрешите уведомления для OfficeChat.
4. Также можно проверить: `Настройки -> Конфиденциальность и безопасность -> Настройки сайтов -> Уведомления`.

## Firefox

1. Нажмите значок слева от адреса сайта.
2. Разрешите уведомления для OfficeChat.
3. Если уведомления ранее были заблокированы, откройте настройки разрешений сайта и измените правило вручную.

## Windows

1. Откройте `Параметры -> Система -> Уведомления`.
2. Включите уведомления.
3. Убедитесь, что режим `Не беспокоить` выключен.
4. Убедитесь, что уведомления для Chrome, Edge или Firefox разрешены.
5. Проверьте, что помощник фокусировки или корпоративная политика не блокирует уведомления.

## Linux desktop

1. Проверьте системные настройки уведомлений рабочего окружения.
2. Для GNOME, KDE и Xfce путь может отличаться.
3. Убедитесь, что уведомления браузера разрешены.
4. Убедитесь, что режим `Не беспокоить` выключен.
5. Проверьте, что notification daemon запущен в текущей сессии.

## Диагностика

В настройках OfficeChat показываются:

- `Notification.permission`;
- значение `officechat.notifications.enabled` в `localStorage`;
- `document.visibilityState`;
- фокус окна;
- статус `WS /api/ws/me`;
- последняя попытка уведомления;
- результат последней попытки;
- причина пропуска.

Если `Тест уведомления` работает, но сообщения не вызывают уведомления, проверьте статус `WS /api/ws/me` и последнюю причину пропуска. Частые причины: сообщение отправлено текущим пользователем, вкладка активна, уведомления выключены в `localStorage`, разрешение браузера не `granted`.

## Ограничения

- Уведомления работают, пока OfficeChat открыт как вкладка или запущенное PWA, включая свёрнутое и неактивное окно.
- Service Worker сейчас отсутствует; используется Notifications API открытого окна.
- При полностью закрытом приложении события не доставляются: для этого необходим следующий этап Web Push/VAPID и Service Worker.
- Нет email и mobile push.
- Badging API доступен преимущественно в Chromium и определяется через feature detection.
- WebSocket manager пока single-instance; для нескольких backend-инстансов позже нужен Valkey pub/sub или другой broker.

## План

Следующий отдельный этап: Service Worker с обработчиком `push`/`notificationclick`, VAPID subscription API, хранение endpoint-ов на backend и доставка при полностью закрытом приложении. Multi-instance события должны проходить через Valkey pub/sub.

## Центр уведомлений v0.1

В `/ru/app` добавлен отдельный центр уведомлений с кнопкой-колокольчиком. Его unread count не объединяется со счётчиками чатов и не заменяет счётчик объявлений.

Категории: `mention`, `reply`, `reaction`, `direct_message`, `group_message`, `discussion_message`, `announcement`, `pin`, `system`. Обычные сообщения групп и уведомления о закреплениях выключены по умолчанию, чтобы центр не становился шумным.

Миграция `20260704_0022` создаёт таблицы `notifications` и `notification_preferences`. Основной API: `GET /api/notifications`, `GET /api/notifications/unread-count`, `POST /api/notifications/{notification_id}/read`, `POST /api/notifications/read-all`, `POST /api/notifications/{notification_id}/dismiss`, `GET /api/notifications/preferences`, `PUT /api/notifications/preferences`.

Новые события существующего персонального канала `/api/ws/me`: `notification.created`, `notification.read`, `notifications.read_all`, `notification.dismissed`, `notification.preferences_updated`.

Просмотренное message уведомление синхронизируется с chat read-state по существующим `chat_type`, `chat_id` и `message_id`. Операция `/api/read-state` помечает одним batch все message notifications до фактически просмотренного сообщения и отправляет `notifications.messages_read`. Calendar, announcement, system и moderation notifications этим действием не затрагиваются.

В настройках уведомлений также есть подтверждаемая операция `Исправить старые непрочитанные`. Она предназначена только для счётчиков, оставшихся от старых версий: backend продвигает high-water markers текущего пользователя до сообщений, существующих на момент операции, и помечает прочитанными только доступные ему записи `category="messages"`. Уведомления календаря, объявлений, системные, moderation и прочие немесседжевые записи визуально и в PostgreSQL сохраняют своё состояние. Новые сообщения после выбранной границы остаются unread.

Authoritative ответ обновляет sidebar и Notification Center без оптимистической очистки. Более новое WebSocket-состояние имеет приоритет над запоздавшим HTTP-ответом; остальные вкладки получают `unread.refresh` через `/api/ws/me`. Повторный запуск безопасен и показывает ноль изменений.

Уведомления хранят только короткий безопасный preview и metadata без токенов, паролей, путей файловой системы, полного тела приватных сообщений и содержимого вложений. Дедупликация выполняется через `dedupe_key`.

Настройки окружения: `NOTIFICATION_RETENTION_DAYS=90`, `NOTIFICATION_MAX_PER_USER=5000`.
## Calendar Events v0.1

Центр уведомлений получил категорию `calendar` и настройки `calendar_events_enabled`, `calendar_reminders_enabled`, `calendar_changes_enabled`. События календаря, изменения и напоминания приходят через существующий `/api/ws/me`, но не смешиваются со счётчиками непрочитанных чатов.
