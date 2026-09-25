# Production-установка OfficeChat

Эта схема публикует OfficeChat только через Caddy на портах 80/443. Диагностические порты frontend `3100` и backend `8100` привязаны к `127.0.0.1` и недоступны из LAN.

## 1. Выбор режима установки

Для production нужны Linux `amd64`, внутреннее DNS-имя и доступ клиентов к TCP
80/443. Рекомендуемые платформы для полностью автоматической установки:
Rocky Linux 10 и Debian 12.

Во всех примерах используется hostname `officechat.example.local`.

### Рекомендуемая простая установка

Создайте DNS A-запись, указывающую на новый сервер. Затем авторизуйте root Docker
в приватном GHCR, используя token только с `read:packages`:

```bash
sudo -v
read -rp "GitHub user: " GHCR_USER
read -rsp "GHCR token (read:packages): " GHCR_TOKEN
echo
printf '%s' "$GHCR_TOKEN" | sudo docker login ghcr.io \
  --username "$GHCR_USER" \
  --password-stdin
unset GHCR_TOKEN GHCR_USER
```

Если Docker отсутствует, сначала скачайте standalone installer по инструкции
ниже и один раз запустите обычную команду установки. Installer установит Docker
и остановится на проверке доступа к приватным образам GHCR до создания рабочей
установки OfficeChat. Затем выполните Docker login из блока выше и повторите ту
же команду установки.

Скачайте standalone installer и checksum с нужного GitHub Release:

```bash
VERSION=0.1.0-example
TAG="v${VERSION}"
BASE_URL="https://github.com/fedorovdo/officechat/releases/download/${TAG}"

curl --fail --location --show-error \
  --output officechat-install.sh \
  "${BASE_URL}/officechat-install.sh"
curl --fail --location --show-error \
  --output officechat-install.sh.sha256 \
  "${BASE_URL}/officechat-install.sh.sha256"
sha256sum --check officechat-install.sh.sha256
chmod 0755 officechat-install.sh
```

Запустите:

```bash
sudo ./officechat-install.sh \
  --version "$VERSION" \
  --hostname officechat.example.local \
  --admin-username admin \
  --admin-display-name "OfficeChat Admin"
```

Installer безопасно запросит пароль администратора два раза, установит Docker при
необходимости, запустит OfficeChat и Caddy, проверит HTTPS и сохранит публичный CA
в `/opt/officechat/officechat-root.crt`.

Для автоматизации доступны `--no-install-docker`, `--no-start-caddy` и
`--no-create-admin`. Backup timer включается только по явному
`--enable-backup-timer`.

### Установка из release bundle

```bash
sudo ./install-linux.sh \
  --install-docker \
  --hostname officechat.example.local \
  --start-caddy \
  --create-admin \
  --admin-username admin \
  --admin-display-name "OfficeChat Admin"
```

### Установка из source checkout

Следующие команды относятся только к checkout исходного кода:

```bash
cp .env.production.example .env.production
chmod 600 .env.production
```

Задайте в `.env.production`:

```dotenv
OFFICECHAT_HOSTNAME=officechat.example.local
PUBLIC_FRONTEND_URL=https://officechat.example.local
PUBLIC_BACKEND_URL=https://officechat.example.local
BACKEND_CORS_ORIGINS=https://officechat.example.local
BACKEND_BIND_ADDRESS=127.0.0.1
FRONTEND_BIND_ADDRESS=127.0.0.1
```

Для source checkout используется `docker-compose.prod.yml`; release installer
создаёт `/opt/officechat/.env` и устанавливает
`/opt/officechat/docker-compose.yml`.
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

## 3. DNS, Caddy и CA-сертификат

До установки создайте внутреннюю DNS A-запись
`officechat.example.local`, указывающую на адрес сервера.

При standalone-установке с `--hostname` Caddy запускается автоматически. Он
применяет `tls internal`, перенаправляет HTTP на HTTPS и использует Docker network
`officechat_public`.

Публичный CA-сертификат сохраняется здесь:

```text
/opt/officechat/officechat-root.crt
```

Установите только этот публичный сертификат в доверенные корневые центры
сертификации клиентских компьютеров. Private key Caddy CA копировать нельзя.

Если использовался `--no-start-caddy`, Caddy запускается вручную:

```bash
docker compose \
  --env-file /opt/officechat/.env \
  -f /opt/officechat/caddy/docker-compose.caddy.yml \
  up -d
```

Только для source checkout используется путь
`deploy/caddy/docker-compose.caddy.yml` и `.env.production`.

Не удаляйте `request>uri` filters из shipped Caddyfile: они скрывают
чувствительные query-параметры WebSocket.
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
