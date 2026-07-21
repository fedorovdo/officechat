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
- Перед обновлением создавайте backup PostgreSQL, uploads и Caddy CA.

См. [internal-https.md](internal-https.md), [windows-certificate-installation.md](windows-certificate-installation.md) и [caddy-ca-backup-restore.md](caddy-ca-backup-restore.md).
