# Установка OfficeChat 0.1.0-rc2 на Linux

OfficeChat 0.1.0-rc2 распространяется как Docker Compose bundle для `linux/amd64`.
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
  CHECKSUMS.sha256
  README_INSTALL_RU.md
```

Архив: `officechat-0.1.0-rc2-linux-amd64.tar.gz`.

## 2. Образы

- `ghcr.io/fedorovdo/officechat-backend:0.1.0-rc2`
- `ghcr.io/fedorovdo/officechat-frontend:0.1.0-rc2`
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
tar -xzf officechat-0.1.0-rc2-linux-amd64.tar.gz
cd release
sudo ./install-linux.sh
```

Для реального сервера заранее задайте:

```bash
export PUBLIC_FRONTEND_URL=https://chat.example.com
export PUBLIC_BACKEND_URL=https://chat.example.com
export BACKEND_CORS_ORIGINS=https://chat.example.com
```

Скрипт сохраняет `.env` с правами `0600`, генерирует секреты, если файла еще нет, выполняет `alembic upgrade head`, запускает сервисы и проверяет `/ready`.

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
sudo /opt/officechat/update-linux.sh 0.1.0-rc2
```

По умолчанию перед обновлением создается backup. `--no-backup` разрешен, но выводит предупреждение. Downgrade запрещен без `--allow-downgrade`.

## 9. Откат

Image rollback:

```bash
sudo /opt/officechat/rollback-linux.sh 0.1.0-rc1
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

Примеры:

- `deploy/nginx/officechat.conf`
- `deploy/caddy/Caddyfile`

Для TLS используйте сертификаты своей организации, ACME или внутренний CA. Проверьте лимит тела запроса не ниже лимита вложений OfficeChat.

## 13. Firewall

PostgreSQL и Valkey не публикуются наружу. Обычно наружу открыт только 80/443 reverse proxy. Без reverse proxy frontend слушает `${FRONTEND_HOST_PORT:-3100}`, backend по умолчанию привязан к `127.0.0.1:${BACKEND_HOST_PORT:-8100}`.

## 14. SELinux

На системах с SELinux может потребоваться корректная метка для `/var/lib/officechat`. Не отключайте SELinux глобально без отдельного решения администратора.

## 15. Offline groundwork

Для offline-инсталляций подготовлены `export-images.sh` и `import-images.sh`. Они сохраняют и загружают Docker images, но не заменяют проверку checksum и внутреннюю процедуру доставки.

## 16. Диагностика

```bash
/opt/officechat/collect-diagnostics.sh
```

Диагностика собирает состояние Compose, версии, Alembic revision, sanitized logs, OS/Docker info и свободное место. Она не выгружает `.env`, сообщения, базу данных или вложения.

## 17. Git tag позже

После финальной проверки вручную:

```bash
git tag -a v0.1.0-rc2 -m "OfficeChat 0.1.0-rc2"
git push origin v0.1.0-rc2
```

Этот task не создает tag и не публикует релиз.

## 18. Ограничения RC

- Это release candidate, не стабильный финальный релиз.
- WebSocket fanout пока single-instance; для multi-instance нужен Valkey pub/sub.
- Browser notifications требуют открытую вкладку.
- Нет LDAP/AD, S3, antivirus scanning, recurring calendar, RSVP, email/mobile push.
- Возможны warning-и passlib/bcrypt в dev logs; они не должны блокировать работу.

## 19. Проверка bundle

```bash
bash -n scripts/release/*.sh
bash -n scripts/release/officechatctl
docker compose -f deploy/docker-compose.release.yml config
bash scripts/release/create-release-bundle.sh --dry-run
```
