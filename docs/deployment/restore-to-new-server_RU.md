# Перенос OfficeChat из резервной копии на новый сервер

Процедура для администратора и последующих сессий сопровождения. Проверенный
случай: RC13.36, RED OS 8.0.3, SELinux Enforcing, перенос с `officechattest`
на чистый `regenerationofficechat` 6 октября 2026 года. Источник продолжал
работать; рабочий сервер организации не изменялся. Результаты и оставшиеся
проверки: [отчёт RC13.36](../releases/0.1.0-rc13.36-qualification_RU.md).

Это восстановление PostgreSQL и вложений с отдельным переносом ключа приложения
и CA Caddy. Оно не клонирует ОС, параметры NAS, расписание или runtime Valkey.
Для обычного восстановления на том же сервере используйте
[руководство оператора](../BACKUP_RESTORE_RU.md).

## Что понадобится

| Компонент | Откуда взять | Назначение |
| --- | --- | --- |
| Опубликованная копия с `SUCCESS`, manifest и SHA-256 | NAS или локальный backup repository | PostgreSQL и uploads |
| `config/deployment-private.tar.gz` той же копии | Локальный экземпляр на исходном сервере | `APP_SECRET_KEY` и исходная конфигурация |
| `caddy/caddy-ca.tar.gz` той же копии | Локальный экземпляр на исходном сервере | Root/intermediate CA и их private keys |
| `officechat-root.crt` | Исходный `/opt/officechat` | Сверка исходного публичного CA и доверие клиентов |
| Подходящий релиз и доступ к его образам | Проверенный release bundle / GHCR | Установка нового сервера |

По умолчанию незашифрованные приватные архивы **не отправляются на NAS**.
Наличие внешней копии БД и uploads не означает, что на NAS есть ключ приложения
и CA. Перед утратой исходного сервера обеспечьте отдельное защищённое хранение
этих компонентов или проверенное восстановление их зашифрованных `.age`-версий.
В данном тесте приватные архивы переданы по SSH из локальной копии источника.
Не добавляйте их в Git, описание PR, чат поддержки или публичный backup repository.

В `deployment-private.tar.gz` лежат `./officechat.env` и `./backup.conf`.
Архив `caddy/caddy-ca.tar.gz`, созданный `backup-production.sh`, содержит
**содержимое `/data/caddy/pki`**, например `./authorities/local/root.crt`.
Он отличается от архива всего volume `officechat_caddy_data` из
[отдельного руководства Caddy](caddy-ca-backup-restore.md). Его нужно распаковывать
в `/data/caddy/pki`, а не в корень `/data`.

## Проверенный тестовый стенд

| Параметр | Значение в тесте |
| --- | --- |
| Исходный сервер | `officechattest` |
| Новый сервер | `regenerationofficechat`, `192.168.0.222` |
| Новый HTTPS origin | `https://regenerationofficechat.adm.net` |
| Исходное SMB-хранилище | `//192.168.1.100/backup_share/OfficeChatRedRc36` |
| Выбранная копия | `officechat-backup-20261006-102608Z` |
| Временное read-only подключение на новом сервере | `/mnt/officechat-restore-source` |
| Рабочий каталог нового сервера | `/root/officechat-restore-rc13.36.VzSVyJ` |
| SHA-256 исходного публичного CA | `675412ab5cbc3a9364caa3b6fa5e63ab69ce7044d0ee568b3b0c43372da1b7cc` |

Команды ниже воспроизводят этот случай и намеренно проверяют hostname.
Для следующего переноса замените параметры своего стенда **в каждом блоке**;
не убирайте проверки hostname. На новом сервере используется стандартная БД/роль
`officechat` и Docker Caddy. Для другого layout адаптируйте пути и способ
управления Caddy до начала восстановления.

## 1. Подготовить чистый сервер

1. Создать отдельную ВМ, обновить ОС, сделать snapshot до установки приложения.
2. Настроить DNS A-запись нового имени на фактический IP этой ВМ. Проверить ответ
   корпоративного DNS с клиента и `getent ahostsv4` на новом сервере.
3. Установить prerequisites согласно
   [руководству установки](production-installation.md); для SMB нужен `cifs-utils`.
4. Скачать и проверить installer и bundle, выбрать ту же версию приложения,
   что использовалась для выбранной копии. Не устанавливать случайную более
   старую версию. PostgreSQL major должен быть совместим; проверка ниже это
   дополнительно контролирует.
5. Если GHCR требует авторизацию, выполнить root `docker login ghcr.io`,
   передав токен через стандартный ввод, затем продолжить установку.

Проверенная команда установки после проверки installer:

```bash
bash ./officechat-install.sh \
  --version 0.1.0-rc13.36-redos8-debian13-installer \
  --hostname regenerationofficechat.adm.net \
  --no-create-admin
```

`--no-create-admin` задан сознательно: пользователь и хеш его пароля будут
восстановлены из БД. Приглашения создать пароль нет. До восстановления вход
под `admin` получает `401`; это ожидаемо для пустой базы. После восстановления
используется прежний логин и пароль исходного сервера.

Не задавайте `--enable-backup-timer`. Новый сервер должен сохранять таймер
`disabled/inactive` до настройки собственной площадки и проверки новой копии.
Проверьте `officechatctl health`, `/ready` через HTTPS, SELinux и состояние агента.

Для ожидаемых состояний systemd с ненулевым exit code под `set -Eeuo pipefail`
и ERR trap используйте:

```bash
timer_enabled=$(systemctl is-enabled officechat-backup.timer || true)
timer_active=$(systemctl is-active officechat-backup.timer || true)
test "$timer_enabled" = disabled
test "$timer_active" = inactive
```

Прямая подстановка `test "$(systemctl is-enabled ...)" = disabled` в данном
режиме может запустить ERR trap внутри подстановки и создать ложную ошибку.
Также дождитесь `/ready`: `active` у Docker не означает готовность приложения.
Первый запуск и перезагрузка могут кратковременно показывать `health: starting`.

## 2. Создать и проверить исходную копию

На **исходном** сервере создайте контрольное сообщение с вложением, затем:

```bash
test "$(hostname -s)" = officechattest || exit 1
/opt/officechat/officechatctl backup --pre-upgrade
```

`--pre-upgrade` здесь защищает копию от ротации и включает images;
сама команда не обновляет приложение. Выберите ID именно этого запуска по
`/var/backups/officechat/status/latest.json`, а не по последней строке списка.
Проверьте `success=true`, `verification_status=passed`, `offsite_status=copied`,
`SUCCESS` и `PROTECTED` у локального и внешнего экземпляров, затем:

```bash
backup_id=officechat-backup-20261006-102608Z
/opt/officechat/officechatctl verify-backup \
  "/var/backups/officechat/production/$backup_id"
/opt/officechat/officechatctl verify-backup \
  "/mnt/officechat-offsite/$backup_id"
test -s "/var/backups/officechat/production/$backup_id/config/deployment-private.tar.gz"
test -s "/var/backups/officechat/production/$backup_id/caddy/caddy-ca.tar.gz"
sha256sum /opt/officechat/officechat-root.crt
```

Сохраните ID и SHA-256 публичного CA в журнале переноса. Не меняйте конфигурацию
источника и не отключайте его расписание для этой проверки на отдельной ВМ.

## 3. Подключить копию только для чтения и выполнить restore-drill

На **новом** сервере:

```bash
(
  set -Eeuo pipefail
  trap 'echo "CHECK_FAILED_LINE=$LINENO"' ERR
  umask 077
  test "$(hostname -s)" = regenerationofficechat
  mount_dir=/mnt/officechat-restore-source
  if mountpoint -q "$mount_dir"; then
    echo 'FAIL: restore source is already mounted'; exit 1
  fi
  install -d -m 700 "$mount_dir" \
    /root/officechat-restore-rc13.36.VzSVyJ/private
  credentials_file=$(mktemp /run/officechat-restore-smb.XXXXXX)
  trap 'rm -f -- "$credentials_file"' EXIT
  read -r -p 'SMB user [backup_user]: ' smb_user
  smb_user=${smb_user:-backup_user}
  read -r -s -p 'SMB password: ' smb_password
  echo
  printf 'username=%s\npassword=%s\n' "$smb_user" "$smb_password" \
    > "$credentials_file"
  unset smb_password
  mount -t cifs //192.168.1.100/backup_share/OfficeChatRedRc36 \
    "$mount_dir" \
    -o "ro,credentials=$credentials_file,vers=3.1.1,uid=0,gid=0,dir_mode=0700,file_mode=0600,nosuid,nodev,noexec"
  options=$(findmnt --mountpoint "$mount_dir" --noheadings --output OPTIONS)
  case ",$options," in
    *,ro,*) ;; *) echo 'FAIL: source must be read-only'; exit 1 ;;
  esac
  backup_path="$mount_dir/officechat-backup-20261006-102608Z"
  test -f "$backup_path/SUCCESS"
  test -f "$backup_path/PROTECTED"
  /opt/officechat/officechatctl verify-backup "$backup_path"
  /opt/officechat/officechatctl restore-drill "$backup_path"
)
echo "TARGET_RESTORE_DRILL_EXIT=$?"
```

Пароль не передаётся в аргументах mount; временный credentials удаляется после
блока. Сам mount остаётся до unmount или reboot. Это временный входной ресурс,
а не новая площадка автоматического backup.

`verify-backup` проверяет структуру и checksums. `restore-drill` восстанавливает
копию в изолированном контейнере, **не переносит пользователей в работающий чат**.
В тесте проверены 35 таблиц, 35 relations, одно расширение,
Alembic `20260728_0026`, PostgreSQL 16.15 с обеих сторон.

## 4. Перенести приватные архивы отдельно по SSH

На **новом** сервере покажите public host-key fingerprint для проверки первого
SSH-подключения:

```bash
ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
```

На **исходном** сервере подготовьте защищённый пакет из той же проверенной копии:

```bash
(
  set -Eeuo pipefail
  trap 'echo "CHECK_FAILED_LINE=$LINENO"' ERR
  umask 077
  test "$(hostname -s)" = officechattest
  backup_path=/var/backups/officechat/production/officechat-backup-20261006-102608Z
  /opt/officechat/officechatctl verify-backup "$backup_path"
  package_dir=$(mktemp -d /root/officechat-transfer-rc13.36.XXXXXX)
  install -m 600 "$backup_path/config/deployment-private.tar.gz" "$package_dir/"
  install -m 600 "$backup_path/caddy/caddy-ca.tar.gz" "$package_dir/"
  install -m 600 /opt/officechat/officechat-root.crt "$package_dir/source-root.crt"
  (
    cd "$package_dir"
    sha256sum deployment-private.tar.gz caddy-ca.tar.gz source-root.crt > SHA256SUMS
  )
  ssh root@192.168.0.222 'set -eu
    test "$(hostname -s)" = regenerationofficechat
    install -d -m 700 /root/officechat-restore-rc13.36.VzSVyJ/private'
  scp "$package_dir/deployment-private.tar.gz" "$package_dir/caddy-ca.tar.gz" \
    "$package_dir/source-root.crt" "$package_dir/SHA256SUMS" \
    root@192.168.0.222:/root/officechat-restore-rc13.36.VzSVyJ/private/
)
echo "PRIVATE_TRANSFER_EXIT=$?"
```

SSH запрашивает пароль Linux root нового сервера, а не пароль OfficeChat.
Сверьте предложенный host-key fingerprint с выводом нового сервера; не отключайте
host-key checking. Если root SSH не разрешён, используйте разрешённый
администраторский SSH/SFTP-доступ и перенесите файлы в root-owned каталог через
sudo. Не ослабляйте правила SSH ради этой процедуры.
На новом сервере проверьте `sha256sum --check SHA256SUMS` в `private`.
Не дописывайте эти файлы в опубликованную внешнюю копию: у неё собственный
manifest, учитывающий исключение plaintext-секретов.

## 5. Сохранить настройки назначения, перенести ключ и восстановить данные

Не заменяйте `.env` целиком исходным файлом. PostgreSQL нового сервера уже
инициализирован со своим паролем; смена `POSTGRES_PASSWORD` в `.env` не меняет
пароль роли PostgreSQL. Сохраните `POSTGRES_PASSWORD`, `DATABASE_URL`, новый
hostname и HTTPS URL. Переносится исходный `APP_SECRET_KEY`, необходимый в том
числе для расшифровки настроек интеграций. `backup.conf`, NAS credentials и
настройки агента источника автоматически не копируются.

На **новом** сервере, в интерактивном root-терминале:

```bash
(
  set -Eeuo pipefail
  trap 'echo "CHECK_FAILED_LINE=$LINENO"' ERR
  umask 077
  test "$(id -u)" = 0
  test "$(hostname -s)" = regenerationofficechat
  test "$(getenforce)" = Enforcing
  test "$(/opt/officechat/officechatctl version)" = \
    '0.1.0-rc13.36-redos8-debian13-installer'
  test "$(systemctl is-enabled officechat-backup.timer || true)" = disabled
  test "$(systemctl is-active officechat-backup.timer || true)" = inactive
  private_dir=/root/officechat-restore-rc13.36.VzSVyJ/private
  backup_id=officechat-backup-20261006-102608Z
  backup_path="/mnt/officechat-restore-source/$backup_id"
  (cd "$private_dir"; sha256sum --check SHA256SUMS)
  mountpoint -q /mnt/officechat-restore-source
  options=$(findmnt --mountpoint /mnt/officechat-restore-source --noheadings --output OPTIONS)
  case ",$options," in *,ro,*) ;; *) exit 1 ;; esac
  /opt/officechat/officechatctl verify-backup "$backup_path"
  . /opt/officechat/backup/lib.sh
  load_backup_config /etc/officechat/backup.conf
  test -z "$OFFSITE_ROOT"
  build_compose_args "$COMPOSE_FILES" "$COMPOSE_ENV_FILE" "$COMPOSE_PROJECT_NAME"
  users_before=$(compose exec -T postgres psql -U officechat -d officechat -Atq \
    -c 'SELECT count(*) FROM users;')
  test "$users_before" = 0
  rollback_dir=$(mktemp -d /root/officechat-before-restore-rc13.36.XXXXXX)
  install -m 600 /opt/officechat/.env "$rollback_dir/officechat.env"
  install -m 600 /etc/officechat/backup.conf "$rollback_dir/backup.conf"
  install -m 600 /opt/officechat/officechat-root.crt "$rollback_dir/officechat-root.crt"
  echo "TARGET_CONFIG_BACKUP=$rollback_dir"

  python3 - "$private_dir" <<'PY'
import os
import re
import sys
import tarfile
import tempfile
from pathlib import Path

private = Path(sys.argv[1])
target = Path('/opt/officechat/.env')
with tarfile.open(private / 'deployment-private.tar.gz', 'r:gz') as archive:
    members = [m for m in archive.getmembers()
               if m.name in ('officechat.env', './officechat.env')]
    assert len(members) == 1, 'Missing or duplicate source environment'
    member = members[0]
    assert member.isfile() and member.size <= 1024 * 1024
    source_text = archive.extractfile(member).read().decode('utf-8')

def value(text, key):
    lines = [line for line in text.splitlines() if line.startswith(key + '=')]
    assert len(lines) == 1, f'Missing or duplicate setting: {key}'
    return lines[0].split('=', 1)[1]

secret = value(source_text, 'APP_SECRET_KEY')
assert re.fullmatch(r'[A-Za-z0-9_+/=-]{32,256}', secret), 'Unexpected secret format'
before = target.read_text()
assert value(before, 'OFFICECHAT_HOSTNAME') == 'regenerationofficechat.adm.net'
for key in ('PUBLIC_FRONTEND_URL', 'PUBLIC_BACKEND_URL'):
    assert value(before, key) == 'https://regenerationofficechat.adm.net'
value(before, 'APP_SECRET_KEY')
after = '\n'.join('APP_SECRET_KEY=' + secret if line.startswith('APP_SECRET_KEY=')
                  else line for line in before.splitlines()) + '\n'
assert [line for line in before.splitlines() if not line.startswith('APP_SECRET_KEY=')] == \
       [line for line in after.splitlines() if not line.startswith('APP_SECRET_KEY=')]
with tempfile.NamedTemporaryFile(mode='w', dir=target.parent,
                                 prefix='.restore-env-', delete=False) as stream:
    temp_path = stream.name
    os.fchmod(stream.fileno(), 0o600)
    stream.write(after)
    stream.flush()
    os.fsync(stream.fileno())
os.replace(temp_path, target)
print('SOURCE_APP_SECRET_INSTALLED=PASS')
print('TARGET_DATABASE_PASSWORD_AND_HTTPS_ORIGIN_UNCHANGED=PASS')
PY

  restorecon /opt/officechat/.env
  /opt/officechat/restore-production.sh \
    --config /etc/officechat/backup.conf --production \
    --confirm-hostname "$(hostname)" --confirm-backup "$backup_id" \
    --yes "$backup_path"
  users_after=$(compose exec -T postgres psql -U officechat -d officechat -Atq \
    -c 'SELECT count(*) FROM users;')
  test "$users_after" -gt 0
  echo "RESTORED_USERS=$users_after"
  /opt/officechat/officechatctl health
  test "$(systemctl is-enabled officechat-backup.timer || true)" = disabled
  test "$(systemctl is-active officechat-backup.timer || true)" = inactive
  echo 'TARGET_RESTORE=PASS'
)
echo "TARGET_RESTORE_EXIT=$?"
```

Этот parser рассчитан на `.env`, созданный release installer: один незаключённый
в кавычки `APP_SECRET_KEY`, сгенерированный в base64/URL-safe формате. Если
источник использует `JWT_SECRET`, quoting, иной формат или другой secret provider,
блок остановится; адаптируйте перенос к фактической конфигурации, не генерируйте
новый ключ вместо исходного. Не выполняйте `source` для архивного `.env`.

Настоящее восстановление вызывается через `restore-production.sh`, а не через
`officechatctl restore-drill`. Слово `--production` означает режим изменения
работающей БД; точная проверка hostname ограничивает действие новой тестовой ВМ.
Скрипт создаёт свежую защищённую предвосстановительную копию, проверяет staging
БД и uploads, останавливает приложение, переключает данные и выполняет миграции
и проверки готовности. В тесте восстановлен один пользователь.

При ошибке не повторяйте блок целиком и не удаляйте locks. Определите этап по
журналу. Если после переключения данных приложение оставлено остановленным,
не запускайте его вслепую. Сохраните rollback backup, rollback database и uploads
до приёмки. Например, в данном тесте скрипт оставил:

- backup `officechat-backup-20261006-104204Z`;
- database `officechat_rollback_20261006104224_44947`;
- uploads `/var/lib/officechat/uploads.rollback-20261006104224_44947`.

## 6. Восстановить исходный CA и перевыпустить сертификат нового имени

Остановите только Caddy, сохраните полный текущий data volume, перенесите его
старый PKI и leaf certificates в каталоги `*.before-<stamp>`, затем распакуйте
исходный PKI. Старые сертификаты нового hostname, выпущенные временным CA чистой
установки, не должны остаться активными после смены CA. Приложение и БД на этом
шаге продолжают работать. Никогда не используйте `docker compose down -v`.

На **новом** сервере:

```bash
(
  set -Eeuo pipefail
  trap 'echo "CHECK_FAILED_LINE=$LINENO"' ERR
  umask 077
  test "$(id -u)" = 0
  test "$(hostname -s)" = regenerationofficechat
  test "$(getenforce)" = Enforcing
  private_dir=/root/officechat-restore-rc13.36.VzSVyJ/private
  expected_ca=675412ab5cbc3a9364caa3b6fa5e63ab69ce7044d0ee568b3b0c43372da1b7cc
  (cd "$private_dir"; sha256sum --check SHA256SUMS)
  python3 - "$private_dir/caddy-ca.tar.gz" "$expected_ca" <<'PY'
import hashlib
import sys
import tarfile
from pathlib import PurePosixPath

with tarfile.open(sys.argv[1], 'r:gz') as archive:
    files = {}
    total = 0
    for member in archive.getmembers():
        path = PurePosixPath(member.name)
        assert not path.is_absolute() and '..' not in path.parts
        assert member.isdir() or member.isfile(), 'Unexpected archive member'
        name = str(path)
        if name == '.':
            assert member.isdir()
            continue
        assert path.parts[0] == 'authorities', 'Unexpected CA archive layout'
        total += member.size
        assert total <= 64 * 1024 * 1024
        if member.isfile():
            assert name not in files, 'Duplicate archive member'
            files[name] = member
    for name in ('root.crt', 'root.key', 'intermediate.crt', 'intermediate.key'):
        assert f'authorities/local/{name}' in files, f'Missing {name}'
    certificate = archive.extractfile(files['authorities/local/root.crt']).read()
    assert hashlib.sha256(certificate).hexdigest() == sys.argv[2]
print('SOURCE_CA_ARCHIVE=PASS')
PY

  caddy_compose() {
    docker compose --project-name officechat-caddy \
      --env-file /opt/officechat/.env \
      -f /opt/officechat/caddy/docker-compose.caddy.yml "$@"
  }
  caddy_image=$(docker inspect --format '{{.Image}}' officechat-caddy-caddy-1)
  data_volume=$(docker inspect --format \
    '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Name}}{{end}}{{end}}' \
    officechat-caddy-caddy-1)
  test "$data_volume" = officechat_caddy_data
  ca_backup_dir=$(mktemp -d /root/officechat-ca-before-restore.XXXXXX)
  stamp=$(date -u +%Y%m%dT%H%M%SZ)
  echo "TARGET_CA_BACKUP=$ca_backup_dir"
  install -m 600 /opt/officechat/officechat-root.crt \
    "$ca_backup_dir/officechat-root.before.crt"
  caddy_compose stop caddy
  docker run --rm --network none --user 0:0 --entrypoint tar \
    -v officechat_caddy_data:/data:ro "$caddy_image" -C /data -czf - . \
    > "$ca_backup_dir/caddy-data.before.tar.gz"
  test -s "$ca_backup_dir/caddy-data.before.tar.gz"
  (cd "$ca_backup_dir"; sha256sum caddy-data.before.tar.gz > SHA256SUMS; \
    sha256sum --check SHA256SUMS)
  docker run --rm -i --network none --user 0:0 --entrypoint sh \
    -v officechat_caddy_data:/data "$caddy_image" -eu -c '
      stamp=$1
      test -d /data/caddy/pki
      test ! -e "/data/caddy/pki.before-$stamp"
      test ! -e "/data/caddy/certificates/local.before-$stamp"
      mv /data/caddy/pki "/data/caddy/pki.before-$stamp"
      if test -d /data/caddy/certificates/local; then
        mv /data/caddy/certificates/local "/data/caddy/certificates/local.before-$stamp"
      fi
      mkdir -p /data/caddy/pki
      tar -xzf - -C /data/caddy/pki
      test -s /data/caddy/pki/authorities/local/root.crt
      test -s /data/caddy/pki/authorities/local/root.key
    ' sh "$stamp" < "$private_dir/caddy-ca.tar.gz"
  caddy_compose up -d caddy
  caddy_compose cp caddy:/data/caddy/pki/authorities/local/root.crt \
    "$ca_backup_dir/officechat-root.restored.crt"
  actual_ca=$(sha256sum "$ca_backup_dir/officechat-root.restored.crt")
  test "${actual_ca%% *}" = "$expected_ca"
  install -m 644 "$ca_backup_dir/officechat-root.restored.crt" \
    /opt/officechat/officechat-root.crt
  restorecon /opt/officechat/officechat-root.crt
  echo 'SOURCE_CADDY_CA_RESTORED=PASS'
  https_ready=0
  for attempt in {1..60}; do
    if curl --fail --silent --max-time 5 \
      --cacert /opt/officechat/officechat-root.crt \
      --resolve regenerationofficechat.adm.net:443:127.0.0.1 \
      --output /dev/null https://regenerationofficechat.adm.net/ready; then
      https_ready=1; break
    fi
    sleep 2
  done
  test "$https_ready" = 1
  curl --fail --silent --show-error --max-time 15 \
    --cacert /opt/officechat/officechat-root.crt \
    --resolve regenerationofficechat.adm.net:443:127.0.0.1 \
    --output /dev/null --write-out 'READY_HTTP=%{http_code}\n' \
    https://regenerationofficechat.adm.net/ready
  /opt/officechat/officechatctl health
  echo 'SOURCE_CA_RESTORE=PASS'
)
echo "SOURCE_CA_RESTORE_EXIT=$?"
```

В тесте backup нового CA сохранён в `/root/officechat-ca-before-restore.ETQHV6`.
SHA-256 экспортированного root.crt совпала с исходной, HTTPS `/ready` ответил
`200` при проверке именно с восстановленным CA; `curl -k` не использовался.

## 7. Проверить пользователя, сообщения, вложения и клиентское доверие

Откройте **новый** origin и войдите прежним логином и паролем. Проверьте группу,
контрольное сообщение, скачайте и откройте контрольный файл, сравните его SHA-256
с исходным файлом. Отправьте новое сообщение и убедитесь, что оно сохраняется
после обновления страницы. Отдельно проверьте требуемые интеграции: сохранение
ключа приложения не доказывает доступность внешних сервисов из новой сети.

В проверенном случае в `TestGroup` отображаются:

- «Проверка переноса RC13.36 — 06.10.2026»;
- `test-regenerationofficechat.txt`, 38 байт;
- старое вложение `test-files-officechat-redos (2).txt`, 894 байта;
- пользователь `admin` с ролью `superadmin`, статус онлайн-обновлений «подключено».

Оператор подтвердил успешную работу после переноса. Скриншот подтверждает вход,
сообщение и наличие карточек обоих вложений; отдельный хеш скачанного файла
и новое сообщение после переноса не зафиксированы в журнале этой приёмки.

Совпадение CA и серверный `curl --cacert` не доказывают доверие браузера Windows.
На скриншоте приёмки Chrome отображал «Не защищено», поэтому эту часть нельзя
считать завершённой. Проверьте сертификат текущего HTTPS-подключения и установку
именно исходного публичного CA в нужное доверенное хранилище Windows по
[руководству сертификатов](windows-certificate-installation.md); полностью
закройте и заново откройте браузер. Не используйте обход ошибки сертификата как
подтверждение доверия. Клиентская проверка должна завершиться без предупреждения.
На Windows можно сверить SHA-256 скачанного `officechat-root.crt` с журналом
переноса: `Get-FileHash .\officechat-root.crt -Algorithm SHA256`.

## 8. Перезагрузка и резервные копии нового сервера

Перед отдельным тестом reboot сохраните boot ID, checksums `.env`, `backup.conf`,
публичного CA и снимок uploads, а также количество записей в выбранных таблицах.
После reboot подтвердите новый boot ID, SELinux Enforcing, `docker` и агент,
готовность `/ready` через HTTPS с исходным CA, неизменность настроек и uploads,
вход, старое и новое контрольные сообщения и скачивание файла. Дождитесь
готовности контейнеров, затем выполните `officechatctl health`.

Временный `/mnt/officechat-restore-source` создан обычной командой mount:
он не обязан подключаться после reboot. Восстановленное приложение использует
локальные PostgreSQL и uploads и не зависит от этого входного ресурса.
После окончания чтения его можно отключить обычным `umount`.

Перед включением backup на новом сервере настройте **отдельную папку NAS**,
создайте копию и проверьте её, включая restore-drill. Не назначайте новому серверу
write destination исходного сервера: независимая ротация и запись двух серверов
в один backup repository не входили в этот тест. Расписание включайте явно
после проверки согласно [руководству хранилища](backup-destinations-schedule-ru.md).

В текущем журнале перенос и восстановление CA завершены; reboot нового сервера,
полное клиентское доверие и собственный backup destination ещё не проверены.
Не удаляйте rollback копии и секретные архивы до завершения приёмки и решения
администратора об их защищённом хранении.

## Памятка для следующей сессии сопровождения

- Проверять hostname перед изменением БД/CA; источник и назначение — разные ВМ.
- Не создавать нового `admin` перед переносом, не менять его исходный пароль.
- Различать структурную проверку, изолированный drill и настоящий restore.
- Переносить приватные архивы отдельно от проверенного read-only экземпляра NAS.
- Сохранять исходный `APP_SECRET_KEY`, но пароль БД и HTTPS origin назначения.
- Различать архив `/data/caddy/pki` и архив всего data volume.
- После замены PKI перевыпускать leaf certificate нового имени и проверять CA.
- Таймер назначения оставлять выключенным до настройки собственной площадки.
- При отказе не повторять изменяющий блок: сначала определить этап и rollback.
- Не объявлять reboot, клиентское доверие, хеш скачанного файла или интеграции
  проверенными без отдельного результата оператора.
