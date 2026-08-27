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

## 3. Каталоги

- `/opt/officechat` - compose, `.env`, `VERSION`, служебные скрипты.
- `/var/lib/officechat` - PostgreSQL, Valkey, uploads.
- `/var/backups/officechat` - резервные копии.

## 4. Требования

- Linux `amd64`.
- Docker Engine и Docker Compose v2.
- `tar`, `sha256sum`, `openssl` желательно для генерации секретов.
- Свободные порты для frontend/backend или reverse proxy.

Скрипты не устанавливают Docker молча. Флаг `--install-docker` зарезервирован и завершится с понятной ошибкой, если Docker отсутствует.

## 5. Установка

```bash
VERSION=0.1.0-example
tar -xzf "officechat-${VERSION}-linux-amd64.tar.gz"
cd release
sudo ./install-linux.sh --hostname chat.example.com
```

Скрипт создаёт `/opt/officechat/.env` с правами `0600`, записывает public origin
для hostname, генерирует секреты, если файла ещё нет, выполняет
`alembic upgrade head`, запускает сервисы и проверяет `/ready`. Не создавайте
`.env.production`: это имя используется только при установке из source checkout.

## 6. Первый администратор

Для безопасного создания администратора используйте CLI внутри backend container:

```bash
printf '%s' 'strong-password-here' | docker compose --env-file /opt/officechat/.env -f /opt/officechat/docker-compose.yml run --rm backend \
  python -m app.cli create-admin --username admin --display-name "OfficeChat Admin" --password-stdin
```

Команда идемпотентна: если пользователь уже существует, пароль не перезаписывается.

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

## 12. Reverse proxy

После release-установки Caddy files находятся здесь:

- `/opt/officechat/caddy/Caddyfile.example`
- `/opt/officechat/caddy/docker-compose.caddy.yml`

Запуск установленного Caddy stack:

```bash
docker compose --env-file /opt/officechat/.env \
  -f /opt/officechat/caddy/docker-compose.caddy.yml config
docker compose --env-file /opt/officechat/.env \
  -f /opt/officechat/caddy/docker-compose.caddy.yml up -d
```

Только в source checkout соответствующие примеры находятся в
`deploy/nginx/officechat.conf`, `deploy/caddy/Caddyfile.example` и
`deploy/caddy/docker-compose.caddy.yml`; для них используется
`.env.production`.

Для TLS используйте сертификаты своей организации, ACME или внутренний CA. Проверьте лимит тела запроса не ниже лимита вложений OfficeChat.

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
