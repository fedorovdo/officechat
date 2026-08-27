# Production-установка OfficeChat

Эта схема публикует OfficeChat только через Caddy на портах 80/443. Диагностические порты frontend `3100` и backend `8100` привязаны к `127.0.0.1` и недоступны из LAN.

## 1. Выбор режима установки

Требуются Linux amd64, Docker Engine, Docker Compose v2 и DNS-имя. Во всех примерах используется placeholder `officechat.example.local`.

### Установка из release bundle

Распакуйте release bundle, перейдите в его каталог `release/` и запустите installer
с production hostname:

```bash
sudo ./install-linux.sh --hostname officechat.example.local
```

Installer создаёт приватный `/opt/officechat/.env` с правами `0600`, записывает
production public origin для указанного hostname, устанавливает Compose и Caddy
файлы в `/opt/officechat` и запускает основной application stack. Не копируйте
`.env.production.example`: этого source-tree файла в установленном release layout
нет.

Installer не запускает Caddy автоматически, поэтому offline-установка основного
приложения не зависит от загрузки proxy image. Backup timer также не включается
автоматически. После проверки `/etc/officechat/backup.conf` включите его вручную
либо передайте installer `--enable-backup-timer`.

### Установка из source checkout

Следующие команды относятся только к checkout исходного кода:

```bash
cp .env.production.example .env.production
chmod 600 .env.production
```

Замените все secret placeholders и задайте:

```dotenv
OFFICECHAT_HOSTNAME=officechat.example.local
PUBLIC_FRONTEND_URL=https://officechat.example.local
PUBLIC_BACKEND_URL=https://officechat.example.local
BACKEND_CORS_ORIGINS=https://officechat.example.local
BACKEND_BIND_ADDRESS=127.0.0.1
FRONTEND_BIND_ADDRESS=127.0.0.1
```

Файл `.env.production` нельзя добавлять в Git. Для source checkout используется
`docker-compose.prod.yml`; release installer вместо этого создаёт
`/opt/officechat/.env` и устанавливает `/opt/officechat/docker-compose.yml`.

## 2. Запуск OfficeChat

Из source checkout:

```bash
docker compose --env-file .env.production -f docker-compose.prod.yml config
docker compose --env-file .env.production -f docker-compose.prod.yml run --rm backend alembic upgrade head
docker compose --env-file .env.production -f docker-compose.prod.yml up -d
```

Для release bundle основной stack уже запущен installer. Проверяйте и управляйте
им через `/opt/officechat/officechatctl`, не смешивая installed и source Compose
paths.

## Слои Compose и обновления

Release-команды используют base Compose, затем существующий HTTPS override и
последним автоматически управляемый `docker-compose.version-override.yml`.
Финальный слой содержит только публичные release metadata и точные images; secrets
остаются в `.env`. Проверить используемые файлы и resolved stack можно командой:

```bash
sudo /opt/officechat/officechatctl integrity-check
```

Для обновления распакуйте новый bundle и запустите находящийся в нём
`sudo ./officechatctl update VERSION`. Не редактируйте legacy HTTPS override и не
выполняйте эксплуатационные команды с одним `-f docker-compose.yml`.

## 3. DNS и Caddy

Создайте внутреннюю DNS A-запись `officechat.example.local`, указывающую на адрес сервера. После запуска основного Compose сеть `officechat_public` уже существует.

После установки из release bundle:

```bash
docker compose --env-file /opt/officechat/.env \
  -f /opt/officechat/caddy/docker-compose.caddy.yml config
docker compose --env-file /opt/officechat/.env \
  -f /opt/officechat/caddy/docker-compose.caddy.yml up -d
```

Только для source checkout:

```bash
docker compose --env-file .env.production \
  -f deploy/caddy/docker-compose.caddy.yml config
docker compose --env-file .env.production \
  -f deploy/caddy/docker-compose.caddy.yml up -d
```

Caddy использует `tls internal`, перенаправляет HTTP на HTTPS и обращается к `frontend:3000`/`backend:8000` через Docker network.

Не удаляйте `request>uri` filters из shipped Caddyfile: WebSocket JWT передаётся
как `token` query parameter, а Caddy access и runtime/error logs не используют
backend sanitizer. Для собственного reverse proxy настройте эквивалентную
redaction query и path credentials во всех логгерах.

## 4. Проверка

Публичные health endpoints через Caddy:

- `/ready` — внешняя проверка готовности всей системы;
- `/api/health` — health endpoint frontend;
- `/health` — базовая проверка backend.

На сервере:

```bash
curl --fail http://127.0.0.1:8100/ready
curl -I http://officechat.example.local
ss -ltn | grep -E '127\.0\.0\.1:(3100|8100)'
```

Первый HTTP-запрос должен получить redirect на HTTPS. В выводе `ss` порты 3100/8100 не должны слушать `0.0.0.0` или LAN-адрес.

После установки внутреннего CA на тестовом клиенте:

```bash
curl --fail https://officechat.example.local/ready
```

С клиентского ПК также проверьте TCP 443, вход, group/direct/discussion сообщения, WebSocket live updates, загрузку/скачивание вложений, браузерные уведомления и календарь. Установку PWA выполняйте только после доверия сертификату и успешного открытия HTTPS origin.

## 5. Эксплуатационные ограничения

- Никогда не выполняйте `docker compose down -v` для Caddy: volume содержит private CA.
- Не публикуйте 3100/8100 на LAN; они предназначены только для локальной диагностики.
- Frontend использует browser same-origin для API и WebSocket и не требует пересборки при смене hostname.
- Release installer устанавливает backup/verify/restore-скрипты, создаёт
  `/etc/officechat/backup.conf` только при первом запуске и включает
  `officechat-backup.timer` только по явному `--enable-backup-timer`. При
  обновлении существующий `backup.conf` не
  перезаписывается, поэтому добавленные в новых версиях параметры получают
  безопасные значения по умолчанию из общей библиотеки.
- Стандартный backup перед обновлением запускается с `--pre-upgrade`: такой
  набор защищён от автоматической ротации и включает текущие frontend/backend
  images.

После установки проверьте [Центр резервного копирования](../BACKUP_CENTER_RU.md),
затем настройте и испытайте полный операторский процесс по документу
[«Резервное копирование, проверка и восстановление»](../BACKUP_RESTORE_RU.md).
Также см. [internal-https.md](internal-https.md),
[windows-certificate-installation.md](windows-certificate-installation.md) и
[caddy-ca-backup-restore.md](caddy-ca-backup-restore.md).
