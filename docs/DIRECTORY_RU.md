# Корпоративный справочник

Справочник хранит контакты отдельно от учётных записей OfficeChat. Запись может
быть связана с пользователем, но наличие OfficeChat account не требуется.

## Статусы

- По умолчанию интерфейс и `GET /api/directory` возвращают активные записи.
- Пользователь с `can_manage_directory` может выбрать `status=all` или
  `status=archived`.
- Архивирование (`is_active=false`) обратимо штатной операцией восстановления.
- Физическое удаление необратимо через UI; восстановление возможно только из
  проверенной резервной копии.

## Permanent delete

Endpoint:

```text
POST /api/directory/{entry_id}/delete-permanently
```

Операция доступна только `superadmin` и только для одной архивной записи без
`linked_user_id`. Запрос содержит:

```json
{
  "confirmation_name": "Точное отображаемое имя",
  "reason": "duplicate",
  "expected_updated_at": "2026-07-28T12:00:00Z"
}
```

Причины ограничены значениями `test_data`, `duplicate`, `incorrect_entry`,
`privacy_request`, `other`. Свободный комментарий не сохраняется.

Backend загружает запись с `SELECT FOR UPDATE`, повторно проверяет роль, статус,
связь с пользователем, имя и `updated_at`, создаёт audit event и удаляет запись
одной транзакцией. Повторный запрос после успеха получает `404`.

Audit event `directory_entry_deleted_permanently` содержит только ID записи,
тип, enum причины и безопасные флаги состояния. Имя, отдел, должность, телефоны,
email, кабинет, расположение, примечания и confirmation text в audit не
копируются.

## Ссылочная целостность

`DirectoryImportRow.matched_entry_id` и `result_entry_id` используют
`ON DELETE SET NULL`. После удаления контакта import batch, execution summary и
история аудита сохраняются. Неожиданная FK-зависимость с `RESTRICT/NO ACTION`
возвращается как безопасный `409 directory_entry_delete_restricted`.
