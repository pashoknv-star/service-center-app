# AUDIT-2026-10 — Блок B: Корректность и надёжность

Исполнитель: sd_worker_01. Базовый коммит: 101c846 (worktree /home/hermes/audit-wt/w1, dev-порт 8091).
Статус: ЗАВЕРШЁН. Все проверки на dev выполнены на КОПИИ dev-БД ($TMPDIR, через `SC_APP_DB`); data/app.db worktree не менялась, `git status --porcelain` пуст, dev-сервер остановлен. К проду — только один анонимный GET статического файла js/trips.js.

## 1. Резюме

Найдено 23 дефекта: P0 — 0, P1 — 9, P2 — 11, P3 — 3. Главный класс рисков — тихая потеря/порча данных при конкурентной работе: все пишущие транзакции открываются как deferred BEGIN, и параллельные сохранения мгновенно получают 500 «database is locked» (B-07, воспроизведено), а фронт ошибки сохранения не показывает (B-04); устаревшая вкладка admin по-прежнему откатывает карточки сотрудников и «воскрешает» удалённых (B-17 — E10-6 закрыл только удаление), неудачный load.php включает сохранения из localStorage без курсора (B-01).
Подсистема командировок: создание/правка из UI на проде сломаны ReferenceError (B-19, файл на проде идентичен); заявки HelpMe теряются при подтверждении двух командировок в одну секунду (B-09), не отзываются при удалении/правке (B-10), обходятся через PUT status (B-12); восстановление из export.php стирает всех участников командировок (B-18).
Миграции при первом запросе не сериализованы — 500 и дубли legacy-командировок при параллельных запросах (B-06, проверится на следующем повышении схемы). Серверная валидация полей в save.php, vacation_import.php и trips.php неполная (B-08, B-14, B-16). Совместимость с PHP 8.1 — проблем не найдено.
Немедленно (следующая фаза): B-19, B-07 (+B-04), B-17, B-09/B-10, B-18 (до любого восстановления из бэкапа).

## 2. Таблица находок

| ID | P | Категория | Место | Заголовок | Уверенность |
|---|---|---|---|---|---|
| B-01 | P1 | B | js/storage.js:459-491; index.html:5306-5329 | Сбой load.php → тихий откат на localStorage, сохранения без курсора свежести | подтверждено по коду |
| B-02 | P1 | B | js/storage.js:359-371; index.html:3502-3519 | Конверсия legacy↔server стирает комментарии и смешивает approval соседних диапазонов | подтверждено на dev |
| B-06 | P1 | B | api/db.php:100-138, 292-439 | Миграции без транзакции/блокировки: 500 и дубли legacy-командировок | подтверждено на dev |
| B-07 | P1 | B | api/save.php:69; trips.php:435,582,630,807; sync.php:106; trip_relay.php:118; import.php:50; vacation_import.php:425 | Deferred BEGIN: параллельные записи мгновенно падают с 500 «database is locked» | подтверждено на dev |
| B-09 | P1 | B | api/helpers.php:113-116; api/trips.php:678-695 | request_id не уникален между командировками — заявка HelpMe тихо не создаётся | подтверждено на dev |
| B-10 | P1 | B | api/trips.php:578-605, 714-886; api/trip_relay.php:120-141 | Очередь RPA не отражает удаление/правку подтверждённой командировки | подтверждено на dev |
| B-17 | P1 | B | api/save.php:250-289; api/employees.php:261-273 | Устаревшая вкладка перезаписывает карточки и воскрешает удалённых сотрудников | подтверждено на dev |
| B-18 | P1 | B | api/import.php:50-171; api/export.php | Восстановление из export стирает всех участников командировок | подтверждено на dev |
| B-19 | P1 | B | js/trips.js:1655 | ReferenceError `phoneEl` — создание/правка командировок из UI невозможны (прод) | подтверждено на dev и запросом к проду |
| B-03 | P2 | B | index.html:5424-5433 | Дельта sync не применяет смену статуса согласования | подтверждено по коду |
| B-04 | P2 | B | js/storage.js:522-533, 571-582; index.html:3343-3360, 5638-5657 | Ошибки save и 401 не видны пользователю | подтверждено по коду |
| B-05 | P2 | B | api/load.php:99, 153 | Курсор lastSyncId читается после данных — пропуск изменений | подтверждено по коду |
| B-08 | P2 | B | api/save.php:439-455, 565-586, 736-796 | Нет валидации полей записей/праздников/балансов/года; одна битая запись → 500 всего save | подтверждено на dev |
| B-11 | P2 | B | api/trip_relay.php:133-142, 194-206 | Relay: at-most-once без повторной выдачи; callback last-write-wins теряет ticket_id | подтверждено на dev |
| B-12 | P2 | B | api/trips.php:716-754, 829-852 | PUT status=confirmed обходит ?action=confirm — заявки не создаются | подтверждено на dev |
| B-13 | P2 | B | api/trips.php:548, 724-733, 807-852 | Проверка версии trips вне транзакции — потерянное обновление | подтверждено по коду |
| B-15 | P2 | B | api/vacation_import.php:195-210, 374-403 | Перенос отпуска оставляет призрачные дни; импорт не идемпотентен | подтверждено на dev |
| B-16 | P2 | B | api/vacation_import.php:299-301, 341-342 | date_create молча сдвигает несуществующие/неоднозначные даты; статусы не валидируются | подтверждено на dev |
| B-20 | P2 | B | js/trips.js:249, 299, 332, 371-406, 2123-2141; api/sync.php:42-82 | Курсор трипов := версия командировки; дельта без RPA-полей | подтверждено по коду |
| B-21 | P2 | B | api/save.php:55-61, 151-174; api/sync.php:207-235 | Ротация sync_log без обнаружения разрыва обходит E10-6 | подтверждено по коду |
| B-14 | P3 | B | api/trips.php:79-87, 193-225, 247-288, 414-420 | Неполная валидация trips (2026-02-30, дубли участников → 500, аванс, телефон) | подтверждено на dev |
| B-22 | P3 | B | api/helpers.php:85-88, 266-282; api/db.php:358, 480-494 | Смешение date('c')/gmdate в строковых сравнениях ts; NULL ts в audit_log | подтверждено по коду / требует проверки TZ прода |
| B-23 | P3 | B | api/holidays_provider.php:46-123 | Календарь вне 2026–2028 — молчаливый упрощённый fallback | подтверждено по коду |

## 3. Детальные находки

### B-01 | Сбой load.php → тихий откат на localStorage и разрешение серверных сохранений без курсора свежести
- Приоритет: P1
- Категория: B (фронтенд-синхронизация, потеря данных), CWE-754 (неправильная проверка исключительных условий)
- Место: js/storage.js:459-491 (load() никогда не бросает — при любом !ok/сети возвращает readLegacyFromLocalStorage()); index.html:5306-5329 (initFromServer: `window.__serverStateLoaded = true` выставляется безусловно); index.html:2592-2607 (showApp: флаг ставится, если в «ответе» есть employees — в т.ч. из localStorage).
- Доказательство:
  ```js
  // js/storage.js:486-490
  } catch (err) { _serverReachable = false; ...; return readLegacyFromLocalStorage(); }
  // index.html:5309-5321
  const serverData = await StorageAdapter.load();
  if (serverData && serverData.employees && serverData.employees.length > 0) { employees = serverData.employees; ... }
  if (serverData && serverData.vacationData) { vacationData = serverData.vacationData; ... }
  window.__serverStateLoaded = true; // server state applied — server saves allowed
  ```
  readLegacyFromLocalStorage() не возвращает lastSyncId → `window.__syncCursor` остаётся null → save.php не получает `clientLastSyncId` → гард свежести E10-6 выключен. При этом localStorage реально содержит матрицу: StorageAdapter.save()/saveVacation() пишут ключ `vacation_data_v3` (storage.js:443, 547), вопреки комментарию index.html:3325-3328.
- Сценарий сбоя (роль admin): 1) admin открывает вкладку; load.php отвечает 5xx/таймаутом (Hostland nginx 502/504, SQLITE_BUSY во время миграции — см. B-06, сетевой сбой); 2) вкладка молча рисует копию из localStorage этого браузера (может быть многодневной давности), «anti-wipe» флаг поднят; 3) admin правит одну ячейку → saveVacationData() → полный payload из устаревшего состояния без clientLastSyncId; 4) save.php: у admin проверка версий отключена (save.php:517), stale-value гард требует курсор (save.php:537-541) → все записи, изменённые после снимка localStorage, перезаписываются старыми значениями; записи, добавленные позже, удаляются sync-delete, если затронуто <10 сотрудников (save.php:636); карточки сотрудников откатываются (гард E10-2 ловит только массовое обнуление photo/location).
- Последствия: тот же класс инцидентов, что E10 (откат/стирание календаря и карточек), остаётся открытым через путь «неудачная первая загрузка». Потеря данных на проде без ошибок в UI.
- Исправление (не применять):
  ```js
  // js/storage.js load(): различать сервер и fallback
  } catch (err) {
    _serverReachable = false;
    var fb = readLegacyFromLocalStorage();
    fb.fromFallback = true;               // НЕ серверное состояние
    return fb;
  }
  // index.html initFromServer() и showApp():
  const serverData = await StorageAdapter.load();
  if (!serverData || serverData.fromFallback || typeof serverData.lastSyncId !== 'number') {
    showToast('Сервер недоступен — редактирование заблокировано до перезагрузки', 'error');
    return;                                // __serverStateLoaded остаётся false
  }
  ... window.__serverStateLoaded = true; window.__syncCursor = serverData.lastSyncId;
  ```
  Дополнительно на сервере: для полного save.php от admin при отсутствии `clientLastSyncId` отключать sync-delete (как для «старого фронта», которого после E10-6 уже нет).
- Уверенность: подтверждено по коду (цепочка вызовов прослежена полностью).
- Статус риска: —

### B-02 | Конверсия legacy↔server стирает комментарии и смешивает статус согласования соседних диапазонов
- Приоритет: P1
- Категория: B (логическая ошибка, целостность данных), CWE-1284/CWE-704
- Место: js/storage.js:365-370 (`comment: ''` всегда; approvalStatus из флага диапазона); js/storage.js:115-141 и index.html:3502-3519 (mergeAdjacentRanges склеивает по `type`, игнорируя `approved` и `comment`).
- Доказательство:
  ```js
  // js/storage.js:359-371
  var entry = { employeeId: serverEmpId, date: date, status: ..., comment: '',
                approvalStatus: r.approved ? 'approved' : 'draft' };
  // index.html:3507  if (prev.type === curr.type && prev.endDay + 1 >= curr.startDay) { prev.endDay = ...; ranges.splice(i,1); }
  ```
  Проверено на dev (node, js/storage.js в vm, скрипт probe): сервер отдаёт emp_1 2026-03-02 vacation approved «приказ 12-к» v3, 03-03 и 03-04 vacation draft v1. Результат serverToLegacy → legacyToServer:
  ```
  legacy ranges: [{"startDay":61,"endDay":63,"type":"vacation","version":3,"comment":"приказ 12-к","approved":true}]
  emp_1:2026-03-02 status=vacation comment="" approval=approved
  emp_1:2026-03-03 status=vacation comment="" approval=approved   <- был draft
  emp_1:2026-03-04 status=vacation comment="" approval=approved   <- был draft
  ```
- Сценарий сбоя (роль admin): 1) комментарий к записи внесён через vacation_import.php (поле comment, vacation_import.php:300) или entries.php; либо смежные дни одного типа имеют разный approval; 2) admin делает любую правку в матрице → полный save; 3) save.php no-op проверка (save.php:567-572) видит другой comment/approval → перезаписывает: комментарии становятся '', draft-дни смежного approved-диапазона становятся approved (или наоборот: approved-дни после draft-диапазона становятся draft, т.к. объединённый диапазон берёт флаг предыдущего).
- Последствия: потеря комментариев (основания/номера приказов); неконтролируемое изменение статуса согласования. Понижение approved→draft снимает approved-guard и открывает запись для правки supervisor'ом; повышение draft→approved фиксирует несогласованные дни. Комментарий из UI (index.html:3439 `newRange.comment`) на сервер вообще не доходит. Для supervisor склейка поднимает entryVersion соседних дней до максимума диапазона → ложные конфликты (save.php:517) и «откат» его правок.
- Исправление (не применять): в обоих mergeAdjacentRanges склеивать только при совпадении `type`, `!!approved` и `(comment||'')`; в legacyToServer передавать `comment: r.comment || ''`; версии брать из по-дневной карты (уже так) — склейка версий тогда не нужна:
  ```js
  if (prev.type === curr.type && !!prev.approved === !!curr.approved
      && (prev.comment || '') === (curr.comment || '') && prev.endDay + 1 >= curr.startDay) { ... }
  // legacyToServer:
  comment: r.comment ? String(r.comment) : '',
  ```
- Уверенность: подтверждено на dev (node-проба storage.js); для index.html-версии merge — по коду (идентичное условие).
- Статус риска: —

### B-03 | Дельта sync не применяет смену статуса согласования (fast-path сравнивает только type и comment)
- Приоритет: P2
- Категория: B (фронтенд-синхронизация)
- Место: index.html:5424-5433 (applyServerEntry fast-path).
- Доказательство:
  ```js
  if (doy >= same.startDay && doy <= same.endDay && same.type === entry.status &&
      (same.comment || '') === (entry.comment || '')) {
    same.version = Math.max(..., ver); return false;   // approvalStatus не сравнивается
  }
  ```
- Сценарий сбоя: admin A согласует диапазон (approved, version+1). Вкладка admin B получает дельту: тип и комментарий совпадают → обновляется только версия, флаг `approved` остаётся прежним, курсор сдвигается (index.html:5649-5651). Следующий полный save вкладки B отправляет approvalStatus 'draft' с актуальной версией; у admin проверка версий отключена, stale-value гард не срабатывает (ключ уже «старше» курсора) → согласование тихо откатывается.
- Последствия: откат согласований, снятие approved-guard; без следов в UI.
- Исправление: добавить в условие fast-path `!!same.approved === (entry.approvalStatus === 'approved')`.
- Уверенность: подтверждено по коду.
- Статус риска: —

### B-04 | Ошибки сохранения и истёкшая сессия (401) не видны пользователю — правки теряются молча
- Приоритет: P2
- Категория: B (обработка ошибок, фронтенд), CWE-390
- Место: js/storage.js:522-533, 571-582 (save/saveVacation никогда не reject'ят: при !resp.ok → `{success:false, fallback:true}`); index.html:3343-3360 (toast только в `.catch`, который не наступает); index.html:5251-5264 (save() — то же); index.html:5638-5657 (poll: `Promise.reject(r.status)` → `.catch(function () {})`, 401 игнорируется).
- Доказательство:
  ```js
  // index.html:3343
  return StorageAdapter.saveVacation(vacationData).then(result => { ...merge...; return result; })
    .catch(e => { showToast('Не удалось сохранить матрицу отпусков', 'error'); ... });
  ```
- Сценарий сбоя (любая роль с правом записи): вкладка была скрыта дольше `session.gc_maxlifetime` (polling при `document.hidden` не идёт, index.html:5632, сессия не продлевается) → PHP удаляет сессию → пользователь возвращается и редактирует → save.php отвечает 401 → в UI тишина, правки лишь в localStorage этого браузера → при следующей загрузке server-state их затирает (или, хуже, они «всплывут» через B-01). Аналогично для 403/409/500 (в т.ч. SQLITE_BUSY — B-07).
- Последствия: потеря правок без уведомления; пользователь уверен, что данные сохранены.
- Исправление: в StorageAdapter.save/saveVacation при `!resp.ok` бросать ошибку с кодом (`var e = new Error('HTTP '+resp.status); e.status = resp.status; throw e;`) и в вызывающем коде показывать toast; при `status === 401` — `showLogin()` с сохранением несохранённого payload и повторной отправкой после входа; в poll() при 401 — `SyncClient.stop(); showLogin();`.
- Уверенность: подтверждено по коду.
- Статус риска: —

### B-05 | load.php отдаёт курсор lastSyncId, прочитанный ПОСЛЕ данных и вне транзакции — пропуск изменений
- Приоритет: P2
- Категория: B (конкурентность/синхронизация), CWE-362
- Место: api/load.php:99 (SELECT schedule_entries) … api/load.php:153 (`SELECT COALESCE(MAX(id),0) FROM sync_log`), без beginTransaction.
- Доказательство: курсор читается последним, отдельным autocommit-запросом.
- Сценарий сбоя: вкладка X грузит load.php; между чтением entries (стр. 99) и MAX(id) (стр. 153) другая вкладка коммитит save.php (запись Z + sync_log id=N). Клиент получает entries без Z, но курсор ≥ N → poll с afterId=N никогда не вернёт Z; E10-6 считает, что клиент «видел» Z → при следующем полном save (admin) запись Z перезаписывается/удаляется sync-delete без блокировки.
- Последствия: точечная тихая потеря чужого изменения (окно — миллисекунды-десятки мс на каждую загрузку; растёт с размером БД на shared-хостинге).
- Исправление: читать курсор ПЕРВЫМ (консервативно — повтор событий безопасен, sync.php так и делает, стр. 220) и/или обернуть все SELECT в одну read-транзакцию:
  ```php
  $pdo->beginTransaction();               // в WAL — единый снимок для всех SELECT
  $lastSyncId = (int) $pdo->query('SELECT COALESCE(MAX(id),0) FROM sync_log')->fetchColumn();
  ... все SELECT ...
  $pdo->commit();
  ```
- Уверенность: подтверждено по коду (воспроизведение требует точного тайминга — не выполнялось).
- Статус риска: —

### B-06 | Миграции при первом запросе: без транзакции и блокировки — параллельные запросы получают 500 и дублируют legacy-командировки
- Приоритет: P1
- Категория: B (миграции/конкурентность), CWE-362, CWE-667
- Место: api/db.php:100-138 (migrate(): schema.sql + applyIncrementalMigrations + setMeta — каждый оператор в autocommit, без BEGIN и без мьютекса); api/db.php:292-301 (флаг `trips_legacy_migrated` читается без блокировки, `$flagStmt` не закрыт — держит read-snapshot); api/db.php:401-419 (INSERT trips/participants по одному, без транзакции); api/db.php:448-458 (addColumnIfNotExists: check-then-ALTER); api/db.php:431-437 (комментарий «без дублей» неверен — повторный SELECT по schedule_entries вернёт те же строки).
- Доказательство:
  ```php
  // db.php:295-301
  $flagStmt->execute();
  if ($flagStmt->fetch(PDO::FETCH_COLUMN)) { return; }   // нет блокировки, курсор не закрыт
  // db.php:401-410 — каждый INSERT в autocommit
  foreach ($runs as $run) { $tripId = uniqid('trip_', true); ... $stmtTrip->execute(); ... }
  ```
  Воспроизведено на dev (копия dev-БД в $TMPDIR, `SC_APP_DB`, `PHP_CLI_SERVER_WORKERS=8`, порт 8091): schema_version=6 (как в git-копии dev-БД), флаг `trips_legacy_migrated` снят, 9 legacy-записей `trip` (3 сотрудника × 3 дня). 12 одновременных POST /api/login.php (неверный логин — migrate() вызывается до проверки пароля, login.php:36):
  ```
  3 × HTTP 500 {"error":"Server error: SQLSTATE[HY000]: General error: 5 database is locked"} (через 0,55 с — busy_timeout=5000 не помог)
  итог: schema=8, legacy trips = 5 вместо 3; trip_participants: (emp_*, 2026-11-02) × 2, (emp_*, 2026-11-02) × 2, × 1
  ```
  В другой итерации 11 из 12 запросов получили 500. Причина мгновенного SQLITE_BUSY: соединение держит read-транзакцию (незакрытый `$flagStmt`/`$empExistsStmt`) и пытается писать после чужого коммита — SQLite в WAL возвращает BUSY без ожидания (иначе deadlock).
- Сценарий сбоя: выкладка релиза с повышением SCHEMA_VERSION (или первый запуск на БД со старой версией) → несколько вкладок/сотрудников и робот (trip_relay poll) одновременно делают запросы → часть получает 500 (у пользователей — «ошибка сервера» на логине/загрузке), legacy-командировки создаются в двух экземплярах (дубли в журнале командировок, дубли RPA-заявок при последующем confirm). При ALTER-гонке второй запрос получает «duplicate column name» → 500. Частично применённая миграция (упало после части ALTER до setMeta) повторится — ALTER идемпотентны, а INSERT legacy — нет.
- Последствия: дубли командировок (ПДн маршрутов/дат в двух экземплярах, двойные заявки HelpMe), 500 у пользователей в окне деплоя. На проде текущая версия уже v8 → риск проявится на следующем повышении схемы (v9).
- Исправление (не применять): сериализовать миграцию эксклюзивной транзакцией и перепроверять версию внутри неё:
  ```php
  public function migrate(): bool
  {
      if ($this->getSchemaVersion() >= self::SCHEMA_VERSION) { return true; }
      $this->pdo->exec('BEGIN IMMEDIATE');            // ждёт busy_timeout, один мигратор
      try {
          $current = $this->getSchemaVersion();         // double-check под блокировкой
          if ($current < self::SCHEMA_VERSION) {
              $this->pdo->exec($sql);                   // DDL в SQLite транзакционен
              $this->applyIncrementalMigrations($current); // migrateLegacyTrips без собственного commit
              $this->setMeta('schema_version', (string) self::SCHEMA_VERSION);
          }
          $this->pdo->exec('COMMIT');
      } catch (Throwable $e) { $this->pdo->exec('ROLLBACK'); throw $e; }
      return true;
  }
  ```
  Плюс: `$flagStmt->closeCursor()` / `fetchAll()` вместо `fetch()`; `PRAGMA busy_timeout` выставлять ДО `PRAGMA journal_mode` в connect() (db.php:528-530); в catch migrateLegacyTrips убрать вводящий в заблуждение комментарий.
- Уверенность: подтверждено на dev (500 и дубли воспроизведены; dev-БД не затронута — работа на копии).
- Статус риска: —

### B-07 | Все записи идут через deferred BEGIN: параллельные сохранения мгновенно падают с 500 «database is locked» (busy_timeout не работает)
- Приоритет: P1
- Категория: B (конкурентность SQLite), CWE-362, CWE-833
- Место: api/save.php:69 (`$pdo->beginTransaction()`), чтения до первой записи — save.php:155-172 (freshness-кэш sync_log), 447-450 (`$stmtVer` SELECT), 465 (scope SELECT); аналогично api/trips.php:435, 582, 630, 807; api/sync.php:106; api/trip_relay.php:118; api/import.php:50; api/vacation_import.php:425. PDO::beginTransaction() в SQLite = `BEGIN DEFERRED`.
- Доказательство:
  ```php
  // save.php:69, 447-450
  $pdo->beginTransaction();                 // DEFERRED: блокировка не берётся
  ... $stmtVer->execute(); $serverRow = $stmtVer->fetch();   // read-snapshot
  ... $stmtEn->execute();                   // апгрейд read→write: при чужом коммите — SQLITE_BUSY сразу
  ```
  Воспроизведено на dev (копия БД, 8 воркеров php -S, порт 8091), payload — по одной записи day_off у разных сотрудников (2027-12), разные сессии, общий clientLastSyncId:
  ```
  6 параллельных save.php (supervisor_zone0): 5 × HTTP 500 "SQLSTATE[HY000]: General error: 5 database is locked" за 0,02 с, 1 × 200
  2 параллельных save.php: в 1 из 3 повторов — 500 у одного из двух
  3 параллельных save.php (admin): 1 × 500
  vacation_import.php параллельно с 2 save.php (5 повторов): 1-3 × 500 у импорта, в т.ч.
    "Server error during import: SQLSTATE[HY000]: General error: 5 cannot commit transaction - SQL statements in progress"
    (незакрытые курсоры: vacation_import.php:63-65 токен, 244-245 $stmtCheckEmp->fetch()), и 500 у save.php
  ```
  Время отказа 0,00-0,02 с при busy_timeout=5000 — SQLite не вызывает busy-handler при апгрейде read-транзакции в WAL (BUSY_SNAPSHOT/deadlock-avoidance).
- Сценарий сбоя: два сотрудника (или две вкладки одного) одновременно правят матрицу; каждая правка = полный save.php (секунды на prod-объёме — длинная транзакция расширяет окно); плюс фоновые записи trip_relay callback/poll и vacation_import. Один запрос получает 500.
- Последствия: в связке с B-04 (фронт не показывает ошибку save) правка тихо теряется; vacation_import/trip_relay получают 500 → повтор внешней системой (идемпотентность — см. B-11, B-15). Частота растёт с числом пользователей и временем транзакции.
- Исправление (не применять): брать write-lock в начале всех пишущих транзакций и переиспользовать busy_timeout:
  ```php
  // api/helpers.php
  function begin_write(PDO $pdo): void { $pdo->exec('BEGIN IMMEDIATE'); }
  function commit_write(PDO $pdo): void { $pdo->exec('COMMIT'); }
  function rollback_write(PDO $pdo): void { try { $pdo->exec('ROLLBACK'); } catch (Throwable $e) {} }
  // save.php:69 и прочие места: begin_write($pdo) вместо $pdo->beginTransaction(),
  // commit_write/rollback_write вместо commit()/rollBack() (inTransaction() в PDO после exec('BEGIN') на PHP 8.1 не отслеживается — не смешивать).
  ```
  Дополнительно: на 500 с «database is locked» отдавать 503 + `Retry-After: 1`, а во фронте (StorageAdapter.save) один автоматический повтор.
- Уверенность: подтверждено на dev.
- Статус риска: —

### B-08 | save.php не валидирует поля записей календаря, праздников, балансов и года
- Приоритет: P2
- Категория: B (валидация входных данных), CWE-20
- Место: api/save.php:439-444 (employeeId/date — только `!== null`), 455 и 581 (status пишется как есть, допускается NULL), 565/582 (comment без ограничения длины), 566/583 (approvalStatus — любая строка), 748-756 (holidays: date/type не проверяются), 777-786 (vacationBalances: отрицательные/нечисловые → (float)), 794-796 (`(int)'abc'` → current_year=0); схема без CHECK (api/schema.sql:60-70).
- Доказательство (dev, admin, один POST /api/save.php → HTTP 200, записано в БД):
  ```
  emp_1|2027-02-30|'zzz_status'|len(comment)=100000|approval=maybe
  emp_1|2027-1-5|status=NULL|draft
  emp_1|2027-12-31T23:00|'vacation'|draft
  {"year":"abc"} → meta.current_year = 0
  ```
  Неизвестный employeeId (`emp_does_not_exist`) → FK violation → HTTP 500 и откат ВСЕГО полного сохранения (одна «битая» запись в payload блокирует сохранение матрицы целиком).
- Сценарий сбоя: ошибка/рассинхрон фронта, ручной вызов API или устаревшая вкладка с удалённым сотрудником присылают такие значения. Даты вне формата `YYYY-MM-DD` не попадают под sync-delete (`date LIKE 'YYYY-%'` найдёт «2027-1-5», но матрица по doy их не покажет → «невидимые» записи; '2027-02-30' ломает расчёты дней/отпускных остатков); NULL-статус и неизвестные статусы отображаются как пустые ячейки, но выгружаются в export/HelpMe; 100 КБ-комментарии раздувают load.php/sync.php для всех.
- Последствия: порча данных календаря, «невидимые» записи, 500 на полном сохранении из-за одной записи.
- Исправление (не применять): единый валидатор в helpers.php и вызов в начале цикла entries (save.php:434), holidays, balances; отклонённые записи — в `rejections[]`:
  ```php
  function valid_ymd($d): bool {
      if (!is_string($d) || !preg_match('/^\d{4}-\d{2}-\d{2}$/', $d)) return false;
      [$y, $m, $dd] = array_map('intval', explode('-', $d));
      return checkdate($m, $dd, $y) && $y >= 2000 && $y <= 2100;
  }
  const ENTRY_STATUSES = ['vacation','sick','trip','day_off','dayoff','study','other']; // свести с фронтом
  const APPROVAL_STATUSES = ['draft','approved'];
  // save.php, начало тела foreach entries:
  if (!valid_ymd($date) || !in_array((string)$entryStatus, ENTRY_STATUSES, true)
      || !in_array($incomingApproval, APPROVAL_STATUSES, true)
      || mb_strlen((string)($entry['comment'] ?? '')) > 1000) {
      $rejections[] = ['key' => $key, 'reason' => 'invalid']; $keepKeys[$key] = true; continue;
  }
  // неизвестный сотрудник: SELECT 1 FROM employees WHERE id=? → rejections[] вместо FK-500
  // year: if (!preg_match('/^\d{4}$/', (string)$body['year'])) не писать meta.
  ```
  Список статусов взять из фронта (index.html, константы типов) — уточнить при реализации.
- Уверенность: подтверждено на dev.
- Статус риска: —

### B-09 | generateRequestId() не уникален между командировками: второе подтверждение в ту же секунду тихо не создаёт заявку HelpMe
- Приоритет: P1
- Категория: B (логическая ошибка / обработка ошибок), CWE-340, CWE-390
- Место: api/helpers.php:113-116 (`'SC-' . substr($tripId, 0, 4) . '-' . $participantNum . '-' . time()`); api/trips.php:678-690 (INSERT trip_requests), 692-695 (catch глотает ошибку очереди: D1 «confirm continues»).
- Доказательство:
  ```php
  // helpers.php:115 — substr('trip_6add…', 0, 4) === 'trip' для ЛЮБОЙ командировки (genId('trip_'))
  return 'SC-' . substr($tripId, 0, 4) . '-' . $participantNum . '-' . time();
  // trips.php:692 — PK-конфликт проглатывается
  } catch (Throwable $_relay) { error_log('E12-2: trip_requests enqueue failed (confirm continues): ' ...); }
  ```
  Воспроизведено на dev: две forecast-командировки (разные сотрудники), два ПОСЛЕДОВАТЕЛЬНЫХ PUT ?action=confirm в пределах одной секунды → оба HTTP 200, обе status=confirmed, в trip_requests одна строка `SC-trip-1-17…` (первой командировки); в логе: `E12-2: trip_requests enqueue failed (confirm continues): ... UNIQUE constraint failed: trip_requests.request_id`.
- Сценарий сбоя (admin/supervisor): массовое подтверждение нескольких командировок (быстрые клики в журнале) или два supervisor'а одновременно; у многоучастниковой командировки при коллизии на участнике N исключение прерывает цикл — участники N…M тоже без заявок. UI показывает «подтверждено», заявка роботу не уходит; повторный confirm — no-op (trips.php:617-620), т.е. самостоятельно пользователь ошибку не исправит.
- Последствия: сотрудник не получает билеты/гостиницу/аванс по подтверждённой командировке; обнаруживается только по факту. Ошибка видна лишь в error_log хостинга.
- Исправление (не применять):
  ```php
  // helpers.php
  function generateRequestId(string $tripId, int $participantNum): string
  {
      // уникально: полный trip id (без префикса) + номер участника + случайный суффикс
      $core = preg_replace('/[^A-Za-z0-9]/', '', substr($tripId, 5));
      return 'SC-' . substr($core, 0, 12) . '-' . $participantNum . '-' . bin2hex(random_bytes(4));
  }
  // trips.php:692 — не глотать молча: собрать $enqueueErrors[] и вернуть в ответе
  // ('relayWarnings'), audit('trip.relay_enqueue_failed', ...), во фронте показать toast.
  ```
  Если формат `SC-xxxx-N-unixtime` согласован с HelpMe — сохранить формат, но взять `substr($tripId, 5, 4)` и проверять уникальность с повтором (`INSERT OR IGNORE` + rowCount + новый суффикс).
- Уверенность: подтверждено на dev.
- Статус риска: —

### B-10 | Очередь RPA не отражает удаление/правку подтверждённой командировки: робот получает заявку на удалённую поездку и старые даты
- Приоритет: P1
- Категория: B (целостность данных/обработка состояний), CWE-672
- Место: api/trips.php:578-605 (DELETE: trip_requests не трогаются; у trip_requests нет FK на trips — api/db.php:248-261, schema.sql:202-214); api/trips.php:714-886 (PUT confirmed admin'ом: даты/участники/маршрут меняются, payload в trip_requests «заморожен» на confirm, 679-686); api/trip_relay.php:120-141 (poll не проверяет существование/актуальность trip).
- Доказательство (dev): confirm командировки (emp_4, 01-03.09.2028) → admin PUT участники 01-02.10.2028 (200) → admin DELETE (200, trips: 0 строк) → GET trip_relay.php (X-Auth-Token) отдал заявку этой командировки с `dateStart 01.09.2028, dateEnd 03.09.2028`.
- Сценарий сбоя: admin исправляет даты или отменяет уже подтверждённую командировку до того, как робот забрал заявку (или после — тогда изменение вообще не доходит до HelpMe).
- Последствия: оформление билетов/гостиницы/аванса на отменённую поездку или на неверные даты; ПДн (ФИО, телефон, маршрут) уходят третьей стороне по несуществующей командировке.
- Исправление (не применять): в той же транзакции DELETE/PUT confirmed — отзывать необработанные заявки и (для PUT) ставить новые:
  ```php
  // trips.php DELETE, перед DELETE FROM trips:
  $pdo->prepare("UPDATE trip_requests SET status='cancelled', done_at=:ts
                  WHERE trip_id=:id AND status='queued'")->execute([':ts'=>$ts, ':id'=>$id]);
  // + для status='delivered'/'created' — audit('trip.relay_cancel_required') и предупреждение в ответе
  // trips.php PUT при $existing['status']==='confirmed': то же 'cancelled' для queued + повторная
  // постановка заявок с новым payload (вынести цикл 648-695 в функцию trips_enqueue_requests()).
  // trip_relay.php poll: JOIN trips t ON t.id = r.trip_id (заявки удалённых командировок не выдавать).
  ```
- Уверенность: подтверждено на dev.
- Статус риска: —

### B-11 | Relay: доставка «не более одного раза» без повторной выдачи и callback last-write-wins — заявки зависают, тикеты теряются
- Приоритет: P2
- Категория: B (идемпотентность/повторы), CWE-841
- Место: api/trip_relay.php:133-142 (заявка помечается delivered ДО того, как ответ дошёл до робота; claimed_at нигде не используется для повторной выдачи); 194-206 (callback безусловно перезаписывает status/ticket_id/attempts, в т.ч. для queued-заявок и после `created`); UPDATE poll без `AND status='queued'` (136).
- Доказательство (dev): callback `{status:'created', ticketId:'T-1', attempt:2}` → затем запоздалый повтор `{status:'failed', reason:'timeout', attempt:1}` → в БД `failed | ticket_id=NULL | attempts=1` (номер тикета HelpMe потерян, статус регресс).
- Сценарий сбоя: (1) обрыв соединения/таймаут nginx после commit poll → заявка `delivered`, робот её не получил, повторный poll выдаст следующую — заявка зависла навсегда; (2) робот ретраит callback (сетевой сбой ответа 200) или присылает результаты не по порядку → `created` затирается `failed`, ticket_id = NULL.
- Последствия: потерянные заявки без сигнала пользователю; утрата связи с тикетом HelpMe; повторная ручная подача → дубли тикетов.
- Исправление (не применять):
  ```php
  // poll: выдавать queued ИЛИ delivered с истёкшей арендой (например, 15 мин) и ограничивать попытки
  "SELECT request_id, payload FROM trip_requests
    WHERE status='queued' OR (status='delivered' AND claimed_at < :lease)
    ORDER BY created_at, request_id LIMIT 1"
  "UPDATE trip_requests SET status='delivered', claimed_at=:ts, attempts=attempts+1
    WHERE request_id=:rid AND status IN ('queued','delivered')"   // + rowCount()===1, иначе повторить
  // callback: терминальный 'created' не перезаписывается; ticket_id не обнуляется
  "UPDATE trip_requests SET status=:status, ticket_id=COALESCE(:ticket_id, ticket_id),
          last_error=:last_error, attempts=MAX(attempts, :attempts), done_at=:done_at
    WHERE request_id=:rid AND status <> 'created'"
  // повтор того же 'created' с тем же ticketId → 200 (идемпотентно), иной → 409.
  ```
  Значение аренды и контракт повторной выдачи согласовать с HelpMe (сторона робота не проверялась).
- Уверенность: подтверждено на dev (callback-регресс); зависание delivered — по коду.
- Статус риска: —

### B-12 | PUT trips.php со status='confirmed' подтверждает командировку в обход ?action=confirm — заявки роботу не создаются
- Приоритет: P2
- Категория: B (логическая ошибка/валидация переходов статуса)
- Место: api/trips.php:751-754 (status принимается из body: forecast|confirmed), 716-718 (guard только по СТАРОМУ статусу), 829-852 (UPDATE без постановки заявок).
- Доказательство: `$newStatus = array_key_exists('status', $body) ? (string) $body['status'] : $existing['status'];` — переход forecast→confirmed разрешён и supervisor'у своей зоны. Dev: POST forecast → `PUT trips.php?id=… {"status":"confirmed"}` → 200, trips.status=confirmed, строк в trip_requests для этой командировки — 0. Обратный переход confirmed→forecast admin'ом тоже разрешён, после повторного confirm старые заявки в `created/failed` не считаются дублем (trips.php:652) → повторные тикеты.
- Последствия: подтверждённая командировка без заявки HelpMe (тот же эффект, что B-09), либо дубли тикетов.
- Исправление (не применять): в обычном PUT запретить смену статуса (`if ($newStatus !== $existing['status']) sendJson(['error'=>'use_action_confirm'], 400);`), понижение confirmed→forecast — отдельным `?action=unconfirm` (admin) с отменой заявок (см. B-10).
- Уверенность: подтверждено на dev.
- Статус риска: —

### B-13 | trips.php PUT: проверка версии вне транзакции — потерянное обновление при одновременной правке
- Приоритет: P2
- Категория: B (конкурентность), CWE-367
- Место: api/trips.php:548 (`$existing = trips_fetch()` вне транзакции), 724-733 (сравнение версии), 807-852 (`UPDATE trips SET … version = :version WHERE id = :id` — без `AND version = :old`).
- Доказательство:
  ```php
  $serverVersion = (int) $existing['version'];          // прочитано до BEGIN
  ... $pdo->beginTransaction(); ... 'UPDATE trips SET ..., version = :version ... WHERE id = :id'
  ```
- Сценарий сбоя: два пользователя открыли командировку (version 3) и сохраняют почти одновременно: оба проходят проверку (3 == 3), оба пишут version=4; второй полностью заменяет участников (DELETE+INSERT 855-869) — изменения первого потеряны без 409. Аналогично confirm (633: newVersion из $existing).
- Последствия: тихая потеря правок состава/дат командировки. Окно — время между SELECT и COMMIT второго запроса; при B-07-исправлении (BEGIN IMMEDIATE) без перепроверки версии окно остаётся.
- Исправление (не применять): перечитать версию под блокировкой и делать условный UPDATE:
  ```php
  $pdo->exec('BEGIN IMMEDIATE');
  $cur = (int) $pdo->query("SELECT version FROM trips WHERE id=" . $pdo->quote($id))->fetchColumn();
  if ($clientVersion !== null && (int)$clientVersion !== $cur) { $pdo->exec('ROLLBACK'); sendJson([... 'version_conflict'], 409); }
  // UPDATE ... WHERE id = :id AND version = :cur ; if ($stmtUpd->rowCount() !== 1) → 409
  ```
- Уверенность: подтверждено по коду (точный тайминг на dev не воспроизводился).
- Статус риска: —

### B-14 | trips.php: неполная серверная валидация (несуществующие даты, дубли участников → 500, переполнение аванса, телефон/бизнес-процесс, длина периода)
- Приоритет: P3
- Категория: B (валидация), CWE-20
- Место: api/trips.php:79-87 (`trips_valid_date`: `date_create('2026-02-30')` НЕ возвращает false — нормализует в 2026-03-02, комментарий в коде ошибочен); 193-225 (нет проверки повторного employeeId → PK trip_participants → 500); 283-284 (`preg_match('/^\d+$/')` + `(int)` → '99999999999999999999' сохраняется как 9223372036854775807); 247-251 (phone/businessProcess/origin/hotel — любой текст любой длины); 209 (длина периода не ограничена — 1900-01-01…2099-12-31 принимается, цикл trips_check_overlaps 162-180 идёт по ~73 тыс. дат); 414-420 (title/location/comment без лимита длины).
- Доказательство (dev, admin): POST участника 2027-02-30 → 201; два участника с одним employeeId → 500 `UNIQUE constraint failed: trip_participants…`; advanceAmount "99999999999999999999" → 201, в БД 9223372036854775807; phone "not a phone <b>" → 201; период 1900…2099 → 201.
- Сценарий сбоя: опечатка/ошибка фронта уходит роботу HelpMe (несуществующая дата в payload `dateStart`, абсурдный аванс, мусорный телефон) или даёт 500 вместо понятной 400.
- Последствия: некорректные заявки в HelpMe; неинформативные 500.
- Исправление (не применять):
  ```php
  function trips_valid_date(string $d): bool {
      if (!preg_match('/^(\d{4})-(\d{2})-(\d{2})$/', $d, $m)) return false;
      return checkdate((int)$m[2], (int)$m[3], (int)$m[1]) && (int)$m[1] >= 2000 && (int)$m[1] <= 2100;
  }
  // participants: if (isset($seen[$empId])) sendJson(['error'=>'duplicate_participant'],400); $seen[$empId]=1;
  //               период ≤ 366 дней: if ((strtotime($endDate)-strtotime($startDate))/86400 > 366) → 400
  // advance: строка ≤ 9 цифр и (int) ≤ 10_000_000 → иначе advance_invalid
  // phone: preg_match('/^\+?[0-9 ()\-]{5,20}$/u') ; businessProcess: whitelist значений из фронта (js/trips.js)
  // текстовые поля: mb_strlen ≤ 500 (title ≤ 200)
  ```
- Уверенность: подтверждено на dev.
- Статус риска: —

### B-15 | vacation_import.php: перенос/сокращение отпуска оставляет «призрачные» дни; повтор импорта не идемпотентен и затирает правки admin
- Приоритет: P2
- Категория: B (логическая ошибка/идемпотентность), CWE-841
- Место: api/vacation_import.php:374-403 (только upsert по дням диапазона, удаления/замены прежнего диапазона нет), 195-210 (`version = COALESCE(...)+1` и sync_log на КАЖДЫЙ день при каждом повторе, без no-op проверки), 301 (`approvalStatus` по умолчанию 'approved'), 394-400 (ошибка БД на отдельном дне глотается — транзакция коммитится с частью дней, ответ `success:true`).
- Доказательство (dev, Bearer внешней системы, сотрудник по ФИО в ВЕРХНЕМ регистре): импорт 2027-07-01…07-14 (200) → тот же отпуск перенесён на 07-08…07-21 (200) → в БД `min 2027-07-01, max 2027-07-21, count 21, max(version) 2` — дни 01-07 остались отпуском.
- Сценарий сбоя: внешняя система (кадровая) присылает актуальное состояние отпуска после переноса/сокращения/отмены; либо повторяет ту же отправку (ретрай после 500 из-за B-07). Каждый повтор поднимает version → у supervisor'ов, державших старую версию, ложные конфликты; правки admin (comment, перевод в draft, исправленный тип) перезаписываются без проверки.
- Последствия: в матрице висят отпуска, которых нет; неверные остатки отпусков; конфликт с командировками (trips_check_overlaps считает призрачные дни отпуском).
- Исправление (не применять): ввести внешний идентификатор записи и замену диапазона:
  ```php
  // payload: externalId (id отпуска во внешней системе) — хранить в comment-метке или новой колонке
  // schedule_entries.source_ref TEXT (миграция v9). Перед upsert диапазона:
  DELETE FROM schedule_entries WHERE source_ref = :ref AND (date < :start OR date > :end);
  // upsert только при изменении значения (no-op как в save.php:567-577), иначе version не трогать;
  // при ошибке любого дня — rollBack и 500/207 по всей записи, а не success:true с частью дней.
  ```
  Контракт внешней системы (есть ли id отпуска, присылается ли отмена) не проверялся — согласовать.
- Уверенность: подтверждено на dev.
- Статус риска: —

### B-16 | vacation_import.php: даты разбираются date_create() — несуществующие и неоднозначные даты молча сдвигаются; status/approval/comment не валидируются
- Приоритет: P2
- Категория: B (валидация/граничные случаи дат), CWE-20, CWE-1286
- Место: api/vacation_import.php:341-342 (`date_create((string) $startDateRaw)` без проверки формата), 299-301 (status/comment/approvalStatus — как есть).
- Доказательство: PHP 8.3 (dev):
  ```
  date_create('2027-02-29') → 2027-03-01   (невисокосный год)
  date_create('31.04.2026') → 2026-05-01
  date_create('02/01/2026') → 2026-02-01   (американский m/d/Y; для РФ это 2 января)
  date_create('tomorrow')   → завтрашняя дата
  ```
  Dev: импорт `{startDate:'2027-02-29', endDate:'2027-02-29'}` → 200 `success:true, errors:[]`, в БД запись 2027-03-01 vacation. Импорт со `status:'zzz', approvalStatus:'whatever'` → 200, записано.
- Сценарий сбоя: внешняя система присылает дату с ошибкой или в формате DD/MM/YYYY → отпуск ложится на другие дни без ошибки в ответе; неизвестный status даёт «невидимые» записи (см. B-08).
- Последствия: неверные периоды отпусков/больничных в матрице и выгрузках; расхождение с кадровой системой без сигнала.
- Исправление (не применять):
  ```php
  $parse = static function ($s) {
      if (!is_string($s) || !preg_match('/^(\d{4})-(\d{2})-(\d{2})$/', $s, $m)
          || !checkdate((int)$m[2], (int)$m[3], (int)$m[1])) return false;
      return new DateTime($s . ' 00:00:00');
  };
  $start = $parse($startDateRaw); $end = $parse($endDateRaw);
  if (!in_array($status, ['vacation','sick','day_off','study'], true)) { $errors[] = [... 'invalid_status']; return; }
  if (!in_array($approvalStatus, ['draft','approved'], true)) { $errors[] = [... 'invalid_approval']; return; }
  if (mb_strlen((string)$comment) > 1000) { ... }
  ```
  Резолвинг ФИО (vacation_import.php:116-134, 229-280) проверен отдельно: регистр, ё/е, NBSP/табы/повторные пробелы нормализуются корректно (проверено скриптом); НЕ нормализуются декомпозированная «ё» (е+U+0308) и латинские двойники букв — это даёт `employee_not_found` (безопасный отказ, не запись чужому сотруднику). Желательно добавить `Normalizer::normalize($s, Normalizer::FORM_C)` при наличии intl.
- Уверенность: подтверждено на dev.
- Статус риска: —

### B-17 | Устаревшая вкладка admin перезаписывает свежие карточки сотрудников и «воскрешает» удалённых (E10-6 защищает только удаление)
- Приоритет: P1
- Категория: B (фронт↔бэк синхронизация, потеря данных), CWE-362
- Место: api/save.php:250-289 (upsert КАЖДОГО сотрудника payload без проверки `$freshEmpsCache` — кэш используется только для удалений, 352-372); api/employees.php:261-273 (DELETE не пишет sync_log — удаление невидимо для sync.php и freshness-гарда).
- Доказательство (dev, две сессии admin = две вкладки):
  ```
  tab1: load.php → cursor 7950, 4 сотрудника
  tab2: load → phone сотрудника X := '+7 000 PROBE' → save.php 200 → в БД '+7 000 PROBE'
  tab2: DELETE employees.php?id=Y {confirm:true} → 200
  tab1 (устаревшая): save.php {clientLastSyncId:7950, employees: <свой старый список>} → 200
  итог: phone X = '' (правка tab2 откатилась), сотрудник Y снова существует (audit: employee.create)
  ```
  Гард E10-2 (save.php:211-247) срабатывает только при ≥3 обнулениях photo/location; переименование, смена телефона/группы/должности, одиночные изменения — не ловятся.
- Сценарий сбоя (admin): две вкладки или два администратора; одна вкладка давно открыта (или poll не применил изменения — B-03/B-05), любой автосейв матрицы/карточки отправляет полное состояние employees.
- Последствия: откат карточек сотрудников (ФИО, телефоны, должность, группа = зона доступа supervisor'а!), воскрешение удалённых (уволенных) сотрудников — их ПДн снова в справочнике; удалённые через employees.php не исчезают из открытых вкладок.
- Исправление (не применять):
  ```php
  // save.php, в цикле 250-289 перед $stmtE->execute():
  if ($clientLastSyncId !== null && isset($freshEmpsCache[(string)$id])) {
      $staleEmpRejects[] = (string)$id;   // карточка менялась после курсора клиента
      $keepEmpIds[(string)$id] = true;    // вернуть в ответе, клиент перечитает
      continue;
  }
  // запрет воскрешения: если $wasExisting === false и в sync_log есть 'delete' этого id после курсора
  //   (или курсора нет) — не создавать, вернуть в staleEmpRejects.
  // employees.php DELETE: в одной транзакции DELETE + sync_log('employee', $id, 'delete', now()).
  // Аналогично POST/PUT employees.php, groups.php, positions.php, holidays.php — писать sync_log.
  ```
  На фронте отправлять только изменённые карточки (дельта), а не весь справочник.
- Уверенность: подтверждено на dev.
- Статус риска: —

### B-18 | Восстановление import.php из собственного export.php стирает всех участников командировок и не уведомляет открытые вкладки
- Приоритет: P1
- Категория: B (целостность данных/обработка ошибок), CWE-1229
- Место: api/import.php:53-57 (`DELETE FROM employees` → ON DELETE CASCADE trip_participants, schema.sql:181-188); api/export.php (в выгрузке нет trips/trip_participants/trip_requests — ключи: employees, entries, groups, holidays, positions, vacationBalances, version, year, exportedAt); api/import.php:50-171 (sync_log не пишется и не очищается; версии записей сбрасываются в DEFAULT 1, 104-119).
- Доказательство (dev, admin): export.php → import.php тем же JSON (200, success) → `trips 11, participants 11` стало `trips 11, participants 0` (все 11 командировок без участников); `sync_log max` не изменился.
- Сценарий сбоя (admin): штатная процедура «восстановить из резервной копии» или перенос данных → все командировки теряют участников (даты, люди); заявки HelpMe в trip_requests остаются, а командировки «пустые». Открытые вкладки с прежним курсором при ближайшем автосейве: sync-delete удаляет записи, которых у них нет (импорт не попал в sync_log → E10-6 их не защищает), и upsert'ит свои старые карточки/записи поверх импортированных (B-17).
- Последствия: необратимая потеря данных командировок (в бэкапе export их нет); откат восстановления устаревшими вкладками.
- Исправление (не применять):
  ```php
  // export.php: добавить 'trips' (с participants и RPA-полями) и, по решению владельца, 'tripRequests'.
  // import.php в транзакции: перед DELETE FROM employees сохранить/удалить trips явно:
  $pdo->exec('DELETE FROM trip_participants'); $pdo->exec('DELETE FROM trips');
  // ... затем вставить trips/participants из $body['trips'] (если ключа нет — НЕ трогать trips и
  //     не удалять сотрудников, на которых ссылаются trip_participants: 400 'backup_without_trips').
  // После commit: одна запись sync_log('system','import','reset', $ts) + во фронте при получении
  //   такого события — принудительная перезагрузка состояния (load.php) без сохранения локального.
  // Версии записей: сохранять 'version' из бэкапа или ставить MAX(старой)+1, а не 1.
  ```
- Уверенность: подтверждено на dev.
- Статус риска: —

### B-19 | Форма командировки: ReferenceError `phoneEl is not defined` — создание и правка командировок из UI невозможны (в т.ч. на проде)
- Приоритет: P1
- Категория: B (логическая ошибка фронтенда), CWE-457
- Место: js/trips.js:1655 (в saveTrip(), 1549-1717); телефон читается в 1651 как `phone`, но проверка обращается к необъявленному `phoneEl`; регэксп `/[^\\d]/g` (в файле два обратных слэша) означает «всё, кроме `\` и `d`», т.е. и после исправления имени переменной цифры не считались бы.
- Доказательство:
  ```js
  var phone = document.getElementById('tripPhone').value.trim();      // 1651
  var phoneDigits = phoneEl.value.replace(/[^\\d]/g, '').length;      // 1655 — phoneEl нигде не объявлен (grep по репо: 1 вхождение)
  ```
  Проверено на dev: js/trips.js загружен в node vm со стабом DOM (одна строка участника emp_1, даты, телефон «+7 912 345 67 89»), вызов `Trips.saveTrip()` → `ReferenceError: phoneEl is not defined`. Анонимный GET прод-файла http://host1882970.hostland.pro/js/trips.js → 200, 121184 байт, побайтно идентичен 101c846 (строка 1655 та же).
- Сценарий сбоя (admin/supervisor): журнал командировок → «Новая»/«Редактировать» → «Сохранить» (onclick `window.Trips.saveTrip(...)`, js/trips.js:1210, 1336, 1370) → исключение в обработчике, запрос к api/trips.php не уходит, сообщения пользователю нет.
- Последствия: функциональность «Командировки» (создание, правка, а значит и подтверждение новых поездок → заявки HelpMe) на проде недоступна из интерфейса; пользователи могут считать, что данные сохранены.
- Исправление (не применять):
  ```js
  // js/trips.js:1655
  var phoneDigits = phone.replace(/\D/g, '').length;
  ```
  Добавить в scripts/ регрессионный тест saveTrip (vm-стаб, как выше) — текущие сьюты эту ветку не покрывают.
- Уверенность: подтверждено на dev (node vm) и запросом к проду (файл идентичен).
- Статус риска: —

### B-20 | Трипы: курсор синхронизации подменяется версией командировки; дельта sync.php отдаёт командировку без RPA-полей
- Приоритет: P2
- Категория: B (фронтенд-синхронизация)
- Место: js/trips.js:249, 299, 332 (`_state.lastSyncId = newTrip.version` / `updatedTrip.version` / `trip.version` — номер версии записи присваивается курсору sync_log); js/trips.js:2123-2141 (poll `sync.php?afterId=<версия>`), 371-406 (курсор восстанавливается только если что-то «changed»); api/sync.php:42-82 (`trips_sync_fetch_trip` выбирает только id, title, location, comment, status, version, created_*, updated_at — без origin/hotel/transport_*/advance_amount/business_process/phone), js/trips.js:386-392 (локальный объект целиком заменяется объектом из дельты).
- Доказательство:
  ```js
  _state.lastSyncId = updatedTrip.version;   // 299: курсор sync_log (тысячи) := 2
  api('GET', API_SYNC + '?afterId=' + _state.lastSyncId)   // 2127: afterId=2 → весь sync_log (до 10000 событий)
  _state.trips[index] = serverTrip;          // 389: serverTrip без RPA-полей
  ```
- Сценарий сбоя: после любой правки/создания/подтверждения командировки поллер каждые 20 с запрашивает весь журнал (sync.php выполняет SELECT на каждое событие с полным сканом `employee_id||':'||date`) — пока какая-то командировка не изменится. При чужой правке командировки вкладка получает объект без RPA-полей: в форме «Откуда/Гостиница/Телефон/Аванс/Транспорт» пустые; после исправления B-19 сохранение такой формы отправит `origin:null, phone:null, advanceAmount:null…` и сотрёт данные заявки HelpMe.
- Последствия: лишняя нагрузка на shared-хостинг, тормоза поллинга; потенциальное стирание RPA-полей командировок.
- Исправление (не применять):
  ```js
  // js/trips.js:249/299/332 — не трогать курсор (или max с серверным lastSyncId из ответа trips.php)
  _lastLocalActionAt = Date.now();
  // trips.php POST/PUT/confirm: возвращать 'lastSyncId' и делать _state.lastSyncId = Math.max(_state.lastSyncId, resp.lastSyncId)
  ```
  ```php
  // api/sync.php: вместо локальной копии использовать общую функцию trips_fetch() (вынести в helpers),
  // чтобы дельта содержала все поля, включая RPA v1.2.
  ```
- Уверенность: подтверждено по коду.
- Статус риска: —

### B-21 | Ротация sync_log без обнаружения разрыва: старый курсор клиента молча теряет события и обходит freshness-гард E10-6
- Приоритет: P2
- Категория: B (синхронизация/граничные значения)
- Место: api/save.php:55-61 (`DELETE FROM sync_log WHERE id < max-10000` на каждом save); api/vacation_import.php:384-389 (одна строка sync_log на КАЖДЫЙ день импорта); api/sync.php:207-235 (afterId не сравнивается с MIN(id)); api/save.php:151-174 (freshness-кэши строятся только по сохранившимся строкам sync_log).
- Доказательство: `if ($maxId > 10000) DELETE FROM sync_log WHERE id < $maxId - 10000` — ни sync.php, ни save.php не проверяют `afterId/clientLastSyncId < MIN(id)`.
- Сценарий сбоя: внешний импорт отпусков на год по 30 сотрудникам = ~11 000 строк sync_log за один запрос → после ближайшего save журнал обрезается. Вкладка, открытая до импорта: (1) поллинг с afterId < MIN(id) не получает события из удалённого диапазона; (2) её полный save с clientLastSyncId из удалённого диапазона: `$freshEntryKeysCache` не содержит изменённых в этом окне записей → stale-value и stale-delete гарды не срабатывают → записи импорта затираются/удаляются (если затронуто <10 сотрудников).
- Последствия: тот же класс потери данных, что инциденты E10 (07-08.10), через путь «большая пачка изменений → ротация».
- Исправление (не применять):
  ```php
  // helpers.php
  function sync_min_id(PDO $pdo): int { return (int)$pdo->query('SELECT COALESCE(MIN(id),0) FROM sync_log')->fetchColumn(); }
  // sync.php GET: if ($afterId > 0 && $afterId < sync_min_id($pdo) - 1) sendJson(['resync' => true, 'lastSyncId' => $lastSyncId]);
  //   фронт: при resync — полная перезагрузка load.php (без отправки локального состояния)
  // save.php: if ($clientLastSyncId !== null && $clientLastSyncId < sync_min_id($pdo) - 1)
  //   → rollBack; sendJson(['error' => 'resync_required'], 409);
  // vacation_import: одна строка sync_log на сотрудника+диапазон, либо ротацию считать по времени (>7 дней), а не по числу строк.
  ```
- Уверенность: подтверждено по коду.
- Статус риска: —

### B-22 | Смешение форматов времени: date('c') (TZ сервера) и gmdate('…+00:00') сравниваются как строки; 52 записи audit_log с ts = NULL не удаляются ретенцией
- Приоритет: P3
- Категория: B (часовые пояса/граничные случаи)
- Место: api/helpers.php:85-88 (`now()` = `date('c')`, смещение = date.timezone сервера); api/helpers.php:266-282 и api/db.php:480-494 (cutoff `gmdate('Y-m-d\TH:i:s+00:00')`, `DELETE … WHERE ts < :cutoff` — лексикографическое сравнение); api/db.php:358 (legacy-миграция пишет gmdate); api/audit_export.php:56-63 (комментарий «ts хранится в UTC (date('c'))» — верно только при TZ=UTC); dev-БД: `SELECT count(*) FROM audit_log WHERE ts IS NULL` = 52.
- Доказательство: при TZ, отличном от UTC (проверено скриптом с Asia/Yekaterinburg): `date('c')` = `2026-10-25T12:45:54+05:00`, `gmdate(...)` = `2026-10-25T07:45:54+00:00` — строки одного момента различаются на 5 ч; сравнение `ts < cutoff` и `ORDER BY ts` работают по локальным часам, а не по моменту времени. `NULL < :cutoff` → NULL → строки с пустым ts вечные (и не попадают в audit_export: `ts >= :cutoff`).
- Сценарий сбоя: на проде date.timezone ≠ UTC (значение на Hostland не проверено — требуется phpinfo под владельцем) → ретенция аудита 7 дней сдвигается на величину смещения; записи миграции (+00:00) и пользовательские (+0X:00) сортируются неверно в выгрузке аудита; браузер (UTC+5) показывает `savedAt`/`serverTime` как есть.
- Последствия: неточная ретенция журнала аудита (ПДн в details хранятся дольше/короче заявленного), путаница во времени событий при разборе инцидентов. Календарные даты (YYYY-MM-DD) в бизнес-логике от TZ не зависят — проверено: на фронте нет `toISOString()` для дат матрицы (единственное использование js/trips.js:2584 — createdAt).
- Исправление (не применять):
  ```php
  // helpers.php
  function now(): string { return gmdate('Y-m-d\TH:i:s+00:00'); }   // единый формат UTC
  // разовая нормализация (миграция v9):
  // UPDATE audit_log SET ts = strftime('%Y-%m-%dT%H:%M:%S+00:00', ts) WHERE ts IS NOT NULL;
  // DELETE FROM audit_log WHERE ts IS NULL;   (или ts = '1970-01-01T00:00:00+00:00')
  // аналогично sync_log.updated_at, trip_requests.*_at, schedule_entries.updated_at
  ```
- Уверенность: подтверждено по коду и на dev (NULL-строки); влияние на прод — требует проверки (date.timezone).
- Статус риска: —

### B-23 | Производственный календарь вне 2026–2028: молчаливый упрощённый fallback без переносов и без признака «приблизительно»
- Приоритет: P3
- Категория: B (граничные случаи дат)
- Место: api/holidays_provider.php:46-66 (файлы есть только data/holidays/2026.json, 2027.json, 2028.json), 75-123 (fallback: фиксированные праздники ст. 112 ТК + сб/вс; переносы и рабочие субботы не учитываются; праздник, выпавший на выходной, не переносится); ответ fallback неотличим от официального (нет поля `source`/`approximate`); повреждённый JSON года также молча уходит в fallback (54).
- Доказательство: `if (is_readable($jsonFile)) {...} $holidays = generateFallbackHolidays($year); sendJson(['year'=>$year,'holidays'=>$holidays]);`
- Сценарий сбоя: в декабре 2028 планируют отпуска на 2029 (или смотрят 2025) → матрица показывает рабочими перенесённые выходные (например, 2–3 мая, 31 декабря) и наоборот → неверный подсчёт календарных/рабочих дней отпуска и командировок.
- Последствия: ошибки в планировании и остатках отпусков без предупреждения.
- Исправление (не применять): в fallback-ответ добавить `'source' => 'fallback'` и во фронте (index.html:2775-2800, загрузчик holidays_provider) показывать баннер «календарь {год} неофициальный — загрузите data/holidays/{год}.json»; при повреждённом JSON — 500 + error_log, а не тихий fallback; добавить задачу ежегодного обновления (scripts/generate_holidays.py уже есть).
- Уверенность: подтверждено по коду.
- Статус риска: —

## 4. Проверено, проблем не найдено

По пунктам чек-листа блока B (PROMPT.md:83-90):

- Граничные случаи / Unicode в ФИО: нормализация ФИО в vacation_import.php:116-134 (trim, mb_strtolower, ё→е, `\s+`/u) проверена скриптом на PHP 8.3 — регистр, «Ё», NBSP (в т.ч. в конце), табы и повторные пробелы сопоставляются корректно; однофамильцы → `employee_name_ambiguous` без записи (229-280). trips.php поиска по ФИО не имеет: участники принимаются только по employeeId с проверкой существования (trips.php:212-218); fullName для HelpMe берётся из employees.full_name (670-676) — корректно. Пустые/NULL значения: getJsonBody (helpers.php:65-78) отдаёт 400 на невалидный JSON; пустое тело → []. Остальное по полям — в B-08/B-14/B-16.
- Високосные годы / переход года: fallback-календарь (holidays_provider.php:104-117) строит период через DatePeriod с `+1 day` — 29.02 високосного года и 31.12 включаются; save.php sync-delete по годам payload (`date LIKE 'YYYY-%'`, save.php:609-619) не затрагивает соседние годы; расчёт `days` в payload HelpMe (trips.php:326-332) через round() устойчив к смене смещения. Фронт: `toISOString()` для дат матрицы не используется (единственное — js/trips.js:2584 createdAt) — сдвига дат в UTC+5 нет.
- Совместимость PHP 8.1: `php -l` (8.3) по всем api/*.php и корневым *.php (router.php, upload.php, test_*.php) — ошибок нет; ручной поиск по всем этим файлам конструкций 8.2+ (`json_validate`, `readonly class`, типизированные константы, DNF-типы, `#[\Override]`, `str_increment/decrement`, `mb_str_pad`, `mb_trim`, `Random\Randomizer`, `ini_parse_quantity`, `memory_reset_peak_usage`, standalone `true/false/null` типы, динамический `::{$x}`, `array_find/any/all`) — не найдено (вхождения `Override` только в XML-строке audit_export.php:182-184). Используются только `mixed`, `void`, nullable-типы, `static function`, `final class`, private const — всё доступно в 8.0/8.1. php8.1 в системе нет — проверено по коду.
- Обработка ошибок: import.php — вся очистка+загрузка в одной транзакции с rollBack (50-175), частичного состояния нет (но см. B-18 про состав данных); trips.php — rollBack в catch всех веток (532-537, 599-604, 705-710, 880-885), `sendJson` внутри открытой транзакции (457, 464, 814) завершает скрипт — PDO откатывает незавершённую транзакцию при закрытии соединения (по коду); trip_relay.php poll — транзакция с rollBack (118-148); sync.php deletes — транзакция (106-171). HTTP-коды: 400/401/403/404/405/409 используются по назначению в trips.php, trip_relay.php, employees.php; исключения → 500 (с текстом SQL-ошибки — см. «Передано в A»).
- Конкурентность — двойной клик: повторный `?action=confirm` — no-op (trips.php:617-620); дубль-защита очереди по (trip_id, employee_id, queued|delivered) (648-667); poll не выдаёт одну заявку дважды (по коду: второй параллельный poll получит BUSY → 500, а не дубль — побочный эффект B-07).
- Миграции: DDL идемпотентен (CREATE … IF NOT EXISTS, addColumnIfNotExists) — повторный прогон без гонки безопасен; проблемы гонки — B-06.
- Фронтенд-синхронизация: поллинг index.html (5632: не опрашивает при `document.hidden`), применение дельты по курсору и Math.max (5649-5651, js/trips.js:406) — корректны помимо B-01, B-03, B-04, B-05, B-20, B-21.

## 5. Что не удалось проверить

- Реальный date.timezone и версия SQLite на Hostland (влияние B-22; поведение BUSY в B-07 на проде) — нужен phpinfo()/логи под учётной записью владельца; логиниться на прод запрещено.
- Поведение робота HelpMe (ретраи callback, таймауты poll, реакция на повторную выдачу) — сторона робота недоступна; выводы B-11 — по нашему коду.
- Контракт внешней системы импорта отпусков (есть ли id отпуска, присылает ли отмены/переносы, формат дат) — влияет на исправление B-15/B-16.
- Объём прод-данных и длительность полной транзакции save.php на Hostland (окно гонок B-07/B-13) — нагрузочные проверки на проде запрещены.
- Гонка B-05 (load.php) и B-13 (trips PUT) в точном тайминге на dev не воспроизводилась — подтверждено по коду.
- Полный E2E-прогон через headless Chrome (харнесс /tmp/e5_final.js / e6_final.js) не запускался из-за ограничения длительности вызовов в этом прогоне; B-19 подтверждён изолированно (node vm).

## 6. Передано в A

- api/save.php:736-757, 762-789, 794-796 — блоки holidays / vacationBalances / year НЕ ограничены `$e82IsAdmin`: supervisor через save.php upsert'ит праздники производственного календаря, балансы отпусков сотрудников и meta.current_year (подтверждено на dev: supervisor_zone0 → holidays 2027-05-05, vacation_balances emp_2/2027 total_days=999, current_year=0; HTTP 200). Зона для балансов не проверяется.
- api/save.php:504-506, 583 — supervisor может создать/изменить свою запись trip/day_off сразу с `approvalStatus:'approved'` (подтверждено на dev: emp_2 2027-04-01 day_off approved, HTTP 200) — «самосогласование», после чего запись неизменяема для других supervisor'ов.
- api/employees.php:239-264 — DELETE сотрудника доступен по `require_edit()` (supervisor) без проверки зоны и без require_admin; каскадно удаляет записи календаря/балансы/участие в командировках (по коду, на dev не воспроизводилось).
- api/save.php:820, trips.php:891, sync.php:305, employees.php:282, vacation_import.php:439 — текст исключения PDO (`SQLSTATE…`, имена таблиц/колонок) возвращается клиенту в 500-ответе.
- api/helpers.php:113-116 — request_id заявки HelpMe предсказуем (`SC-trip-<N>-<unixtime>`), используется как ключ callback (trip_relay.php:164-183) — оценить вместе с токеном робота.

## 7. Самопроверка

Для каждой находки проверено отсутствие защиты уровнем выше и что это не задокументированное проектное решение:

- B-01…B-05 (фронт/синхронизация): серверные гарды E10-2/E10-4/E10-6 (save.php:201-247, 352-372, 532-554, 620-646) просмотрены — указанные пути они не закрывают (B-01: без курсора гард выключен по дизайну «старый фронт»; B-03/B-05: курсор «видел» изменение). Не проектное решение: E10-6 декларирует обратное («stale tabs can no longer overwrite»).
- B-06: migrate() вызывается каждым эндпоинтом до require_* (login.php:36 — до проверки пароля); блокировок/мьютекса нет ни в db.php, ни в router.php. Проверено на копии БД.
- B-07: busy_timeout=5000 выставлен (db.php:530), но не действует при апгрейде read→write — воспроизведено; ретраев на сервере и фронте нет.
- B-08, B-14, B-16: валидации ни в require_*, ни в схеме (CHECK отсутствуют, schema.sql:60-70, 155-214) нет; фронтенд-валидация по условиям аудита не учитывается.
- B-09, B-10, B-12: catch D1 (trips.php:692-695) — задокументированное решение «сбой очереди не валит confirm», но решение не предполагало коллизию ID для штатного сценария; отзыв заявок при DELETE/правке confirmed в reports/ARCHITECTURE_TRIPS.md не описан (п. 47: DELETE — только sync_log delete) и в коде не реализован — это пробел, а не решение. Статус оставлен «—».
- B-11: «last-write-wins» в шапке trip_relay.php:23-25 задокументирован как контракт E12-2 — оценено как дефект надёжности (потеря ticket_id), а не нарушение контракта; владельцу стоит подтвердить, допустим ли регресс `created`→`failed`.
- B-13: версия проверяется только против `$existing`, прочитанного до BEGIN; иных гардов нет.
- B-15: идемпотентность импорта нигде не заявлена; гарды save.php на vacation_import не распространяются.
- B-17: E10-6 защищает только удаления сотрудников (save.php:352-372), upsert карточек не проверяет свежесть — воспроизведено.
- B-18: require_admin есть (import.php:33), но дефект — в составе данных export/import, а не в правах.
- B-19: глобальной переменной/элемента `phoneEl` нет ни в js/, ни в index.html (grep); исключение воспроизведено, прод-файл идентичен.
- B-20, B-21: код поллинга js/trips.js и index.html просмотрен — восстановления курсора/резервной полной перезагрузки нет.
- B-22, B-23: явных указаний о TZ (date_default_timezone_set) и о статусе fallback-календаря в коде/документации нет.
- Глобальная видимость (E8-4) и HTTP без TLS в находки не включались (проектные решения/принятые риски).
- Реальные токены, хеши и ПДн в отчёт не выводились: токены читались скриптами без печати, ID командировок/заявок маскированы, ФИО не приводятся (сотрудники обозначены emp_*).
