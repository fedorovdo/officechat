# Импорт корпоративного справочника v0.2

Импорт доступен пользователям с разрешением `can_manage_directory`. Перед
изменением `DirectoryEntry` файл проходит preview, детерминированную сверку с
основным справочником и отдельное подтверждение.

## Поток

1. Администратор загружает файл и выбирает режим `auto`, `table` или
   `legacy_layout`.
2. Backend проверяет формат и ограничения, вычисляет SHA-256 и разбирает файл
   во временном каталоге.
3. В PostgreSQL сохраняются `DirectoryImportBatch` и строки preview
   `DirectoryImportRow`. Исходный файл удаляется независимо от результата
   анализа.
4. В table mode можно выбрать лист и изменить сопоставление исходных колонок.
5. В preview можно исправить нормализованные поля, тип записи и выбор строки,
   посмотреть warnings и исходные ячейки.
6. Сверка предлагает для каждой строки `create`, `update` или `skip`, показывает
   кандидатов и причины совпадения.
7. Для update оператор выбирает конкретную запись и только те непустые поля,
   которые нужно применить.
8. Dry validation повторно проверяет конфликты, дубли и актуальность совпадений.
9. После явного подтверждения все изменения выполняются одной транзакцией.
10. Batch можно отменить до выполнения. При отмене batch и строки физически
    удаляются.

Batch виден его создателю и `superadmin`. Все endpoints требуют
`can_manage_directory`.

## Правила сверки

Нормализация имени, подразделения, должности, email и телефонов централизована и
используется поиском, сверкой batch и повторной проверкой перед execute.

- `exact`: один кандидат найден по персональному email, достаточно длинному
  нормализованному телефону с совместимыми признаками либо точному сочетанию
  имени, подразделения и должности;
- `probable`: точное имя и один дополнительный совместимый признак;
- `ambiguous`: несколько близких кандидатов, совпадение только по имени или
  конфликт сильных идентификаторов;
- `archived_match`: надёжный кандидат находится в архиве;
- `unmatched`: безопасного кандидата нет;
- `batch_duplicate`: строка дублирует email, длинный телефон с именем,
  identity tuple или полностью нормализованные данные другой строки batch.

Общие mailbox-адреса (`info@`, `office@`, `support@` и подобные) не считаются
персональным exact match. Короткий добавочный номер сам по себе не уникален и
учитывается только вместе с подразделением и другими признаками. Записи
`role`/`department_contact` не используются для автоматического обновления
персональной записи, потому что текущая модель `DirectoryEntry` не хранит тип
контакта.

Безопасные действия по умолчанию:

- unmatched → create;
- единственный exact → update;
- probable/ambiguous → skip до ручного решения;
- archived → skip, оператор может выбрать новую запись либо restore + update;
- повторная строка batch → skip.

Пустое значение из файла никогда не очищает существующее поле. Импорт не меняет
`linked_user_id`, `created_at`, `created_by_user_id` и не архивирует записи,
отсутствующие в файле.

## API и состояния

Дополнительные endpoints:

- `POST /api/directory/imports/{batch_id}/reconcile`;
- `GET /api/directory/imports/{batch_id}/reconciliation`;
- `PATCH /api/directory/imports/{batch_id}/rows/{row_id}/match`;
- `POST /api/directory/imports/{batch_id}/validate-execution`;
- `POST /api/directory/imports/{batch_id}/execute`;
- `GET /api/directory/imports/{batch_id}/result`.

Состояния batch: `draft`, `analyzed`, `reconciled`, `executing`, `completed`,
`failed`, `cancelled`. Execute разрешён только из `reconciled`. Batch
блокируется через `SELECT FOR UPDATE`; повтор completed execute возвращает
сохранённый результат и не создаёт дубли. Конкурентные execute одного batch
сериализуются тем же lock: второй запрос после успешного commit получает
сохранённый результат. Уже сохранённое состояние `executing` отвечает `409`.
Повтор failed batch требует новой reconciliation.

При reconciliation сохраняется `expected_entry_updated_at`. Перед execute
каждая update-запись блокируется и загружается повторно. Изменившийся кандидат даёт
`stale_match`, после чего требуется новая сверка.

Execute разных batches сериализуется PostgreSQL advisory transaction lock. После
получения lock заново загружаются DirectoryEntry и проверяются create/update
конфликты; update/restore targets дополнительно блокируются через `FOR UPDATE`.

## Транзакция и audit

Create, update, restore, row result и audit выполняются в одной транзакции. При
любой validation/DB ошибке все изменения `DirectoryEntry` и успешные audit
events откатываются. Batch получает безопасный failed result отдельной
транзакцией после rollback.

Audit содержит только batch id, агрегированные create/update/restore/skip
счётчики, actor, duration и безопасный error code. Raw cells, телефоны, email,
notes и полные before/after snapshots туда не записываются.

## Форматы и ограничения

Поддерживаются XLSX без выполнения формул и CSV в UTF-8, UTF-8 BOM или
Windows-1251. Для CSV определяются разделители comma, semicolon и tab.
Файлы `.xls`, `.xlsm`, макросы и несовпадающий с расширением формат
отклоняются.

Значения по умолчанию:

- размер файла: 10 МБ;
- листы: 20;
- строки: 20 000;
- колонки: 100;
- заполненные ячейки: 200 000;
- длина значения: 2 000 символов;
- ZIP members: 1 000;
- распакованный XLSX: 100 МБ.

Пределы настраиваются переменными `DIRECTORY_IMPORT_*` из `.env.example`.
Формулы не вычисляются: используется только сохранённое значение, а строка
получает warning. Если сохранённого значения нет, preview явно показывает
отдельное предупреждение. XLSX ZIP проверяется до открытия workbook.

Исходный XLSX удаляется сразу после разбора. Для повторного анализа используются
сохранённые безопасно ограниченные снимки исходных строк внутри preview. В
переключателе листов отображаются только листы, для которых такой снимок можно
воспроизвести; пустые листы не предлагаются. Повторный анализ заменяет ручные
изменения строк и требует подтверждения в UI.

## Оформленный справочник

Legacy parser использует последовательный контекст: отдел, одна или несколько
строк должности, затем ФИО и контакты. Строка должности с телефоном, но без ФИО,
становится кандидатом `role`. Заголовок отдела с общим email или телефоном
становится `department_contact` и не копируется сотрудникам. Метаданные
организации по умолчанию получают `skip`.

Короткие локальные номера консервативно помещаются в `work_phone`, а не в
`internal_phone`, и получают warning `phone_type_uncertain`. Исходное
отображение номера сохраняется. Значение с пометкой `тел/факс` дополнительно
получает warning `phone_fax_source`, поскольку отдельного поля fax в
`DirectoryEntry` пока нет.

Синтетический fixture `tests/fixtures/directory_import_legacy.csv` даёт четыре
контакта `person` и один общий `role`, объединяет многострочную должность и
проверяет phone/fax и email без реальных персональных данных.

События включают `directory_import_uploaded`, `directory_import_analyzed`,
`directory_import_reconciled`, `directory_import_execution_started`,
`directory_import_completed`, `directory_import_failed` и
`directory_import_cancelled`, а также штатные события изменённых
`DirectoryEntry`.

## Жизненный цикл PII

После completed execute для всех листов batch очищаются `raw_cells`,
`normalized_data`, причины и snapshots кандидатов, а также выбранные update
values. Остаются result entry ids, взаимоисключающие action/status и
агрегированный отчёт. Failed batch сохраняет preview для исправления и новой
сверки; автоматический retention completed/failed batches пока не реализован.
Оператор может удалить failed batch вручную. При cancel batch удаляется
физически, строки удаляются по `ON DELETE CASCADE`.

Текущие ограничения: нет background queue, scheduled import, AI matching,
автоматической связи с OfficeChat user, массового архивирования, rollback
completed import и импорта DOCX/PDF.
