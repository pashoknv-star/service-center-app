# T3 — Backend implementation: фича «Командировки» (schema v6, api/trips.php, sync-ветка, legacy-конверсия, smoke)

Дата: 2026-08-29  
Исполнитель: sd_worker_02  
Основание: reports/ARCHITECTURE_TRIPS.md (прочитан первым), reports/T2_backend_audit.md, api/E8_SYNC.md
Статус: выполнено, полный smoke 76/76 = 100% pass.

---

## 1. Что сделано

### 1.1 api/schema.sql (v5 → v6)
Добавлен DDL точно по ARCHITECTURE_TRIPS.md раздел 1:
- `trips(id, title NOT NULL, location, comment, status DEFAULT 'forecast', version DEFAULT 1, created_by, created_at, updated_at)`
- `trip_participants(trip_id, employee_id, start_date, end_date, PK(trip_id,employee_id), FK trip_id → trips ON DELETE CASCADE, FK employee_id → employees ON DELETE CASCADE)`
- Индексы: `idx_trips_dates (created_at)`, `idx_trip_participants_emp (employee_id)`.

### 1.2 api/db.php
- `SCHEMA_VERSION = 6`.
- `applyIncrementalMigrations($current < 6)`: те же `CREATE TABLE IF NOT EXISTS trips/trip_participants` + индексы (идемпотентно, для существующих БД).
- `migrateLegacyTrips()` — legacy-конверсия (см. раздел 3):
  - SELECT всех `schedule_entries WHERE status='trip' ORDER BY employee_id, date`;
  - группировка по сотрудникам; подряд идущие даты (разрыв = >1 день) — одна командировка; год НЕ ограничивает;
  - каждый блок → Trip: `title='Командировка (миграция)'`, `location=comment первой записи` (если есть), `status='confirmed'` (визуал не меняется), `version=1`, `created_by='legacy_migration'`;
  - INSERT участника `{employeeId, startDate, endDate}`;
  - `sync_log` НЕ пишется (миграция); один `audit('trip.legacy_migrate', details={'count': N})` через helpers.audit() если helpers загружен;
  - защита от осиротевших FK: run-ы сотрудников, отсутствующих в `employees`, пропускаются (иначе FK trip_participants упал бы и прервал миграцию);
  - идемпотентность: meta-флаг `trips_legacy_migrated`; на повторный запуск дублей нет. При ошибке флаг НЕ ставится — следующий запрос корректно повторит конверсию.
- `SC_APP_DB` env-переопределение пути БД (для тестов на /tmp-копии; по умолчанию поведение не меняется).

### 1.3 api/trips.php (НОВЫЙ, 603 строки)
Паттерн E8 из save.php (версии + sync_log + audit), НЕ entries.php.

Контракт:
- `GET` (require_auth, любая роль): `{ success, trips: [...полные объекты с participants(массив {employeeId,startDate,endDate})], lastSyncId }`. Чтение без зонального фильтра (E8-4).
- `POST` (require_edit): создание.
  - Валидация: title обязателен и непуст; status ∈ {forecast,confirmed} (default forecast); participants массив ≥1; даты YYYY-MM-DD и корректны (date_create) , startDate ≤ endDate; employeeId существует в employees.
  - Зона: не-admin (supervisor) — каждый участник обязан быть его scope_group_id, иначе 403 `zone_forbidden` + `foreignEmployees`.
  - Пересечения (в транзакции, ДО вставки): ∀участник ∀дата периода SELECT `schedule_entries WHERE employee_id=? AND date=? AND status IN ('vacation','day_off')` → 409 `{error:'overlapping_entry', employeeId, date, status}`. sick и legacy 'trip' НЕ блокируют.
  - Успех: `genId('trip_')`, INSERT trips (version=1, created_by=username, timestamps), INSERT участников, `sync_log('trip', id, 'upsert')`, `audit('trip.create')`. Ответ 201 `{success, trip}`.
- `PUT ?id=` (require_edit + зона участников):
  - `action=confirm`: forecast→confirmed (только forecast; повторный confirm — no-op). Права: admin ИЛИ supervisor своей зоны (зона проверена выше). confirmed → 403 `confirmed_immutable` для не-admin (approved-guard: подтверждённая правится только admin). Пишет `sync_log upsert`, `audit('trip.confirm')`.
  - обычный PUT: изменение title/location/comment/participants (полная замена набора с индивидуальными датами). `entryVersion` в body: при несовпадении с server version → 409 `{error:'version_conflict', clientVersion, serverVersion, serverTrip}` — применяется ко ВСЕМ пользователям (включая admin; НЕ молча перезаписывать). Совпало/отсутствует → применить, version+1, sync_log upsert, audit('trip.update'). Пересечения (vacation/day_off) для нового набора проверяются так же (trip сам с собой не конфликтует — schedule_entries не содержит trips-строк).
  - confirmed для не-admin → 403 `confirmed_immutable`.
- `DELETE ?id=` (require_edit + зона): forecast — supervisor своей зоны или admin; confirmed — ТОЛЬКО admin (403 confirmed_immutable иначе). sync_log('trip', id, 'delete'), audit('trip.delete'). Ответ `{success, deleted:true}`.
- Все ответы через `sendJson`; OPTIONS-preflight через `handleOptions()`; ошибки 400/401/403/404/409 по образцу существующих эндпоинтов.

### 1.4 api/sync.php (GET-дельта)
Добавлена ветка `entity_type='trip'`:
- в переборе событий после курсора: если trip есть в БД → `tripsChanged[tripId] = {полный объект с participants}`, иначе → `tripsDeleted[] = tripId`;
- ответ дополнен `tripsChanged` (объект) и `tripsDeleted` (массив); существующие ветки entries/employees НЕ тронуты;
- курсор `lastSyncId` остаётся `MAX(sync_log.id)` глобально.

### 1.5 api/smoke_test.php
- Фикстуры: idempotent создание g0/g1, employees emp_1(g1)/emp_2(g1)/emp_5(g0)/emp_16/17/18(g0) с принудительной зональной раскладкой (каноническая по T2-аудиту: g0=emp_5,16,17,18; g1=emp_1,2). Это также починило ранее падавшие E8-3 тесты (fixture-зависимые).
- Новый блок TRIPS (14 сценариев, год 2098) — см. раздел 2.
- Очистка: удаление smoke-командировок и осиротевших trip_participants.

---

## 2. Smoke-тесты: полный прогон

Критерий приёмки — 100% pass. Финальный прогон:

```
=== RESULTS: 76 passed, 0 failed out of 76 ===
DB intact: YES
```

Легенда номеров T3-блока:

| № | Сценарий | Результат |
|---|----------|-----------|
| T3-1 | GET trips.php без логина → 401 | PASS |
| T3-2 | viewer: GET ok, POST → 403 | PASS |
| T3-3 | admin POST forecast (2 участника, разные периоды) → 201, id trip_*, version=1 | PASS |
| T3-4 | GET содержит созданную trip с participants и updatedAt | PASS |
| T3-5 | POST с пересечением vacation → 409 overlapping_entry (employeeId/date/status) | PASS |
| T3-6 | POST с пересечением day_off → 409 | PASS |
| T3-7 | POST с пересечением sick → SUCCESS (sick не блокирует) | PASS |
| T3-8 | PUT без entryVersion → title обновлён, version=2 | PASS |
| T3-9 | PUT со stale entryVersion=1 → 409 version_conflict + serverTrip | PASS |
| T3-10 | PUT ?action=confirm (admin) → confirmed; затем PUT admin правит confirmed → ok | PASS |
| T3-11 | supervisor_zone0: PUT confirmed → 403 confirmed_immutable; DELETE confirmed → 403; DELETE forecast своей зоны → success | PASS |
| T3-12 | supervisor_zone0 POST с участником из чужой зоны g1 → 403 zone_forbidden + foreignEmployees | PASS |
| T3-13 | DELETE forecast (admin) → success; sync GET содержит trip-события в tripsChanged/tripsDeleted | PASS |
| T3-14 | Валидации: пустой title → 400; endDate<startDate → 400; несуществующий employeeId → 400; кривая дата → 400 | PASS |

Полный вывод smoke-прогона сохранён в логе сессии (76 строк PASS, 0 FAIL; см. выше сводку).

Попутно исправлены 11 ранее падавших pre-existing E8-тестов (fixture-зависимые: emp_2/5/16/17/18 отсутствовали, emp_1 был не в той зоне) — каноническая раскладка фикстур теперь идемпотентно выставляется на старте smoke.

---

## 3. Legacy-конверсия: доказательство на /tmp-копии

По инструкции тестировалось ТОЛЬКО на копии БД (живая data/app.db не перезаписывалась руками).

1. Копия: `sqlite3 data/app.db ".backup '/tmp/test_legacy.db'"`.
2. В копии: schema_version=5, флаг удалён, trips/trip_participants удалены, для emp_1 вставлены 2 блока подряд идущих trip-entries + 1 vacation между ними + одиночный trip-день:

```
emp_1 | 2026-01-10 | trip | Москва
emp_1 | 2026-01-11 | trip | Москва
emp_1 | 2026-01-12 | trip | Москва
emp_1 | 2026-01-13 | vacation | отпуск между
emp_1 | 2026-01-14 | trip | СПб
emp_1 | 2026-01-15 | trip | СПб
emp_1 | 2026-02-20 | trip | Одинокий день
```

3. Отдельный сервер с копией: `SC_APP_DB=/tmp/test_legacy.db php -S 127.0.0.1:18991 router.php`. Первый запрос /api/trips.php (anon, 401 после миграции) применяет миграцию.

Лог сервера: `T3: legacy trips migration created 3 trip(s)`.

После миграции:

```
schema_version=6
trips_legacy_migrated=1

trips:
trip_...bf0079 | Командировка (миграция) | Москва | confirmed | 1
trip_...f8475  | Командировка (миграция) | СПб    | confirmed | 1
trip_...f637   | Командировка (миграция) | Одинокий день | confirmed | 1

participants:
trip_...bf0079 | emp_1 | 2026-01-10 | 2026-01-12
trip_...f8475  | emp_1 | 2026-01-14 | 2026-01-15
trip_...f637   | emp_1 | 2026-02-20 | 2026-02-20
```

- Группировка: vacation между блоками разорвал серию в 2 командировки; одиночный день — отдельная командировка. Год НЕ ограничивает.
- Аудит: `trip.legacy_migrate` details `{"count":3}`.
- Визуал не меняется: status=confirmed (как было визуально), schedule_entries 'trip'-строки НЕ удалены.

4. Идемпотентность: флаг удалён, повторный запрос миграции — `trips count` остался 3 (0 новых), participants 3, schema_version=6.

Дополнительная проверка (обнаруженная в процессе): если в копии есть trip-entries сотрудника, отсутствующего в employees (осиротевшая FK), конверсия пропускает такие run-ы, не прерываясь (защита от partial-состояния).

---

## 4. curl-примеры (демо на /tmp-копии, порт 18992)

### Создание (admin) → 201
```json
POST /api/trips.php
{"title":"Пулково","location":"СПб","comment":"","participants":[{"employeeId":"emp_1","startDate":"2027-05-10","endDate":"2027-05-12"}]}
→ 201
{
  "success": true,
  "trip": {
    "id": "trip_6a92ed45d7c7a3.02136303",
    "title": "Пулково", "location": "СПб", "comment": "", "status": "forecast",
    "version": 1, "createdBy": "admin",
    "createdAt": "2026-08-29T14:31:33+00:00", "updatedAt": "2026-08-29T14:31:33+00:00",
    "participants": [ {"employeeId": "emp_1","startDate": "2027-05-10","endDate": "2027-05-12"} ]
  }
}
```

### Пересечение vacation → 409
```
POST /api/trips.php {"title":"Overlap","participants":[{"employeeId":"emp_1","startDate":"2027-06-01","endDate":"2027-06-01"}]}
→ http 409
{ "error": "overlapping_entry", "employeeId": "emp_1", "date": "2027-06-01", "status": "vacation" }
```

### Версионный конфликт → 409 (не молча перезаписывается)
```
PUT /api/trips.php?id=trip_6a92ed45d7c7a3.02136303
{"title":"conflict-test","entryVersion":99}
→ 409
{
  "error": "version_conflict",
  "clientVersion": 99, "serverVersion": 1,
  "serverTrip": { ...полный объект trip... }
}
```

### Viewer POST → 403
```
POST /api/trips.php {"title":"x","participants":[{"employeeId":"emp_1",...}]} (viewer_test)
→ http 403 { "error": "forbidden" }
```

### GET список + sync-дельта
```
GET /api/trips.php → success=true, lastSyncId=4798, trips=[Пулково forecast v1 parts=1]
GET /api/sync.php?afterId=0 → tripsChanged keys=['trip_6a92ed45d7c7a3.02136303'], tripsDeleted=[...старые trip_...]
```
(tripsDeleted — события из sync_log прошлых smoke-прогонов, в копии этих trips уже нет → корректно помечены удалёнными.)

---

## 5. Верификация

- `php -l` по всем изменённым/новым файлам — чисто:
  - `api/db.php` — No syntax errors
  - `api/schema.sql` — No syntax errors
  - `api/trips.php` — No syntax errors
  - `api/sync.php` — No syntax errors
  - `api/smoke_test.php` — No syntax errors
- Полный smoke: `php api/smoke_test.php` → **76 passed, 0 failed (100%)**, DB intact: YES.
- Legacy-конверсия: 3 trips, правильная группировка, flag в meta, повторный запуск — 0 новых (доказательство в разделе 3).
- Живая data/app.db: миграция применилась штатно (schema_version=6, trips_legacy_migrated=1, 0 user-trips — тестовые артефакты очищены). Никаких ручных INSERT/UPDATE в живую БД не выполнялось.

## 6. Изменённые файлы

```
api/schema.sql     +39   (DDL trips/trip_participants/indexes, header v6)
api/db.php         +216  (SCHEMA_VERSION=6, миграция v6, migrateLegacyTrips, SC_APP_DB тест-хук)
api/trips.php      NEW 603 строк (эндпоинт «Командировки»)
api/sync.php       +66   (ветка tripsChanged/tripsDeleted + trips_sync_fetch_trip)
api/smoke_test.php +357  (фикстуры g0/g1+employees, блок TRIPS 14 сценариев, очистка)
data/app.db        (миграция v5→v6 при штатном запуске smoke; артефакты очищены)
```

## 7. Риски / замечания

- `SC_APP_DB` — тестовый env-хук для запуска сервера на /tmp-копии; на проде не используется (путь по умолчанию не меняется).
- В trips.php version-conflict для trips применяется ко ВСЕМ ролям (включая admin) — это осознанное отличие от save.php (где admin-оверрайд разрешён): контракт trips явно требует «НЕ молча перезаписывать»; покрыто T3-9 (admin + stale entryVersion → 409).
- Legacy schedule_entries со статусом 'trip' НЕ удаляются на этом этапе (readonly-совместимость фронта до Этапа 5) — по ТЗ.
- Деплой, правка index.html/js/storage.js — вне скоупа T3 (этапы 4-5).