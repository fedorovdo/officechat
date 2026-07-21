# Backup и восстановление Caddy CA

Volume `officechat_caddy_data` содержит private root/intermediate keys. Потеря volume создаст новый CA и потребует повторной установки `root.crt` на всех клиентах. Архив CA является критическим секретом.

## Backup

Создайте каталог в защищённом администраторском backup storage:

```bash
umask 077
BACKUP_DIR=/secure/admin-backups/officechat-caddy
mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
docker run --rm --entrypoint tar \
  -v officechat_caddy_data:/source:ro \
  -v "$BACKUP_DIR":/backup \
  caddy:2.10-alpine \
  -czf "/backup/caddy-ca-${STAMP}.tar.gz" -C /source .
chmod 600 "$BACKUP_DIR/caddy-ca-${STAMP}.tar.gz"
sha256sum "$BACKUP_DIR/caddy-ca-${STAMP}.tar.gz" >"$BACKUP_DIR/caddy-ca-${STAMP}.tar.gz.sha256"
chmod 600 "$BACKUP_DIR/caddy-ca-${STAMP}.tar.gz.sha256"
```

Не помещайте архив или checksum рядом с исходным кодом и не добавляйте их в Git. Ограничьте доступ к каталогу владельцем/root и храните дополнительную зашифрованную копию согласно политике организации.

## Восстановление

1. Проверьте SHA-256 архива.
2. Остановите только Caddy без удаления volumes.
3. Создайте backup текущего volume.
4. Очистите строго volume `officechat_caddy_data` и распакуйте архив.

```bash
sha256sum -c /secure/admin-backups/officechat-caddy/caddy-ca-BACKUP_TIMESTAMP.tar.gz.sha256
docker compose --env-file .env.production -f deploy/caddy/docker-compose.caddy.yml stop caddy
docker volume inspect officechat_caddy_data
docker run --rm --entrypoint sh \
  -v officechat_caddy_data:/target \
  -v /secure/admin-backups/officechat-caddy:/backup:ro \
  caddy:2.10-alpine \
  -eu -c 'find /target -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +; tar -xzf /backup/caddy-ca-BACKUP_TIMESTAMP.tar.gz -C /target'
docker compose --env-file .env.production -f deploy/caddy/docker-compose.caddy.yml up -d
```

После запуска снова экспортируйте `root.crt` и сравните SHA-256 certificate fingerprint с зафиксированным до аварии:

```bash
docker compose --env-file .env.production -f deploy/caddy/docker-compose.caddy.yml \
  cp caddy:/data/caddy/pki/authorities/local/root.crt ./officechat-root-restored.crt
openssl x509 -in ./officechat-root-restored.crt -noout -fingerprint -sha256
```

Если fingerprint изменился, не продолжайте rollout: клиенты доверяют другому CA. Никогда не используйте `docker compose down -v` для обслуживания или обновления Caddy.
