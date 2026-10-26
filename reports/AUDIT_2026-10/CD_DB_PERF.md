# AUDIT-2026-10 — Блоки C (БД SQLite) + D (Производительность)

Исполнитель: sd_worker_02. Коммит: `101c846`. Worktree: /home/hermes/audit-wt/w2. Дата: 2026-10-25.
Статус: ЗАВЕРШЁН (2026-10-25). Режим «ревью + план»: код, БД, конфиги и прод не изменялись.

Методика замеров: копия dev-БД (`data/app.db`, схема v6 → мигрирована до v8 через `Database::migrate()` на копии) + синтетический объём в scratch-копии (150 сотрудников, 41 025 записей `schedule_entries` за 2025–2027 при заполнении ~25%, 10 000 строк `sync_log`, 20 000 `audit_log`). Dev-сервер `php -S 127.0.0.1:8092 router.php` с `SC_APP_DB=<scratch-копия>` — рабочая `data/app.db` worktree не затрагивалась. Хост замеров нагружен (load average ~7.5 на 2 ядрах), абсолютные времена — ориентир, относительные — показательны.

## 1. Резюме

Слой БД в целом построен корректно: все рабочие соединения идут через `Database` (WAL, `foreign_keys=ON`, `busy_timeout`), запросы параметризованы, ключевые выборки идут по PK, схема `schema.sql` и миграции v1→v8 дают идентичную структуру. Главные риски — в механике журналов и восстановления: (1) ротация `sync_log` по количеству (10 000) при том, что каждое сохранение пишет событие на каждого сотрудника, превращает freshness-защиту E10-6 и дельту `sync.php` в окно «~100 сохранений» — потеря свежих записей устаревшей вкладкой воспроизведена на dev (C-01, P1); (2) штатный «экспорт → импорт» уничтожает всех участников командировок через FK CASCADE и сбрасывает версии (C-03, P1, воспроизведено). Далее: полный скан на каждое событие дельты (`sync.php` 13–14 с на 41 тыс. записей), отсутствие CHECK/валидации статусов и дат, очередь робота без FK и ретенции, smoke-тест, пишущий в боевой путь БД, непроверяемый бэкап. По производительности: 80% `index.html` — мёртвый статичный снимок матрицы (933 КБ, с ФИО — передано в A), полная перерисовка матрицы ~0.5 с и ~100 тыс. `addEventListener` на каждое изменение, «пиксельная бомба» 8 КБ держит воркер >100 с, статика без `Cache-Control`/версий (риск старого JS после деплоя). Итого 16 находок: P0 — 0, P1 — 2, P2 — 9, P3 — 5.

## 2. Таблица находок

| ID | P | Категория | Место | Заголовок | Уверенность |
|---|---|---|---|---|---|
| C-01 | P1 | C/B | api/save.php:55-60, :289; api/sync.php:231-235 | Ротация sync_log + employee-upsert на каждое сохранение ослепляют freshness E10-6 и дельту → потеря свежих данных | подтверждено на dev |
| C-03 | P1 | C/B | api/import.php:53-58; api/export.php:80 | Импорт выгрузки export.php уничтожает trip_participants (CASCADE), сбрасывает версии, не пишет sync_log | подтверждено на dev |
| C-02 | P2 | C/D | api/sync.php:237-240, :178-189 | Поиск записи по конкатенации ключа (employee_id + ':' + date) — полный скан на каждое событие (13–14 с) | подтверждено на dev |
| C-04 | P2 | C/B | api/schema.sql:60-70,155-174,202-214; api/save.php:439-444 | Нет CHECK и серверной валидации status/approval_status/date | подтверждено по коду |
| C-05 | P2 | C/B | api/schema.sql:202-214; api/trips.php:578-588 | trip_requests без FK/каскада — заявка удалённой командировки уходит роботу | подтверждено по коду |
| C-06 | P2 | C/G | api/smoke_test.php:259, :282-298 | smoke_test пишет в `data/app.db` мимо SC_APP_DB и меняет группы реальных emp_N | подтверждено по коду |
| C-07 | P2 | C/F | DEPLOY_HOSTLAND.md:103-115 | Бэкап `.backup`: нет проверки результата/целостности, права -shm, ротация удаляет удачные копии | требует проверки |
| D-01 | P2 | D | api/upload.php:48-60, :78-92 | Нет лимита пикселей: PNG 8 КБ держит воркер >100 с (Imagick) | подтверждено на dev |
| D-02 | P2 | D/G | index.html:1994 | 933 КБ статичного снимка матрицы в index.html (80% файла) | подтверждено (код + прод) |
| D-03 | P2 | D | index.html:3553-3725, :3655-3662 | Полная перерисовка матрицы ~0.5 с, ~100 тыс. addEventListener за рендер | подтверждено на dev |
| D-05 | P2 | D/F | index.html:2486-2487; прод-заголовки | Статика без Cache-Control и версий — старый JS после деплоя | подтверждено запросом к проду |
| C-08 | P3 | C | api/schema.sql:202-214; api/db.php:528-530 | trip_requests не чистится; auto_vacuum=0, VACUUM не выполняется | подтверждено (код + dev) |
| C-09 | P3 | C | api/db.php:100-138, :292-438 | Миграции без транзакции/блокировки; dev-БД в git на v6 | подтверждено по коду |
| C-10 | P3 | C | api/schema.sql:132,190; api/entries.php:70-73 | Избыточный/неверный индекс, не-sargable фильтр года | подтверждено на dev |
| D-04 | P3 | D/C | api/load.php:96-100; api/helpers.php:44 | Неограниченные выборки всех лет; JSON_PRETTY_PRINT | подтверждено на dev |
| D-06 | P3 | D/C | api/trips.php:154-182, :388-397; js/trips.js:2123-2141 | N+1 в trips, посуточный цикл без лимита периода, второй поллер | подтверждено на dev / вероятно |

## 3. Детальные находки

### C-01 | Ротация sync_log (10 000) + безусловная запись employee-upsert ослепляют freshness-протокол E10-6 и дельту sync.php → потеря свежих данных устаревшей вкладкой
- Приоритет: P1
- Категория: C (рост/очистка sync_log) / B (целостность данных); CWE-362, CWE-664
- Место: `api/save.php:55-60` (ротация), `api/save.php:289` (sync_log на КАЖДОГО сотрудника payload при каждом сохранении), `api/save.php:151-174` (freshness-кэш строится только из оставшихся строк), `api/sync.php:231-235` (дельта без проверки разрыва курсора), `index.html:5631` (poll не идёт в скрытой вкладке: `if (busy || !active || document.hidden) return;`)
- Доказательство:
  ```php
  // save.php:55-60
  $maxId = $pdo->query('SELECT MAX(id) FROM sync_log')->fetchColumn();
  if ($maxId !== false && (int) $maxId > 10000) {
      $pdo->exec('DELETE FROM sync_log WHERE id < ' . ((int) $maxId - 10000));
  // save.php:287-289 — в цикле по ВСЕМ сотрудникам payload, без no-op проверки
  $stmtE->execute();
  sync_log($pdo, 'employee', $id, 'upsert', $ts);
  // sync.php:233-234 — нет сравнения afterId с MIN(id)
  'SELECT DISTINCT entity_type, entity_id FROM sync_log WHERE id > ' . $afterId
  ```
  В dev-БД: 2 770 из 7 709 событий sync_log — `employee/upsert` (эхо полных сохранений). Замер: «эхо»-сохранение без единого изменения (payload = свежий `load.php`) на synth-БД со 154 сотрудниками добавляет 154 события `employee/upsert` (2 сохранения → 308).
- Сценарий сбоя: (1) admin открывает вкладку A и уходит (вкладка скрыта — poll не идёт, курсор C заморожен). (2) В течение дня импорт/другой пользователь вносит больничный X (событие в sync_log с id > C). (3) Admin в вкладке B делает обычную работу: при ~100 сотрудниках каждое автосохранение пишет ~100 строк `employee/upsert`, т.е. ~100 сохранений сдвигают окно в 10 000 событий; событие X и всё между C и MAX-10000 удаляются ротацией. (4) Вкладка A получает фокус: `sync.php?afterId=C` возвращает только хвост журнала, X в дельте нет, клиент ставит курсор = lastSyncId и считает себя актуальным. (5) Любая правка в A → полный `save.php`; X отсутствует в payload, его ключа нет в `freshEntryKeysCache` (строки удалены ротацией) → X удаляется sync-delete (гард E10-4 «≥10 сотрудников» не срабатывает, если затронуто <10 сотрудников). Роль: admin (для значений) или supervisor своей зоны (trip/day_off).
- Последствия: тихая потеря свежих записей матрицы (больничные/отпуска, внесённые импортом или коллегой) — ровно класс инцидентов E10 (07–08.10), против которого сделан E10-6; ротация делает защиту окном в «~100 сохранений», а не во времени.
- Исправление (не применять):
  ```php
  // 1) save.php: employee sync_log только при реальном изменении (после E5-6 предвыборки)
  $changed = !$wasExisting || $oldRow === false || array_diff_assoc(array_map('strval', $newValsForCompare), array_map('strval', $oldRow));
  if ($changed) { sync_log($pdo, 'employee', $id, 'upsert', $ts); }
  // 2) save.php: курсор клиента за пределами журнала => отказ (клиент обязан перезагрузить состояние)
  $minId = (int) $pdo->query('SELECT COALESCE(MIN(id),0) FROM sync_log')->fetchColumn();
  if ($clientLastSyncId !== null && $minId > 0 && $clientLastSyncId < $minId - 1) {
      $pdo->rollBack();
      sendJson(['success' => false, 'error' => 'stale_cursor', 'reload' => true], 409);
  }
  // 3) sync.php GET: то же — сигнал полной перезагрузки вместо неполной дельты
  if ($afterId > 0 && $afterId < $minId - 1) { sendJson(['success'=>true,'resetRequired'=>true,'lastSyncId'=>$lastSyncId]); }
  // 4) ротация по времени, а не по количеству: DELETE FROM sync_log WHERE updated_at < :cutoff_14d
  ```
  Фронт (index.html, poll/save): при `resetRequired`/`stale_cursor` — `StorageAdapter.load()` и повтор правки поверх свежего состояния.
- Уверенность: подтверждено на dev. Воспроизведение (scratch-копия dev-БД, `SC_APP_DB`, скрипт `repro.sh`): вкладка A берёт курсор C=7709; через entries.php создаётся больничный Y (событие 7710); 10 050 событий `employee/upsert` (эквивалент ~100 сохранений по ~100 сотрудников) + одно сохранение вкладки B → ротация, `sync_log` = 7764..17764, событий Y — 0; `sync.php?afterId=7709` отдаёт пустые `entries`; сохранение вкладки A с `clientLastSyncId=7709` → Y удалён, аудит `entry.delete emp_1:2099-03-01`. Контроль без ротации: Y сохранён, аудит `sync.stale_delete_blocked`.
- Статус риска: —

### C-02 | sync.php: поиск записи по конкатенации `employee_id || ':' || date` — полный скан таблицы на каждое событие дельты (N+1 × full scan)
- Приоритет: P2
- Категория: C / D; CWE-1049 (неоптимальный запрос), CWE-400
- Место: `api/sync.php:237-240` (GET-дельта, в цикле по событиям), `api/sync.php:178-189` (POST `keys` — в цикле по ключам)
- Доказательство:
  ```php
  'SELECT employee_id, date, status, comment, approval_status, version, updated_at
   FROM schedule_entries WHERE employee_id || \':\' || date = :k LIMIT 1'
  ```
  `EXPLAIN QUERY PLAN` → `SCAN schedule_entries` (PK `(employee_id, date)` не используется). Замер (41 025 записей, 2 497 различных сущностей в журнале): `GET sync.php?afterId=0` — 12.9–14.0 с; `afterId=MAX-5000` — 14.7 с; `afterId=MAX-1` — 0.01 с. Для сравнения `load.php` целиком — 0.16 с.
- Сценарий сбоя: вкладка, скрытая несколько часов (poll остановлен), или клиент после массового импорта (`vacation_import.php`/`import.php` пишут тысячи entry-событий) запрашивает большую дельту; сложность O(события × записи). На shared-хостинге при `max_execution_time` 30 с запрос на реальном объёме может обрываться 500/504, а каждый такой poll повторяется по фокусу/каждые 20 с — нагрузка ложится на общий PHP-пул Hostland.
- Последствия: зависание/отказ синхронизации у пользователей после массовых операций, CPU-нагрузка на хостинге, риск блокировки аккаунта хостером.
- Исправление (не применять):
  ```php
  // sync.php — разбирать ключ и искать по PK
  $stmtEntry = $pdo->prepare('SELECT employee_id, date, status, comment, approval_status, version, updated_at
                              FROM schedule_entries WHERE employee_id = :e AND date = :d LIMIT 1');
  $pos = strrpos($eid, ':');               // дата не содержит ':'
  $stmtEntry->execute([':e' => substr($eid, 0, $pos), ':d' => substr($eid, $pos + 1)]);
  ```
  Аналогично в POST-ветке (`sync.php:178-189`).
- Уверенность: подтверждено на dev (EXPLAIN + замер).
- Статус риска: —

### C-03 | Восстановление import.php из выгрузки export.php молча уничтожает всех участников командировок (FK CASCADE), сбрасывает версии записей и не пишет sync_log
- Приоритет: P1
- Категория: C (целостность FK, корректность бэкапа/восстановления) / B; CWE-1265 (unintended reentrant/cascade), CWE-404
- Место: `api/import.php:53-58` (полная очистка), `api/import.php:104-107` (INSERT без `version`), `api/export.php:36-120` (в выгрузке нет trips/trip_participants/trip_requests/users/version), `api/schema.sql:187-188` (`trip_participants … ON DELETE CASCADE`)
- Доказательство:
  ```php
  // import.php:53-58 — внутри транзакции, foreign_keys=ON (db.php:529)
  $pdo->exec('DELETE FROM schedule_entries');
  $pdo->exec('DELETE FROM vacation_balances');
  $pdo->exec('DELETE FROM employees');      // → CASCADE trip_participants
  // export.php:80 — entries без version; trips не выгружаются вовсе
  'SELECT employee_id, date, status, comment, approval_status, updated_at FROM schedule_entries'
  ```
- Сценарий сбоя (admin, штатная процедура «экспорт → импорт» как бэкап/перенос): (1) есть командировки с участниками; (2) admin делает `GET export.php` и затем `POST import.php` этим же файлом. Воспроизведено на dev (`repro_import.sh`): до — trips=1, participants=1, max(version)=2; после — trips=1, **participants=0**, max(version)=1; ответ импорта 200 `success:true`. Ключи выгрузки: employees, entries, exportedAt, groups, holidays, positions, vacationBalances, version, year — командировок нет.
- Последствия: (а) все командировки превращаются в «пустые» карточки без участников и периодов — потеря данных, которые восстановить из выгрузки невозможно; (б) версии записей сброшены в 1 — открытые вкладки с картой версий получают ложные конфликты/или, наоборот, при совпадении «1» затирают; (в) импорт не пишет sync_log — открытые вкладки не узнают о замене данных, а их следующий полный `save.php` (admin) возвращает удалённых сотрудников/записи (freshness-гард E10-6 не срабатывает — событий нет).
- Исправление (не применять):
  ```php
  // export.php — выгружать всё, что удаляет/восстанавливает import.php
  $out['trips']            = $pdo->query('SELECT * FROM trips')->fetchAll(PDO::FETCH_ASSOC);
  $out['tripParticipants'] = $pdo->query('SELECT trip_id, employee_id, start_date, end_date FROM trip_participants')->fetchAll(PDO::FETCH_ASSOC);
  // + version в entries
  // import.php — сохранить участников, если в бэкапе их нет; восстановить, если есть
  if (!isset($body['tripParticipants'])) {
      error('invalid_format: backup has no trips; refusing destructive import (would cascade trip_participants)', 400);
  }
  // … после вставки employees: INSERT INTO trips/trip_participants из $body
  // в конце транзакции — одно событие для всех клиентов:
  $pdo->exec("INSERT INTO sync_log (entity_type, entity_id, action, actor, updated_at) VALUES ('system','import','reset','" . sync_actor() . "','" . now() . "')");
  ```
  Клиент (index.html applyDelta): событие `system/reset` → полная перезагрузка `load.php`. Дополнительно — перед импортом серверный снимок: `VACUUM INTO 'data/pre-import-<ts>.db'` (SQLite ≥ 3.27; на Hostland PHP 8.1 — проверить `SELECT sqlite_version()`).
- Уверенность: подтверждено на dev.
- Статус риска: —

### C-04 | Нет CHECK-ограничений и серверной валидации формата для статусов/дат: схема принимает любые строки в status/approval_status/date/trip_requests.status
- Приоритет: P2
- Категория: C (схема) / B; CWE-20, CWE-1284
- Место: `api/schema.sql:60-70` (schedule_entries), `api/schema.sql:155-174` (trips: status, transport_*_mode, advance_amount), `api/schema.sql:202-214` (trip_requests.status); код-пути без валидации: `api/save.php:439-444` и `api/save.php:579-583` (admin: status/approval_status/date пишутся как есть), `api/import.php:113-119`
- Доказательство:
  ```php
  // save.php:439-444 — проверяется только null
  $empId = $entry['employeeId'] ?? $entry['employee_id'] ?? null;
  $date  = $entry['date'] ?? null;
  if ($empId === null || $date === null) { continue; }
  // save.php:581-582
  $stmtEn->bindValue(':status', $entry['status'] ?? null, PDO::PARAM_STR);
  $stmtEn->bindValue(':approval_status', $entry['approvalStatus'] ?? $entry['approval_status'] ?? 'draft', PDO::PARAM_STR);
  ```
  В schema.sql: 0 вхождений `CHECK`. Комментарии `-- forecast | confirmed`, `-- 'avia' | 'zd'`, `>= 0` — только комментарии.
- Сценарий сбоя: старый/битый клиент или admin-скрипт присылает `date: "2026-7-5"` / `"2026-07-05T00:00"` / `status: "Vacation"` / `approvalStatus: "APPROVED"`. Строка сохраняется; затем: year-фильтр sync-удаления `date LIKE '2026-%'` (`save.php:615`) её видит, а фронт (`dateStrToDoy`) — нет, или наоборот; approved-guard (`=== 'approved'`, `save.php:506`) не защищает `"APPROVED"`; PK `(employee_id, date)` допускает «дубли» одного дня в разных форматах.
- Последствия: «невидимые» записи, дубли дня, обход approved-guard регистром, неконсистентные выгрузки/аудит.
- Исправление (не применять): серверная валидация в одном хелпере + CHECK в схеме для новых БД (для существующих — через пересоздание таблицы в миграции v9).
  ```php
  // helpers.php
  function valid_entry(array $e): bool {
      return preg_match('/^\d{4}-\d{2}-\d{2}$/', (string)($e['date'] ?? '')) === 1
          && checkdate((int)substr($e['date'],5,2), (int)substr($e['date'],8,2), (int)substr($e['date'],0,4))
          && in_array($e['status'] ?? null, ['vacation','sick','day_off','dayoff','trip'], true)
          && in_array($e['approvalStatus'] ?? $e['approval_status'] ?? 'draft', ['draft','approved'], true);
  }
  // save.php:441 / import.php:115 / entries.php POST,PUT:  if (!valid_entry($entry)) { $rejections[] = ['key'=>$key,'reason'=>'invalid']; continue; }
  ```
  ```sql
  -- schema.sql (v9, новые БД)
  status TEXT CHECK (status IN ('vacation','sick','day_off','dayoff','trip')),
  approval_status TEXT DEFAULT 'draft' CHECK (approval_status IN ('draft','approved')),
  date TEXT CHECK (date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  -- trips
  status TEXT NOT NULL DEFAULT 'forecast' CHECK (status IN ('forecast','confirmed')),
  advance_amount INTEGER CHECK (advance_amount IS NULL OR advance_amount >= 0),
  -- trip_requests
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','delivered','created','validation_error','failed'))
  ```
  Перечень допустимых status сверить с фронтом (index.html, легенда матрицы) до внедрения.
- Уверенность: подтверждено по коду (отсутствие CHECK — также `schemadiff.php`: 0 CHECK); конкретные последствия на фронте — вероятно.
- Статус риска: —

### C-05 | trip_requests без внешнего ключа и без каскада: удаление/изменение командировки оставляет заявку в очереди робота
- Приоритет: P2
- Категория: C (целостность FK) / B
- Место: `api/schema.sql:202-214`, `api/db.php:247-261` (нет `FOREIGN KEY (trip_id) REFERENCES trips(id)`), `api/trips.php:578-588` (DELETE trips не трогает trip_requests), `api/trip_relay.php:120-124` (poll выдаёт любую `queued`)
- Доказательство:
  ```sql
  CREATE TABLE IF NOT EXISTS trip_requests (
      request_id  TEXT PRIMARY KEY,
      trip_id     TEXT NOT NULL,          -- без REFERENCES
      employee_id TEXT,                   -- без REFERENCES
  ```
  ```php
  // trips.php:585-588 — комментарий «CASCADE удалит участников», trip_requests не упоминается
  $stmtDel = $pdo->prepare('DELETE FROM trips WHERE id = :id');
  ```
- Сценарий сбоя: admin подтверждает командировку (`?action=confirm` → строки `queued`), затем отменяет её (DELETE — admin может удалять confirmed) до очередного poll робота. Робот получает payload удалённой командировки и создаёт заявку в HelpMe (билеты/гостиница/аванс). Аналогично при удалении сотрудника.
- Последствия: заявки HelpMe по отменённым командировкам (финансовые/организационные последствия), «осиротевшие» строки с ПДн в очереди бессрочно.
- Исправление (не применять):
  ```php
  // trips.php DELETE, внутри транзакции до DELETE FROM trips:
  $pdo->prepare("UPDATE trip_requests SET status='failed', last_error='trip_deleted', done_at=:ts
                 WHERE trip_id=:id AND status IN ('queued','delivered')")->execute([':id'=>$id, ':ts'=>$ts]);
  // trip_relay.php poll: выдавать только при живой командировке
  "SELECT r.request_id, r.payload FROM trip_requests r JOIN trips t ON t.id = r.trip_id
    WHERE r.status = 'queued' ORDER BY r.created_at, r.request_id LIMIT 1"
  ```
  В миграции v9 (пересоздание таблицы): `FOREIGN KEY (trip_id) REFERENCES trips(id) ON DELETE CASCADE` — если историю заявок хранить не требуется; иначе — оставить без FK, но с явной отменой как выше.
- Уверенность: подтверждено по коду; доставка в HelpMe — сторона робота не проверялась.
- Статус риска: —

### C-06 | smoke_test.php пишет напрямую в `data/app.db` (игнорирует `SC_APP_DB`) и переназначает группы реальным сотрудникам emp_1/2/5/16/17/18
- Приоритет: P2
- Категория: C (код-путь, изменяющий боевую БД) / G; CWE-489 (active debug code), CWE-1188
- Место: `api/smoke_test.php:259` (`new PDO('sqlite:' . $root . '/data/app.db')`), `api/smoke_test.php:282-298` (фикстуры: INSERT/`UPDATE employees SET group_id`), `api/smoke_test.php:171-197` (cleanup: DELETE по датам/заголовкам), `api/smoke_test.php:530`, `:1794`, `:1805` (ещё 15+ прямых PDO на `data/app.db`); поддержка `SC_APP_DB` есть только в `api/db.php:506`
- Доказательство:
  ```php
  // smoke_test.php:259, 291-297
  $pdoF = new PDO('sqlite:' . $root . '/data/app.db');
  ...
  } else {
      $pdoF->exec("UPDATE employees SET group_id = '{$fgid}' WHERE id = '{$fid}'");
  }
  ```
  ID сотрудников в боевой схеме — `emp_N` (save.php:651-652 упоминает реальных `emp_5`/`emp_21` из инцидентов 07–08.10); фикстура принудительно ставит `emp_5/16/17/18 → g0`, `emp_1/2 → g1`.
- Сценарий сбоя: (а) разработчик запускает smoke на рабочей копии с прод-данными (восстановленный бэкап в `data/app.db`) — у 6 реальных сотрудников меняется подразделение (зона супервайзера), удаляются записи emp_1 на тестовые даты, создаются «Smoke Employee N», если ID свободны; `SC_APP_DB` не помогает — тест его игнорирует. (б) На проде файл выложен и исполняется по анонимному GET (00_MAP §3, падает на `proc_open` → «Server did not start», стр. 224, т.е. ДО фикстур); защита держится только на том, что CLI PHP на хостинге 5.3 и `php -S` не стартует.
- Последствия: порча зонирования (супервайзер теряет/получает чужих сотрудников), удаление записей матрицы; на проде — при смене CLI PHP на хостинге или успешном старте сервера.
- Исправление (не применять):
  ```php
  // smoke_test.php, сразу после $root = …
  if (PHP_SAPI !== 'cli') { http_response_code(404); exit; }
  $dbPath = getenv('SC_APP_DB') ?: ($root . '/data/app.db');
  if (getenv('SC_APP_DB') === false) {           // по умолчанию — только на временной копии
      $tmp = sys_get_temp_dir() . '/smoke_' . getmypid() . '.db';
      copy($root . '/data/app.db', $tmp); putenv('SC_APP_DB=' . $tmp); $dbPath = $tmp;
  }
  // все new PDO('sqlite:' . $root . '/data/app.db') → new PDO('sqlite:' . $dbPath)
  // и запуск сервера: sprintf('SC_APP_DB=%s php -S …', escapeshellarg($dbPath), …)
  ```
  Плюс исключить `api/smoke_test.php` из прод-пакета (DEPLOY_HOSTLAND §1/§4 — `cp -a /tmp/scnew/api` копирует весь каталог).
- Уверенность: подтверждено по коду; на проде — путь до фикстур не доходит (по данным 00_MAP), повторно не запрашивался (запрещено).
- Статус риска: —

### C-07 | Бэкап `sqlite3 .backup` из планировщика: не проверяется результат/целостность, права на `-wal/-shm` при разных пользователях, бэкапы с ПДн без защиты
- Приоритет: P2
- Категория: C (бэкап при WAL) / F
- Место: `DEPLOY_HOSTLAND.md:103-115` (§6), `api/db.php:528` (WAL), `DEPLOY_HOSTLAND.md:64-65` (chmod 755/644 на data/)
- Доказательство:
  ```
  sqlite3 /home/host1882970/.../www/data/app.db \
    ".backup '/home/host1882970/backups/app-$(date +\%F).db'"
  find /home/host1882970/backups -name 'app-*.db' -mtime +30 -delete
  ```
- Анализ: сам механизм `.backup` (online backup API) при WAL корректен — читает согласованный снимок с учётом WAL. Риски в обвязке: (1) задача cron в панели выполняется от пользователя аккаунта, а `-wal/-shm` создаёт веб-процесс; если это разные пользователи (00_MAP/PROMPT упоминают ACL веб-пользователя на `data/`), `sqlite3` при чтении WAL-базы должен открыть `-shm` на запись — при 644 чужого владельца получится `attempt to write a readonly database`/`unable to open database file`, задание молча падает; (2) нет `PRAGMA integrity_check` копии и нет оповещения о сбое — первая проверка бэкапа случится при восстановлении; (3) `find … -delete` удаляет старые копии независимо от того, создаются ли новые; (4) 30 копий полной БД (ПДн, больничные, хеши паролей, токены `meta`) лежат открыто в `~/backups`; (5) версия `sqlite3` CLI на хостинге неизвестна (AlmaLinux 8 штатно поставляет 3.26 — вероятно) — `.backup` поддерживается, `VACUUM INTO` (≥3.27) — вероятно нет.
- Сценарий сбоя: веб-процесс держит `-shm` (владелец — веб-пользователь, 0644) → ночной `.backup` от пользователя аккаунта завершается ошибкой → через 30 дней `find -mtime +30 -delete` удаляет последние удачные копии → бэкапов нет.
- Последствия: потеря возможности восстановления после инцидента класса E10 (массовое стирание) — единственный путь отката.
- Исправление (не применять) — команда задания планировщика:
  ```sh
  F=/home/host1882970/backups/app-$(date +\%F).db; \
  sqlite3 /home/host1882970/host1882970.hostland.pro/htdocs/www/data/app.db ".backup '$F'" \
  && [ "$(sqlite3 "$F" 'PRAGMA integrity_check;')" = ok ] && gzip -9 "$F" && chmod 600 "$F.gz" \
  && find /home/host1882970/backups -name 'app-*.db.gz' -mtime +30 -delete \
  || echo "SC backup FAILED $(date)" >> /home/host1882970/backups/FAILED.log
  ```
  Удалять старые копии только после успешной новой (как выше); раз в месяц — пробное восстановление на dev (`sqlite3 копия 'select count(*) from employees'`).
- Уверенность: требует проверки (нет доступа к панели/SSH: владелец файлов `data/app.db*`, пользователь cron, наличие задания и файлов в `~/backups`).
- Статус риска: —

### C-08 | Рост и хранение: trip_requests (payload с ПДн и авансом) не чистится никогда; auto_vacuum=0, VACUUM не выполняется; журналы — 95% файла
- Приоритет: P3
- Категория: C (рост таблиц, VACUUM)
- Место: `api/schema.sql:202-214` / `api/trips.php:655-660` (вставка) — нет ни одного `DELETE FROM trip_requests` в api/*; `api/db.php:528-530` (нет `auto_vacuum`/`wal_autocheckpoint`/`journal_size_limit`); `api/save.php:55-60` и `api/helpers.php:243-245,266-281` (удаления без последующего освобождения места)
- Доказательство: `grep -rn "DELETE FROM trip_requests" api/` → только smoke-тест; dev-БД: `PRAGMA auto_vacuum` = 0; dbstat — audit_log+индекс 942 КБ, sync_log+индекс 631 КБ из 1.68 МБ.
- Сценарий сбоя: каждая подтверждённая командировка навсегда оставляет по строке на участника с JSON (ФИО, телефон, маршрут, гостиница, сумма аванса, last_error робота). При ротации sync_log/audit_log файл не уменьшается (страницы уходят во freelist); после разовых всплесков (импорт, массовые правки — сотни тысяч событий) файл остаётся раздутым навсегда, бэкапы ×30 — тоже.
- Последствия: бессрочное хранение ПДн вне сроков (152-ФЗ — минимизация/сроки, оценка — юристу), рост файла и бэкапов.
- Исправление (не применять):
  ```php
  // helpers.php audit_cleanup() — заодно ретенция очереди робота (финальные статусы > 90 дней)
  $pdo->prepare("DELETE FROM trip_requests WHERE status IN ('created','validation_error','failed')
                 AND done_at < :cut")->execute([':cut' => gmdate('Y-m-d\TH:i:s+00:00', time() - 90*86400)]);
  // db.php connect(): ограничить WAL-файл и вернуть место инкрементально
  $this->pdo->exec('PRAGMA journal_size_limit = 8388608');
  // миграция v9 (однократно): PRAGMA auto_vacuum = INCREMENTAL; VACUUM;
  // audit_cleanup(): $pdo->exec('PRAGMA incremental_vacuum(200)'); — ВНЕ транзакции
  ```
- Уверенность: подтверждено по коду и на dev-копии.
- Статус риска: —

### C-09 | Миграции на первом HTTP-запросе без транзакции и блокировки; dev-БД в git отстаёт от схемы (v6 при SCHEMA_VERSION=8)
- Приоритет: P3
- Категория: C (рассинхрон schema.sql ↔ db.php ↔ БД, SCHEMA_VERSION)
- Место: `api/db.php:100-138` (`migrate()`: `exec(schema.sql)` + ALTER + `setMeta` без `BEGIN IMMEDIATE`), `api/db.php:292-438` (`migrateLegacyTrips` — многошаговые INSERT без транзакции), вызов `->migrate()` в каждом эндпоинте (`api/load.php:32`, `api/sync.php:87`, `api/save.php:67` и др.), `data/app.db` @101c846: `schema_version=6`
- Доказательство:
  ```php
  if ($current >= self::SCHEMA_VERSION) { return true; }
  $this->pdo->exec($sql);                       // schema.sql целиком
  $this->applyIncrementalMigrations($current);  // ALTER TABLE …
  $this->setMeta('schema_version', (string) self::SCHEMA_VERSION);
  ```
- Сценарий сбоя: после выкладки кода с новой версией схемы два параллельных первых запроса (poll нескольких вкладок) оба видят старую версию и выполняют ALTER; второй получает `duplicate column` (защищено `addColumnIfNotExists` только частично — проверка и ALTER не атомарны) → 500 у пользователя; при сбое посередине `migrateLegacyTrips` (без транзакции) возможны частично созданные trips. На dev: любой первый запрос мутирует `data/app.db` из git (v6→v8), что регулярно «пачкает» worktree.
- Последствия: разовые 500 при деплое схемы; риск частично применённой миграции. Сейчас прод уже на v8 (по коду trip_relay работает — E12 deploy), поэтому риск относится к следующим миграциям.
- Исправление (не применять):
  ```php
  public function migrate(): bool {
      if ($this->getSchemaVersion() >= self::SCHEMA_VERSION) return true;
      $this->pdo->exec('BEGIN IMMEDIATE');            // сериализует параллельные запросы
      try {
          $current = $this->getSchemaVersion();       // перечитать под блокировкой
          if ($current < self::SCHEMA_VERSION) { /* exec schema, applyIncrementalMigrations, setMeta */ }
          $this->pdo->exec('COMMIT');
      } catch (Throwable $e) { $this->pdo->exec('ROLLBACK'); throw $e; }
      return true;
  }
  ```
  (DDL в SQLite транзакционен.) Dev-БД в git один раз мигрировать до v8 и закоммитить.
- Уверенность: подтверждено по коду; гонка не воспроизводилась.
- Статус риска: —

### C-10 | Индексы: избыточный idx_sync_log_id, неверно названный idx_trips_dates, не-sargable фильтр года в entries.php
- Приоритет: P3
- Категория: C (индексы под реальные выборки)
- Место: `api/schema.sql:132` (`CREATE INDEX idx_sync_log_id ON sync_log (id)` — `id` уже rowid), `api/schema.sql:190` (`idx_trips_dates ON trips (created_at)` — по датам командировок индекса нет; периоды в `trip_participants`), `api/entries.php:70-73` (`substr(date, 1, 4) = :year`)
- Доказательство (EXPLAIN QUERY PLAN на synth-копии): `MAX(id)` → `SEARCH sync_log USING COVERING INDEX idx_sync_log_id` (вместо rowid — тот же эффект, лишние 94 КБ и запись в индекс на каждое событие); `substr(date,1,4)=…` и `date LIKE '2026-%'` (save.php:615) → `SCAN … USING COVERING INDEX sqlite_autoindex_schedule_entries_1` (полный проход); `date >= '2026-01-01' AND date <= '2026-12-31'` с `employee_id = ?` → `SEARCH (employee_id=? AND date>? AND date<?)`.
  Проверено и в порядке: `schedule_entries` по `(employee_id,date)` — PK; `trip_participants` по `trip_id` — PK, по `employee_id` — `idx_trip_participants_emp`; `trip_requests` по `status` — индекс (+ TEMP B-TREE для ORDER BY — несущественно на малой очереди); `audit_log` по `ts` — индекс; `sync_log WHERE id > ?` — rowid.
- Последствия: несущественные сейчас (таблицы малы); при росте schedule_entries — полный проход на фильтре года в save.php при каждом сохранении.
- Исправление (не применять):
  ```sql
  DROP INDEX IF EXISTS idx_sync_log_id;
  CREATE INDEX IF NOT EXISTS idx_schedule_entries_date ON schedule_entries (date);
  ```
  ```php
  // entries.php:71-72 и save.php:615 — диапазон вместо substr/LIKE
  $sql .= ' AND date BETWEEN :y1 AND :y2'; $params[':y1'] = "$yearInt-01-01"; $params[':y2'] = "$yearInt-12-31";
  ```
- Уверенность: подтверждено на dev (EXPLAIN).
- Статус риска: —

### D-01 | upload.php: нет лимита пикселей до декодирования — PNG 8 КБ (8000×8000) занимает PHP-воркер >100 с (Imagick), 20000×20000 — исчерпание памяти (GD)
- Приоритет: P2
- Категория: D (тяжёлые синхронные операции) / A-смежное; CWE-400, CWE-409 (decompression bomb)
- Место: `api/upload.php:48-60` (проверяются только размер файла 2 МБ и MIME), `api/upload.php:78-92` (Imagick: декодирование + Lanczos-ресайз полного кадра), `api/upload.php:106-111` (GD: `imagecreatefrompng` полного кадра)
- Доказательство:
  ```php
  $maxSize = 2 * 1024 * 1024;  if ($file['size'] > $maxSize) { … }
  $mime = $finfo->file($file['tmp_name']);           // размеры в пикселях не проверяются
  $image = new Imagick($file['tmp_name']);           // полный декод
  $image->resizeImage($targetSize, $targetSize, Imagick::FILTER_LANCZOS, 1);
  ```
  Замер на dev (Imagick загружен; сервер с `-d memory_limit=128M -d max_execution_time=30`, admin): 3000×3000 PNG (1.2 КБ) → 200 за 2.4 с; **8000×8000 PNG (7.9 КБ) → ответа нет за 100 с** (клиентский таймаут; память Imagick не учитывается в `memory_limit`). GD-путь: палитровый/truecolor буфер 20000×20000 = 400 МБ–1.6 ГБ → Fatal «Allowed memory size exhausted» (оценка; GD на dev не изолировался).
- Сценарий сбоя: любой пользователь с правом редактирования (supervisor/admin) или угнанная сессия отправляет несколько крошечных PNG «пиксельных бомб» → каждый держит PHP-процесс shared-хостинга минуты, потребляя CPU/RAM/диск (кэш пикселей Imagick); параллельные запросы исчерпывают лимиты аккаунта Hostland → приложение недоступно всем.
- Последствия: отказ в обслуживании, риск санкций хостера за нагрузку.
- Исправление (не применять):
  ```php
  // upload.php — после проверки MIME, до декодирования
  $dim = @getimagesize($file['tmp_name']);           // читает только заголовок
  if ($dim === false || $dim[0] < 64 || $dim[1] < 64 || $dim[0] * $dim[1] > 40000000 || max($dim[0], $dim[1]) > 10000) {
      error('image_dimensions_out_of_range', 400);
  }
  if (extension_loaded('imagick')) {
      Imagick::setResourceLimit(Imagick::RESOURCETYPE_MEMORY, 256 * 1024 * 1024);
      Imagick::setResourceLimit(Imagick::RESOURCETYPE_AREA,   40000000);
      Imagick::setResourceLimit(Imagick::RESOURCETYPE_TIME,   15);
      $image = new Imagick();
      $image->setOption('jpeg:size', '1024x1024');   // ускоренный декод JPEG
      $image->readImage($file['tmp_name']);
      $image->thumbnailImage(512, 512, true);        // вместо Lanczos по полному кадру (после crop)
  }
  ```
- Уверенность: подтверждено на dev (Imagick); какое расширение (Imagick/GD) включено на Hostland и его лимиты — требует проверки (нужен phpinfo под авторизацией).
- Статус риска: —

### D-02 | index.html: 80% монолита (933 КБ одной строкой) — статичный снимок отрендеренной матрицы с ФИО/должностями и отпусками, который JS сразу перезаписывает
- Приоритет: P2
- Категория: D (размер первой загрузки) / G; ПДн-аспект передан в A
- Место: `index.html:1994` (`<tbody id="matrixBody">…` — 933 716 байт: 42 строки сотрудников, 15 372 ячейки, 1 115 ячеек с классом `vacation`), `index.html:1993` (`<thead id="matrixHead">` 11.6 КБ), `index.html:3650` (`matrixBody.innerHTML = bodyHTML;` — перезапись при первом рендере); в репозитории с базового коммита `aa16c93` (2026-08-29)
- Доказательство: разбор файла (`htmlsize.php`, `snapshot.php`): index.html 1 168 199 Б; inline base64 `data:` — 0 (`grep -c 'data:image'` → 0); inline `<style>` 58 КБ, inline `<script>` 134 КБ; строка 1994 — 933 КБ. Прод: `GET /` → 200, ETag `W/"11d347-…"` (= 1 168 199 Б, совпадает с файлом @101c846), передано br 68 468 Б / gzip 103 815 Б / без сжатия 1 168 199 Б.
- Сценарий сбоя: при каждой загрузке (в т.ч. анонимной, до логина) браузер парсит и строит DOM на ~16 тыс. ячеек, затем `renderVacationMatrix()` выбрасывает его и строит заново — двойная работа на главном потоке; при отключённом сжатии (клиент/прокси без Accept-Encoding) — 1.17 МБ по HTTP без TLS.
- Последствия: лишние сотни мс–секунды первой отрисовки на слабых рабочих ПК; ~85% трафика HTML — мёртвый груз; снимок ПДн в статике (см. «Передано в A»).
- Исправление (не применять): заменить строку 1994 на пустой контейнер, данные приходят только из `load.php` после логина.
  ```html
  <tbody id="matrixBody"></tbody>
  ```
  То же для `<thead id="matrixHead">` (строится в `renderVacationMatrix`, `index.html:3566-3596`) и для пререндеренных карточек сотрудников в `index.html:2105-2420` (45 `<article>`), если они также перерисовываются JS.
- Уверенность: подтверждено по коду и запросом к проду (размер/ETag/сжатие).
- Статус риска: —

### D-03 | Полная перерисовка матрицы года при каждом изменении: innerHTML на все ячейки + ~6 addEventListener на ячейку (≈100 тыс. вызовов за рендер), document-listener в цикле
- Приоритет: P2
- Категория: D (frontend: перерисовка, обработчики)
- Место: `index.html:3553-3725` (`renderVacationMatrix`), `index.html:3610-3646` (на каждую ячейку `getDayVacationType` + `getDayVacationRecord` — линейный проход по диапазонам сотрудника, + третий проход по диапазонам для range-start/end), `index.html:3650` (`matrixBody.innerHTML = bodyHTML`), `index.html:3655-3662` (5 обработчиков на ячейку + `document.addEventListener('mouseup', …)` внутри цикла по ячейкам), `index.html:3664-3722` (замыкание на каждую строку); вызовы рендера — 12 мест, в т.ч. `index.html:5654` (каждый poll с изменениями), `js/trips.js:100-108` (monkey-patch: после каждого рендера ещё `overlay()` с `cell.addEventListener('click', …)` на ячейки командировок, `js/trips.js:2284`)
- Доказательство:
  ```js
  matrixBody.innerHTML = bodyHTML;
  matrixBody.querySelectorAll('.day-cell-data').forEach(function(cell) {
    cell.addEventListener('click', handleCellClick);
    cell.addEventListener('mousedown', handleCellMouseDown);
    cell.addEventListener('mouseenter', handleCellMouseEnter);
    document.addEventListener('mouseup', handleCellMouseUp);   // N раз за рендер
    cell.addEventListener('mouseenter', handleCellHover);
    cell.addEventListener('mouseleave', function() { cellTooltip.style.display = 'none'; });
  });
  ```
  Замер на dev (headless Chromium через CDP, `render_probe.js`; БД: 42+4 сотрудника, 3 943 записи за 2026): 46 строк, 16 790 ячеек, `renderVacationMatrix()` — **474 / 540 / 619 мс** на три последовательных вызова, **100 786** вызовов `addEventListener` за один рендер. На объёме 150 сотрудников × 3 года (41 тыс. записей) первичная загрузка+рендер не завершились за 50 с (headless, нагруженный хост).
- Сценарий сбоя: каждый клик по ячейке, сохранение, poll-дельта от другого пользователя (`showToast('Матрица обновлена…')`) блокирует главный поток на ~0.5 с на рабочем ПК (дольше на слабых); при частых изменениях от коллег — заметные «фризы» во время выделения диапазона мышью. Утечки памяти нет: старые узлы и их обработчики уходят вместе с innerHTML, повторный `document.addEventListener` с той же функцией браузер игнорирует — но это ~16 тыс. лишних вызовов за рендер.
- Последствия: деградация отзывчивости UI пропорционально (сотрудники × 365); рост штата линейно ухудшает.
- Исправление (не применять): делегирование событий (один раз при инициализации) + точечное обновление строки.
  ```js
  // один раз, вне renderVacationMatrix():
  matrixBody.addEventListener('click', function (e) { var c = e.target.closest('.day-cell-data'); if (c) handleCellClick.call(c, e); });
  matrixBody.addEventListener('mousedown', function (e) { var c = e.target.closest('.day-cell-data'); if (c) handleCellMouseDown.call(c, e); });
  matrixBody.addEventListener('mouseover', function (e) { var c = e.target.closest('.day-cell-data'); if (c) { handleCellMouseEnter.call(c, e); handleCellHover.call(c, e); } });
  matrixBody.addEventListener('mouseleave', function () { cellTooltip.style.display = 'none'; });
  document.addEventListener('mouseup', handleCellMouseUp);
  // в renderVacationMatrix(): убрать циклы addEventListener (3655-3722);
  // вместо getDayVacationType/Record на каждую ячейку — заранее построить массив дней:
  var dayMap = new Array(totalDays + 1); (yearData[emp.id] || []).forEach(function (r) { for (var d = r.startDay; d <= r.endDay; d++) dayMap[d] = r; });
  // applyDelta: перерисовывать только строки затронутых сотрудников (renderEmployeeRow(empId)).
  ```
  Обработчики хэндлеров ожидают `this`/`event.currentTarget` = ячейка — проверить и адаптировать (`e.target.closest`).
- Уверенность: подтверждено на dev (замер) и по коду.
- Статус риска: —

### D-04 | Неограниченные выборки: load.php/export.php/reset.php/entries.php отдают все записи всех лет; все ответы API — JSON_PRETTY_PRINT
- Приоритет: P3
- Категория: D / C (неограниченные выборки, SELECT без пагинации)
- Место: `api/load.php:96-100` (`SELECT … FROM schedule_entries` без фильтра года), `api/export.php:80`, `api/reset.php:82`, `api/entries.php:58-75` (без параметров — вся таблица), `api/trips.php:388-397` (все командировки, N+1 — см. D-06), `api/helpers.php:44` (`JSON_PRETTY_PRINT` для всех ответов)
- Доказательство: замер (synth: 150 сотрудников, 41 025 записей за 3 года): load.php — 12.1 МБ за 0.16–0.8 с; export.php — 11.1 МБ; reset.php — 11.1 МБ; entries.php без параметров — 8.7 МБ; entries.php?year=2026 — 2.9 МБ. Полный `save.php` («эхо» без изменений, `time_save.sh`): 46 сотрудников/1 год — тело 715 КБ, 0.16–0.25 с; 154 сотрудника/3 года — **тело 7.3 МБ**, 1.6–2.6 с в одной транзакции записи (все остальные записи БД ждут, `busy_timeout`=5 с). `post_max_size` на JSON-тело не влияет (проверено `repro_pms.sh`: тело 714 583 Б при `post_max_size=512K` — PHP Warning в логе, но `php://input` читается и правка сохранена); фактический предел — `client_max_body_size` nginx-прокси Hostland (у nginx по умолчанию 1 МБ) и `LimitRequestBody` Apache — требует проверки. Отступы JSON_PRETTY_PRINT — заметная доля объёма (каждая запись — 9 строк с отступами). Прод: JSON сжимается nginx (`/api/session.php` → `Content-Encoding: br`), поэтому трафик умеренный; нагрузка — память/CPU PHP на `fetchAll` + построение массивов + `json_encode` в одном запросе.
- Сценарий сбоя: объём матрицы растёт каждый год (архив не отделяется), `load.php` выполняется при каждом открытии страницы и при конфликтах; через несколько лет полный дамп при `memory_limit` хостинга (обычно 128–256 МБ) начнёт падать Fatal, а `save.php` (полное состояние в теле, уже 715 КБ на 46 сотрудников за 1 год) — получать 413 от nginx-прокси при превышении `client_max_body_size`; автосохранение при этом перестаёт работать целиком.
- Последствия: постепенная деградация, в перспективе — отказ загрузки.
- Исправление (не применять):
  ```php
  // load.php — по умолчанию только текущий и соседние годы
  $y = (int) ($_GET['year'] ?? $year);
  $entryStmt = $pdo->prepare('SELECT employee_id, date, status, comment, approval_status, version, updated_at
                              FROM schedule_entries WHERE date BETWEEN :a AND :b');
  $entryStmt->execute([':a' => ($y - 1) . '-01-01', ':b' => ($y + 1) . '-12-31']);
  // helpers.php sendJson — компактный JSON
  echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
  ```
  Фронт при смене года догружает `entries.php?year=` (уже существует). Сопряжено с C-10 (индекс по `date`) и с логикой sync-удаления по годам payload в save.php.
- Уверенность: подтверждено на dev (замеры); прогноз роста — вероятно (реальный объём прод-БД неизвестен).
- Статус риска: —

### D-05 | Статика без Cache-Control и без версионирования (`js/storage.js`, `js/trips.js`, index.html): после деплоя браузеры могут исполнять старый JS по эвристическому кэшу — в т.ч. без freshness-протокола E10-6
- Приоритет: P2
- Категория: D (кэш-заголовки) / F
- Место: `index.html:2486-2487` (`<script src="js/storage.js">`, `<script src="js/trips.js">` — без `?v=`), отсутствие правил кэширования для статики (корневой `.htaccess` на прод не выкладывается — DEPLOY_HOSTLAND §1), `js/storage.js:509`/`:562` (`payload.clientLastSyncId = window.__syncCursor` — защита E10-6 работает только с новым фронтом; `api/save.php:135-136`: «Полное отсутствие поля = старый фронт: поведение прежнее»)
- Доказательство (анонимные GET к проду, 2026-10-25): `/`, `/index.html`, `/js/trips.js`, `/js/storage.js` → 200, `Content-Encoding: br` (gzip при `Accept-Encoding: gzip`), `ETag: W/"…"`, `Last-Modified`, `Vary: Accept-Encoding`, **нет `Cache-Control` и `Expires`**; условные запросы работают: `If-None-Match` → 304, `If-Modified-Since` → 304. Размеры передачи: `/` br 68 468 Б, gzip 103 815 Б; trips.js br 27 175 Б; storage.js br 6 985 Б.
- Сценарий сбоя: без `Cache-Control` браузеры применяют эвристическую свежесть (обычно 10% от возраста `Last-Modified`): файл, не менявшийся 20 дней, считается свежим ~2 дня **без** обращения к серверу. После деплоя часть пользователей продолжает работать со старыми `storage.js`/`index.html` (или со смесью новый index.html + старый storage.js). Если в старой версии нет отправки `clientLastSyncId` (до E10-6) или есть устранённый дефект — новый сервер работает в режиме совместимости, защита от «устаревших вкладок» отключена для этих клиентов.
- Последствия: непредсказуемое время раскатки исправлений фронта; повторение инцидентов класса E10 после деплоя исправлений.
- Исправление (не применять):
  ```html
  <!-- index.html: версия = короткий хеш коммита, проставляется при сборке пакета -->
  <script src="js/storage.js?v=101c846"></script>
  <script src="js/trips.js?v=101c846"></script>
  ```
  ```apache
  # js/.htaccess (новый файл, без php_flag; требует mod_headers на Hostland — проверить)
  <IfModule mod_headers.c>
    Header set Cache-Control "no-cache"
  </IfModule>
  ```
  Для `index.html` — отдельный минимальный корневой `.htaccess` только с `<Files "index.html"> Header set Cache-Control "no-cache" </Files>` (без `php_flag`), либо, если корневой `.htaccess` трогать нельзя, — `<meta http-equiv="Cache-Control">` не действует на HTTP-кэш, поэтому версионирование `?v=` обязательно. Дополнительно сервер может требовать минимальную версию клиента: `if (!isset($body['clientLastSyncId'])) → 409 client_outdated` в save.php.
- Уверенность: подтверждено запросом к проду (заголовки) и по коду; доступность mod_headers на Hostland — требует проверки.
- Статус риска: —

### D-06 | trips.php: N+1 при списке, посуточный цикл запросов в проверке пересечений без ограничения длины периода; второй поллер в trips.js
- Приоритет: P3
- Категория: D / C (N+1)
- Место: `api/trips.php:388-397` (GET: `SELECT id FROM trips` + `trips_fetch()` = 2 запроса на каждую командировку), `api/trips.php:154-182` (`trips_check_overlaps`: один SELECT на каждый день периода каждого участника; длина периода не ограничена — `trips_valid_date` проверяет только формат, `api/trips.php:79-87`), `js/trips.js:2123-2141` (`pollForChanges` — свой опрос `sync.php` каждые 20 с без проверки `document.hidden`; стартует только если `_state.lastSyncId > 0` на момент `init()` — `js/trips.js:143-145`)
- Доказательство: замер на dev — командировка 2000-01-01…2099-12-31 (36 525 дней) создаётся за 0.28 с (≈36.5 тыс. SELECT); период 0001…9999 ≈ 3.65 млн запросов ≈ 25–30 с одного PHP-процесса (экстраполяция). Список trips — 1 + 2N запросов (при текущих объёмах — миллисекунды).
- Сценарий сбоя: supervisor/admin (опечатка или намеренно) задаёт период в тысячи лет → запрос занимает воркер до `max_execution_time`; созданная «вечная» командировка затем раскрашивает матрицу каждого года. Поллер trips.js при старте (если `lastSyncId` уже известен) удваивает частоту `sync.php` и продолжает опрос в скрытых вкладках.
- Последствия: точечная нагрузка; сейчас низкая.
- Исправление (не применять):
  ```php
  // trips_validate_participants (trips.php ~209): ограничить длину периода
  if ((strtotime($endDate) - strtotime($startDate)) / 86400 > 366) { $errors[] = 'period_too_long'; }
  // trips_check_overlaps: один запрос на участника
  $stmt = $pdo->prepare("SELECT date, status FROM schedule_entries
      WHERE employee_id = :eid AND date BETWEEN :s AND :e AND status IN ('vacation','day_off') LIMIT 1");
  // trips.php GET: участники одним запросом
  $parts = $pdo->query('SELECT trip_id, employee_id, start_date, end_date FROM trip_participants ORDER BY trip_id, employee_id')->fetchAll(PDO::FETCH_GROUP|PDO::FETCH_ASSOC);
  ```
  В `js/trips.js:2126` — `if (document.hidden) { return setTimeout(pollForChanges, 20000); }` либо удалить собственный поллер в пользу общего SyncClient (`index.html:5631-5666`, который уже получает `tripsChanged`).
- Уверенность: подтверждено на dev (замер) и по коду; фактический запуск поллера trips.js — вероятно не запускается (lastSyncId=0 при init), не проверялось в браузере.
- Статус риска: —

## 4. Проверено, проблем не найдено

Блок C:
- foreign_keys на каждом соединении: единственный рабочий конструктор PDO — `api/db.php:521-530` (`PRAGMA foreign_keys = ON` + WAL + busy_timeout на каждом подключении); все эндпоинты получают PDO через `Database::getInstance()` (grep `new PDO` по api/*.php — вне db.php только `api/smoke_test.php`, см. C-06; корневой `test_fixes.php` использует `Database`). `PRAGMA foreign_key_check` на dev-копии — пусто, `integrity_check` — ok.
- Рассинхрон schema.sql ↔ миграции ↔ SCHEMA_VERSION: свежая БД из `schema.sql` и dev-БД, мигрированная v6→v8 через `Database::migrate()`, совпадают по колонкам/типам/DEFAULT/NOT NULL/PK/FK/индексам (13 таблиц, 0 расхождений, `schemadiff.php`); `SCHEMA_VERSION=8` (`db.php:33`) соответствует заголовку `schema.sql` (Version: 8) и ветке `$current < 8` (`db.php:246`). Колонки, используемые кодом trips/trip_requests (`trips.php`, `trip_relay.php`), присутствуют в обеих схемах. Отставание dev-БД в git — C-09.
- SQL через PDO: в просмотренных выборках/изменениях данные передаются через bind; конкатенации — только целые (`sync.php:234` `(int)$afterId`, `save.php:59` `(int)$maxId`), `$pdo->quote()` для годов (`save.php:615`), имена таблиц в `addColumnIfNotExists` — константы кода. (Безопасность целиком — блок A.)
- N+1 в save.php: по-записные `SELECT version …` (`save.php:428-450`) и предвыборка сотрудника (`save.php:265-271`) — prepared, по PK, внутри одной транзакции; эхо-сохранение 46 сотрудников/3 943 записи — 0.16–0.25 с. Кэш зон `$e82EmpScope` исключает повторные запросы.
- Индексы под реальные выборки: schedule_entries по сотруднику/дате — PK `(employee_id, date)` (EXPLAIN: SEARCH); sync_log по id — rowid (`WHERE id > ?` → SEARCH INTEGER PRIMARY KEY); trip_participants — PK `(trip_id, employee_id)` + `idx_trip_participants_emp`; trip_requests по статусу — `idx_trip_requests_status` (poll и анти-дубль в `trips.php:650-652` — SEARCH); audit_log по ts — `idx_audit_log_ts` (cleanup — SEARCH). Замечания по годовому фильтру — C-10.
- SELECT *: в рабочих путях только `auth.php:66` (`SELECT * FROM users WHERE id = :id LIMIT 1` — одна строка по PK; вынос `password_hash` в память процесса — вопрос A, не производительности); остальные выборки перечисляют колонки.
- Рост audit_log: очистка >7 дней срабатывает с вероятностью 1/20 на каждый `audit()` (`helpers.php:243-245`, `266-281`) по индексу `ts`; дополнительно в `migrate()` при смене версии (`db.php:195`, `277`). На dev-копии миграция удалила 5 556 устаревших строк — механизм работает. sync_log ротируется в save.php (проблема окна — C-01); trip_requests — C-08.
- wal_checkpoint: явных вызовов нет; используется автоматический checkpoint SQLite (1000 страниц). PHP-запросы короткие, долгоживущих читателей нет — WAL не растёт неограниченно (на проде `-wal` закрыт 403, размер не проверить). Рекомендация `journal_size_limit` — в C-08.
- Файл БД по вебу: `data/.htaccess` — `Require all denied`; прод (анонимный HEAD, 2026-10-25): `/data/app.db`, `/data/app.db-wal`, `/data/app.db-shm`, `/data/` → 403 (совпадает с 00_MAP §3). Права из DEPLOY_HOSTLAND §3 (755/644) — разумные; фактические права/владельцы на хостинге не проверены (см. §5).
- Пересоздание/перезапись прод-БД: `init_db.php` — CLI-guard (`init_db.php:20`; по вебу падает до подключения, 00_MAP), сам не удаляет файл (`rm -f data/app.db*` только в процедуре сборки staging, DEPLOY_HOSTLAND §2); `migrate()` — только `CREATE … IF NOT EXISTS`/`ALTER ADD COLUMN`, без DROP; `reset.php` — несмотря на имя, только чтение (`reset.php:38-116` — SELECT); `seed_positions.php` — main только под CLI (`seed_positions.php:88`); DEPLOY_HOSTLAND §4 явно исключает `data/app.db*` при обновлении. Разрушающие пути: `import.php` (C-03) и `smoke_test.php` (C-06).
- Бэкап при WAL: механизм `sqlite3 .backup` (online backup API) даёт согласованный снимок с учётом WAL — корректен; проблемы обвязки — C-07.

Блок D:
- Частота polling: `index.html:5666` — `setInterval(poll, 20000)` + `focus`; `poll()` пропускается в скрытой вкладке и при незавершённом предыдущем запросе (`index.html:5631`); `stop()` снимает и интервал, и focus-обработчик (`index.html:5671-5675`). Нагрузка: 1 запрос / 20 с на видимую вкладку → 30 активных пользователей ≈ 1.5 запроса/с; пустая дельта — 3 лёгких запроса (meta, users по PK, `MAX(id)`), 0.01 с на dev. Для shared-хостинга приемлемо; тяжёлый случай — большая дельта (C-02). Поллер trips.js — D-06.
- load.php: 0.16 с / 12 МБ на 41 тыс. записей, 0.025 с / 1.2 МБ на реалистичных 46 сотрудниках × 1 год — сам по себе не узкое место (объём — D-04).
- Генерация XLSX в `audit_export.php`: только admin; горизонт `?days` без верхней границы (`audit_export.php:43-46`), но таблица хранит ≤7 дней (очистка), выборка по индексу `ts`; ZipArchive во временный файл `tempnam()` с последующим `unlink` (`audit_export.php:266-284`); `Cache-Control: no-store` (`:72`). Нагрузочных рисков на текущих объёмах нет (на dev-копии ~5 тыс. строк журнала за 7 дней).
- Лимиты PHP, которые предполагает код: `ini_set`/`set_time_limit` нигде не используются; загрузка фото ограничена 2 МБ и на сервере (`upload.php:49`), и на клиенте (`index.html:5027`) — совместимо с типовым `upload_max_filesize=2M`; JSON-тело `save.php` не ограничено `post_max_size` (проверено, см. D-04), но может упереться в лимит тела nginx; `memory_limit` — зависит от объёма (D-04). Imagick-память вне `memory_limit` — D-01.
- Сжатие и условные запросы для `/`, `index.html`, `js/*.js` на проде: br/gzip включены, `ETag`/`Last-Modified` есть, `If-None-Match` и `If-Modified-Since` → 304 (не хватает только `Cache-Control` — D-05). Inline base64 в index.html нет (`grep -c 'data:image'` → 0; разбор `data:`-URI — 0 байт).
- Утечки таймеров: в index.html единственный `setInterval` (`:5666`) парный с `clearInterval` (`:5673`); глобальные обработчики кадрирования фото (`index.html:4942-4946`) и `document.addEventListener('click', …)` (`:4223`, `:5710`) регистрируются один раз при инициализации; в trips.js обработчики модалок снимаются (`trips.js:2689`, `:2891`). Утечки памяти обработчиков при перерисовке нет (узлы заменяются целиком); избыточность — D-03.

## 5. Что не удалось проверить

- Реальный объём прод-БД (число сотрудников/записей/строк sync_log, audit_log, trip_requests, размер файла и `-wal`) — доступ к БД/SSH запрещён; замеры сделаны на синтетике (46 и 154 сотрудника).
- PHP-конфигурация прода (`memory_limit`, `max_execution_time`, `upload_max_filesize`, `post_max_size`, наличие Imagick или GD, версия SQLite в PHP 8.1) — нужен `phpinfo()` под авторизацией; `client_max_body_size` nginx-прокси и `LimitRequestBody` Apache — неизвестны (D-01, D-04).
- Бэкапы: настроено ли задание в планировщике Hostland, от какого пользователя выполняется, владельцы/права `data/app.db*`, наличие и целостность файлов в `~/backups`, версия `sqlite3` CLI (C-07).
- Доступность `mod_headers` на Hostland для правил кэширования (D-05).
- Рендер матрицы в целевых браузерах на рабочих ПК (замер только в headless Chromium на нагруженном сервере); профиль рендера на 150 сотрудниках × 3 года не завершён за 50 с в headless — не удалось отделить время рендера от загрузки.
- Гонка параллельных миграций (C-09) не воспроизводилась; GD-путь `upload.php` отдельно не изолировался (на dev загружен Imagick).
- Сторона RPA-робота HelpMe (C-05): создаёт ли он заявку по payload удалённой командировки.

## 6. Передано в A

- `index.html:1994` — статичный снимок матрицы (42 ФИО + должности в `title`, 1 115 ячеек отпусков) зашит в index.html, отдаётся анонимно (`GET /` на проде → 200, тот же размер/ETag, что у файла @101c846) — утечка ПДн без авторизации; с базового коммита `aa16c93`, т.е. и в git-истории.
- `index.html:3608` — `emp.name` и `emp.role` вставляются в `innerHTML` матрицы без экранирования (хранимый XSS через ФИО/должность).
- `api/save.php:582` — supervisor в своей зоне может записать `approval_status` из тела (`approved`), т.е. сам «утвердить» trip/day_off (mass assignment; проверка статуса есть только для `status`, `save.php:491-502`).
- `api/upload.php:162-176` — аудит `photo.upload` никогда не пишется: `sendJson()` завершает скрипт (`helpers.php:45` `exit`) до блока аудита.
- `DEPLOY_HOSTLAND.md:79` — процедура обновления копирует весь `api/` (`cp -a /tmp/scnew/api …`), включая `smoke_test.php`, `debug_token.php`, `init_db.php`, `seed_positions.php`.
- `index.html:5` — внешняя загрузка Google Fonts (передача IP пользователей третьей стороне при каждом открытии).

## 7. Самопроверка

- C-01: защиты уровнем выше нет — freshness-кэш строится только из `sync_log` (`save.php:151-174`), гард E10-4 срабатывает лишь от 10 сотрудников (`save.php:636`), E10-2 касается только employees; sync.php не сверяет курсор с `MIN(id)`. Проектным решением не задокументировано (schema.sql:122 описывает ротацию, но не её взаимодействие с E10-6). Воспроизведено на dev с контролем.
- C-03: `require_admin` (`import.php:33`) — не защита от дефекта (сценарий штатный для admin); транзакция не спасает — CASCADE выполняется внутри неё и коммитится. Воспроизведено.
- C-02: guard'ов нет, затрагивает любого аутентифицированного пользователя; EXPLAIN + замер.
- C-04: валидации выше по стеку для admin нет (supervisor ограничен по `status`, но не по `date`/`approval_status`); фронт-валидация не считается.
- C-05: в trips.php DELETE и trip_relay poll нет проверки существования trip; FK отсутствует в обеих схемах.
- C-06: `SC_APP_DB` поддерживается только db.php; тест им не пользуется. На проде — блокируется только неудачным стартом `php -S` (00_MAP), не намеренной защитой.
- C-07: помечено «требует проверки» — выводы о правах/пользователях не подтверждены доступом к хостингу.
- C-08…C-10, D-04, D-06: P3 — без немедленного вреда, подтверждены кодом/EXPLAIN/замерами.
- D-01: `require_edit` (`upload.php:38`) ограничивает круг до supervisor/admin — учтено в приоритете (P2, не P1); защиты по пикселям нет ни в коде, ни в `.htaccess`.
- D-02/D-05: подтверждены анонимными GET/HEAD к проду; кэш-правил для статики нет — корневой `.htaccess` на прод не выкладывается (DEPLOY_HOSTLAND §1).
- D-03: замер в браузере; утечку обработчиков проверял отдельно — не подтверждена (в отчёте прямо указано), находка — про стоимость рендера.
- Отклонённые гипотезы: «inline base64 раздувает index.html» — нет (0 data-URI); «post_max_size обрежет тело save.php и даст тихий успех» — не подтвердилось (JSON-тело читается из `php://input`); «audit_log растёт без ограничений» — нет (вероятностная очистка работает).

## Не завершено

—

## Рабочие заметки (сырые данные замеров)

- Скрипты замеров/воспроизведения (scratch, вне репозитория): `/home/hermes/.hermes/profiles/sd_worker_02/cache/scratch/cd/` — `repro.sh` (C-01), `repro_import.sh` (C-03), `repro_upload.sh` (D-01), `repro_pms.sh` (post_max_size), `time_save.sh`, `render_probe.js` (D-03), `schemadiff.php`, `eqp1.sql` (EXPLAIN), `htmlsize.php`/`snapshot.php` (D-02). Все работали на копиях БД через `SC_APP_DB`; `data/app.db` worktree не изменялась.
- dev-БД `data/app.db` @101c846: schema_version=6 (код ожидает 8; миграция v7/v8 выполняется первым запросом), journal_mode=wal, auto_vacuum=0, page_size=4096, page_count=411 (1.68 МБ), freelist=0, integrity_check=ok, foreign_key_check — пусто. Строк: employees 4, schedule_entries 1, sync_log 7 709, audit_log 5 608 (на копии миграция сразу удалила 5 556 старше 7 дней), trips 0, trip_requests — таблицы нет (v6).
- dbstat dev-копии: audit_log 729 КБ + idx_audit_log_ts 213 КБ, sync_log 537 КБ + idx_sync_log_id 94 КБ — журналы занимают ~95% файла.
- Сравнение схемы: свежая БД из schema.sql vs мигрированная v6→v8 — 13/13 таблиц, 0 расхождений по колонкам/FK/индексам (scratch `schemadiff.php`). CHECK-ограничений в schema.sql — 0.
- Замеры HTTP (synth, 41 025 entries): load.php 12.1 МБ / 0.16 с; export.php 11.1 МБ / 0.15 с; reset.php 11.1 МБ; entries.php (без параметров) 8.7 МБ / 0.12 с; entries.php?year=2026 2.9 МБ; sync.php?afterId=0 230 КБ / 12.9–14.0 с.
