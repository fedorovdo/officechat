# Установка release-версии OfficeChat на Linux

Для production-установки с внутренним HTTPS используйте [deployment/production-installation.md](deployment/production-installation.md). Windows trust для `tls internal` описан в [deployment/windows-certificate-installation.md](deployment/windows-certificate-installation.md).

OfficeChat распространяется как versioned Docker Compose bundle для `linux/amd64`.
Публикация образов, Git tag и GitHub Release выполняются вручную после проверки.

## 1. Что входит в bundle

```text
release/
  docker-compose.yml
  .env.example
  install-linux.sh
  update-linux.sh
  rollback-linux.sh
  uninstall-linux.sh
  verify-install.sh
  officechatctl
  VERSION
  RELEASE.json
  CHECKSUMS.sha256
  README_INSTALL_RU.md
  caddy/
    Caddyfile.example
    docker-compose.caddy.yml
  deployment/
```

Архив: `officechat-<VERSION>-linux-amd64.tar.gz`.

## 2. Образы

- `ghcr.io/fedorovdo/officechat-backend:<VERSION>`
- `ghcr.io/fedorovdo/officechat-frontend:<VERSION>`
- дополнительный immutable tag: `sha-<short_git_sha>`
- опциональный moving tag: `rc`

Не используйте `latest` для production.

Production release images являются приватными packages в GHCR. Для их загрузки
нужна предварительная Docker authentication от GitHub account с доступом к этим
packages. Token/PAT должен иметь только необходимый scope `read:packages`.

## 3. Каталоги

- `/opt/officechat` - compose, `.env`, `VERSION`, служебные скрипты.
- `/var/lib/officechat` - PostgreSQL, Valkey, uploads.
- `/var/backups/officechat` - резервные копии.

## 4. Требования

- Сервер `linux/amd64`.
- Для автоматической установки Docker: Rocky Linux 10 или Debian 12.
- Доступ `root` либо `sudo`.
- Утилиты `curl`, `tar`, `sha256sum` и `mktemp`.
- Внутреннее DNS-имя, указывающее на IP-адрес сервера.
- Доступ клиентов к портам TCP 80 и 443.
- GitHub account с правом чтения приватных OfficeChat packages в GHCR.

Standalone installer автоматически устанавливает официальный Docker Engine и
Compose v2 на Rocky Linux 10 и Debian 12. Если Docker уже установлен, он
используется без переустановки. На другой Linux-платформе Docker Engine и Compose
v2 необходимо установить вручную и запускать bootstrap с
`--no-install-docker`.
## 5. Простая установка на новый сервер

### 5.1. Подготовьте DNS

Создайте внутреннюю DNS A-запись, например:

```text
officechat.example.local -> 192.168.1.50
```

Замените имя и адрес на свои значения. Клиентские компьютеры должны разрешать это
имя в IP-адрес нового сервера.

### 5.2. Авторизуйте Docker в GHCR

Release images являются приватными packages. Авторизацию нужно выполнить в том же
root-контексте, в котором будет работать installer:

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

Token/PAT должен иметь только необходимый scope `read:packages`. Не передавайте
его аргументом команды и не сохраняйте в OfficeChat `.env`.

Если сервер полностью чистый и Docker отсутствует, сначала скачайте standalone
installer по следующему разделу и запустите обычную команду установки. Installer
установит Docker, а затем остановится на проверке доступа к приватным образам
GHCR. После этого выполните Docker login из блока выше и повторите ту же команду
установки. До успешной проверки GHCR рабочая установка OfficeChat не создаётся.

### 5.3. Скачайте и проверьте standalone installer

На странице нужного GitHub Release возьмите точное значение `VERSION`:

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

Проверка должна вывести `officechat-install.sh: OK`.

### 5.4. Запустите установку

```bash
sudo ./officechat-install.sh \
  --version "$VERSION" \
  --hostname officechat.example.local \
  --admin-username admin \
  --admin-display-name "OfficeChat Admin"
```

Во время установки пароль первого администратора будет скрыто запрошен дважды.
Standalone installer:

1. скачивает versioned release bundle;
2. проверяет внешний и внутренний SHA-256;
3. проверяет безопасность файлов архива;
4. устанавливает Docker Engine и Compose v2, если они отсутствуют;
5. создаёт `/opt/officechat/.env` с правами `0600`;
6. запускает основной application stack;
7. выполняет миграции базы данных;
8. создаёт первого superadmin;
9. автоматически запускает Caddy;
10. проверяет HTTPS `/ready`;
11. сохраняет публичный CA в `/opt/officechat/officechat-root.crt`.

Backup timer по умолчанию выключен. После проверки
`/etc/officechat/backup.conf` его можно включить отдельно либо передать
`--enable-backup-timer`.

Дополнительные параметры:

```text
--no-install-docker    не устанавливать Docker автоматически
--no-start-caddy       не запускать bundled Caddy
--no-create-admin      не создавать первого администратора
--enable-backup-timer  включить планировщик backup
--dry-run              проверить план без изменения сервера
```

### 5.5. Установка из распакованного bundle

```bash
VERSION=0.1.0-example
tar -xzf "officechat-${VERSION}-linux-amd64.tar.gz"
cd release

sudo ./install-linux.sh \
  --install-docker \
  --hostname officechat.example.local \
  --start-caddy \
  --create-admin \
  --admin-username admin \
  --admin-display-name "OfficeChat Admin"
```

Низкоуровневый installer требует явных флагов `--install-docker`,
`--start-caddy` и `--create-admin`; standalone bootstrap включает безопасные
значения по умолчанию.
## 6. Первый администратор

Production backend больше не создаёт пользователя с известным стандартным
паролем. Первый superadmin создаётся только установщиком либо явной CLI-командой.

При обычном запуске `officechat-install.sh`:

- username по умолчанию: `admin`;
- display name: `OfficeChat Admin`;
- пароль дважды запрашивается через `/dev/tty` без отображения;
- минимальная длина пароля — 8 символов;
- пароль не передаётся через аргументы, environment или временный файл;
- backend получает пароль только через stdin;
- повторный запуск не меняет пароль существующего пользователя.

Для автоматизированной установки создание администратора отключается параметром
`--no-create-admin`. После этого администратора необходимо создать отдельной
защищённой CLI-командой.
## 7. Проверка

```bash
/opt/officechat/verify-install.sh
/opt/officechat/officechatctl status
/opt/officechat/officechatctl health
```

Проверки не печатают секреты.

## 8. Обновление

```bash
tar -xzf officechat-VERSION-linux-amd64.tar.gz
cd release
sudo ./officechatctl update VERSION
```

Запускайте updater из распакованного bundle целевой версии: его `RELEASE.json`
содержит доверенные version, commit SHA, UTC build date и точные image names.
По умолчанию перед обновлением создается backup. `--no-backup` разрешен, но
выводит предупреждение. Downgrade запрещен без `--allow-downgrade`.

Updater использует Compose-файлы строго в таком порядке:

1. `/opt/officechat/docker-compose.yml`;
2. существующий `docker-compose.https-override.yml`;
3. автоматически созданный `docker-compose.version-override.yml`.

Последний файл закрепляет backend, calendar-worker и frontend на точной версии
release и не позволяет legacy HTTPS override вернуть старые images. Пользовательский
HTTPS override не редактируется. Не запускайте ручные `docker compose` команды с
неполным набором `-f`; используйте `officechatctl`.

## 9. Откат

Image rollback:

```bash
sudo /opt/officechat/rollback-linux.sh PREVIOUS_VERSION
```

Он не откатывает базу данных. Полное восстановление требует backup и точного подтверждения:

```text
RESTORE OFFICECHAT
```

## 10. Удаление

```bash
sudo /opt/officechat/uninstall-linux.sh
```

По умолчанию удаляются только контейнеры. Данные, backup и `.env` сохраняются. Полная очистка данных требует `--purge-data` и подтверждения:

```text
DELETE OFFICECHAT DATA
```

Backups не удаляются автоматически.

## 11. Backup

`officechatctl backup` создает PostgreSQL dump, архив uploads и metadata в `/var/backups/officechat`.
PostgreSQL и uploads нужно хранить вместе, иначе вложения и сообщения могут разойтись.

## 12. Reverse proxy и внутренний HTTPS

Standalone installer автоматически запускает bundled Caddy, если передан
`--hostname`. Он использует `tls internal`, перенаправляет HTTP на HTTPS и
экспортирует публичный CA-сертификат:

```text
/opt/officechat/officechat-root.crt
```

Этот сертификат необходимо установить в доверенные корневые центры сертификации
клиентских компьютеров. Для Windows используйте документ
`deployment/windows-certificate-installation.md`.

Если установка выполнялась с `--no-start-caddy`, Caddy запускается вручную:

```bash
docker compose \
  --env-file /opt/officechat/.env \
  -f /opt/officechat/caddy/docker-compose.caddy.yml \
  up -d
```

Только в source checkout соответствующий путь:
`deploy/caddy/docker-compose.caddy.yml`; для него используется
`.env.production`.
## 13. Firewall

PostgreSQL и Valkey не публикуются наружу. Обычно наружу открыт только 80/443 reverse proxy. Без reverse proxy frontend слушает `${FRONTEND_HOST_PORT:-3100}`, backend по умолчанию привязан к `127.0.0.1:${BACKEND_HOST_PORT:-8100}`.

## 14. SELinux

Release Compose задаёт `:Z` для PostgreSQL/Valkey и shared `:z` для uploads и
read-only runtime socket backup agent. Не используйте `label=disable`, privileged,
`chmod 777` и не отключайте SELinux. Проверка на RED OS/RHEL-like хосте в режиме
Enforcing описана в `deployment/production-update_RU.md`.

## 15. Offline groundwork

Для offline-инсталляций подготовлены `export-images.sh` и `import-images.sh`. Они сохраняют и загружают Docker images, но не заменяют проверку checksum и внутреннюю процедуру доставки.

## 16. Диагностика

```bash
/opt/officechat/collect-diagnostics.sh
```

Диагностика собирает состояние Compose, версии, Alembic revision, sanitized logs, OS/Docker info и свободное место. Она не выгружает `.env`, сообщения, базу данных или вложения.

## 17. Git tag release

После финальной проверки вручную:

```bash
VERSION=0.1.0-example
git tag -a "v${VERSION}" -m "OfficeChat ${VERSION}"
git push origin "v${VERSION}"
```

Tag должен указывать на точный проверенный commit; release tooling получает эту
же version явно и не использует старую release-версию как fallback.

## 18. Ограничения текущей архитектуры

- WebSocket fanout пока single-instance; для multi-instance нужен Valkey pub/sub.
- Browser notifications требуют открытую вкладку.
- Нет LDAP/AD, S3, antivirus scanning, recurring calendar, RSVP, email/mobile push.
- Возможны warning-и passlib/bcrypt в dev logs; они не должны блокировать работу.

## 19. Проверка bundle

```bash
bash -n scripts/release/*.sh
bash -n scripts/release/officechatctl
OFFICECHAT_VERSION=0.1.0-example docker compose -f deploy/docker-compose.release.yml config
OFFICECHAT_RELEASE_VERSION=0.1.0-example bash scripts/release/create-release-bundle.sh --dry-run
```
