# Боты и AI в OfficeChat

OfficeChat имеет базовую основу для ботов: администратор создает бота, backend создает связанного пользователя с ролью `bot`, а внешняя система отправляет сообщения через incoming webhook.

## Bot foundation v0.1

Бот состоит из двух сущностей:

- запись `bots` с настройками, token hash и status;
- связанный пользователь `users` с ролью `bot`, `auth_provider="bot"` и `password_hash=null`.

Токен генерируется при создании бота и показывается только один раз. В базе хранится только `token_hash` и короткий `token_preview`. При перевыпуске токена старый токен перестает работать.

Страница управления ботами:

```text
http://localhost:3100/ru/admin/bots
```

Доступ есть только у `superadmin` и `admin`.

## Incoming webhook

Endpoint:

```text
POST /api/bots/incoming/{token}
```

Простой payload:

```json
{
  "group_id": "...",
  "body": "Backup finished",
  "message_type": "text"
}
```

Friendly payload:

```json
{
  "group_slug": "alerts",
  "title": "Backup failed",
  "severity": "high",
  "status": "problem",
  "body": "Check server backup-01"
}
```

OfficeChat также принимает monitoring-friendly поля для систем вроде Zabbix:

- `title`
- `severity`
- `status`
- `host`
- `ip`
- `problem`
- `trigger`
- `event_id`
- `url`
- `timestamp`

Если переданы эти поля, OfficeChat формирует читаемый plain text. Markdown-рендеринг пока не используется.

Пример результата:

```text
🚨 [HIGH] PROBLEM
Title: Backup failed

Check server backup-01
```

Иконка выбирается по `status` или `severity`:

- `disaster` - 🔥
- `high` - 🚨
- `average` / `warning` - ⚠️
- `information` - ℹ️
- `resolved` / `recovery` / `ok` - ✅
- другое значение - 🤖

Если переданы и `group_id`, и `group_slug`, используется `group_id`.

## Пример payload для Zabbix

Готовый JSON для alert-сценария:

```json
{
  "group_slug": "alerts",
  "severity": "high",
  "status": "problem",
  "title": "Disk space low",
  "host": "DC5",
  "ip": "192.168.1.100",
  "problem": "Free space on C: is less than 10%",
  "trigger": "Free disk space is low",
  "event_id": "12345",
  "url": "http://zabbix.local/tr_events.php?triggerid=12345",
  "timestamp": "2026-05-27 12:00:00",
  "body": "Check the server before the next backup window."
}
```

Он будет превращен в сообщение примерно такого вида:

```text
🚨 [HIGH] PROBLEM
Title: Disk space low
Host: DC5
IP: 192.168.1.100
Problem: Free space on C: is less than 10%
Trigger: Free disk space is low
Event ID: 12345
URL: http://zabbix.local/tr_events.php?triggerid=12345
Timestamp: 2026-05-27 12:00:00

Check the server before the next backup window.
```

## Как добавить бота в группу

После создания бота скопируйте username связанного bot user на странице управления ботами. На странице группы добавьте этого пользователя как обычного участника по username. Бот сможет отправлять webhook-сообщения только в группы, где он состоит участником.

Пример curl:

```powershell
curl.exe -X POST http://localhost:8100/api/bots/incoming/PASTE_TOKEN_HERE -H "Content-Type: application/json" -d "{\"group_slug\":\"alerts\",\"severity\":\"high\",\"status\":\"problem\",\"title\":\"Disk space low\",\"host\":\"DC5\",\"ip\":\"192.168.1.100\",\"problem\":\"Free space on C: is less than 10%\",\"event_id\":\"12345\",\"url\":\"http://zabbix.local/tr_events.php?triggerid=12345\",\"body\":\"Check the server before the next backup window.\"}"
```

После успешной отправки сообщение создается от имени bot user и рассылается в группу через текущий WebSocket `message.created`.

## AI providers

AI-поддержка должна учитывать два класса провайдеров:

- локальные LLM-провайдеры, например Ollama;
- платные OpenAI-compatible провайдеры.

По умолчанию AI-интеграции должны быть выключены. Администратор должен явно включать provider, задавать endpoint, ключи доступа и политики использования.

## Принципы

- Не отправлять корпоративные данные внешним провайдерам без явного включения.
- Поддерживать offline-friendly сценарии через локальные модели.
- Изолировать credentials в переменных окружения или secrets.
- Логировать системные действия ботов.
- Позволять отключать ботов на уровне deployment или workspace.

## Ограничения v0.1

- Нет outgoing webhooks.
- Нет AI provider.
- Нет file attachments from bot.
- Нет per-bot scoped permissions beyond group membership.
- Нет direct messages.
