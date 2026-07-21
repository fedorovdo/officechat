# Установка OfficeChat CA в Windows

Все команды выполняются с placeholder hostname `officechat.example.local`. Получите `officechat-root.crt` и ожидаемый SHA-256 fingerprint через доверенный канал.

## Проверка файла

```powershell
Get-FileHash .\officechat-root.crt -Algorithm SHA256
certutil.exe -hashfile .\officechat-root.crt SHA256
```

Сравните результат с опубликованным администратором значением до импорта.

## Импорт

Запустите PowerShell от имени администратора:

```powershell
Import-Certificate -FilePath .\officechat-root.crt -CertStoreLocation Cert:\LocalMachine\Root
```

Альтернатива:

```powershell
certutil.exe -addstore -f Root .\officechat-root.crt
```

Проверьте наличие сертификата и его thumbprint:

```powershell
Get-ChildItem Cert:\LocalMachine\Root |
  Where-Object Subject -Like '*Caddy Local Authority*' |
  Select-Object Subject, Thumbprint, NotAfter
```

## Проверка OfficeChat

```powershell
Test-NetConnection officechat.example.local -Port 443
curl.exe --ssl-revoke-best-effort https://officechat.example.local/ready
Start-Process https://officechat.example.local
```

Браузер не должен показывать certificate warning. Если предупреждение осталось, проверьте DNS, hostname сертификата, системное время и правильность хранилища `LocalMachine\Root`.

## Вывод компьютера из эксплуатации

Удаляйте только сертификат с заранее проверенным thumbprint:

```powershell
$thumbprint = '<VERIFIED_THUMBPRINT>'
Get-Item "Cert:\LocalMachine\Root\$thumbprint"
Remove-Item "Cert:\LocalMachine\Root\$thumbprint"
```

Не используйте массовое удаление по части Subject. Для доменных компьютеров установку и удаление CA следует выполнять отдельной политикой GPO.
