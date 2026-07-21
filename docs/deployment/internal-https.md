# Внутренний HTTPS OfficeChat

HTTPS нужен и в LAN: он защищает JWT, сообщения и вложения в сети, включает безопасный контекст браузера для Notifications/PWA и исключает подмену frontend-кода.

```text
Client -> HTTPS 443 -> Caddy -> frontend:3000 / backend:8000
```

Caddyfile использует `tls internal`. Caddy создаёт локальный root CA и сертификат hostname. Данные PKI находятся в named volume `officechat_caddy_data`; root certificate внутри контейнера расположен по адресу:

```text
/data/caddy/pki/authorities/local/root.crt
```

## Экспорт публичного сертификата

Экспортируйте только `root.crt`:

```bash
docker compose --env-file .env.production -f deploy/caddy/docker-compose.caddy.yml \
  cp caddy:/data/caddy/pki/authorities/local/root.crt ./officechat-root.crt
chmod 644 ./officechat-root.crt
openssl x509 -in ./officechat-root.crt -noout -fingerprint -sha256
```

Никогда не экспортируйте и не распространяйте `root.key`, `intermediate.key` или весь `/data`. Private keys и CA backup должны храниться только в защищённом администраторском хранилище и не должны попадать в Git.

Перед передачей `root.crt` пользователям опубликуйте SHA-256 fingerprint по независимому доверенному каналу. Для пилотной группы сертификат можно установить вручную. Массовое распространение через Active Directory GPO является отдельным контролируемым этапом и не выполняется installer OfficeChat.

## Windows curl и revocation

После установки CA:

```powershell
curl.exe --ssl-revoke-best-effort https://officechat.example.local/ready
```

Для диагностики изолированной внутренней CA допустим разовый вызов:

```powershell
curl.exe --ssl-no-revoke https://officechat.example.local/ready
```

Не отключайте revocation checks глобально. Внутренняя Caddy CA не предоставляет полноценную корпоративную CRL/OCSP инфраструктуру; это ограничение нужно учитывать при выборе политики PKI.
