# Production-установка OfficeChat

Эта схема публикует OfficeChat только через Caddy на портах 80/443. Диагностические порты frontend `3100` и backend `8100` привязаны к `127.0.0.1` и недоступны из LAN.

## 1. Подготовка

Требуются Linux amd64, Docker Engine, Docker Compose v2 и DNS-имя. Во всех примерах используется placeholder `officechat.example.local`.

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

Файл `.env.production` нельзя добавлять в Git. Для release bundle используйте его `docker-compose.yml`; для установки из исходников используется `docker-compose.prod.yml`.

## 2. Запуск OfficeChat

Из исходников:

```bash
docker compose --env-file .env.production -f docker-compose.prod.yml config
docker compose --env-file .env.production -f docker-compose.prod.yml run --rm backend alembic upgrade head
docker compose --env-file .env.production -f docker-compose.prod.yml up -d
```

Release installer поддерживает hostname при новой установке:

```bash
sudo ./install-linux.sh --hostname officechat.example.local
```

Installer не запускает Caddy автоматически, поэтому offline-установка основного приложения не зависит от загрузки proxy image.
Backup timer также не включается автоматически. После проверки
`/etc/officechat/backup.conf` включите его вручную либо передайте installer
`--enable-backup-timer`.

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

```bash
docker compose --env-file .env.production -f deploy/caddy/docker-compose.caddy.yml config
docker compose --env-file .env.production -f deploy/caddy/docker-compose.caddy.yml up -d
```

Caddy использует `tls internal`, перенаправляет HTTP на HTTPS и обращается к `frontend:3000`/`backend:8000` через Docker network.

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
