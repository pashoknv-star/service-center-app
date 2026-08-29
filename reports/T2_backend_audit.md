# T2 — Backend-аудит: API/БД/sync/approval/роли под фичу «Командировки»

Дата аудита: 2026-08-29
Объект: /home/hermes/service-center-app (dev-БД data/app.db, PHP 8.3, SQLite, WAL)
Режим: READ-ONLY (код + SELECT/.schema). Никаких writes, сервер не запускался.
Роль аудитора: sd_worker_02 (T2, kanban t_b336e274)

---

## 1. Схема schedule_entries и семантика статусов

### 1.1 DDL (авторитетный источник — api/schema.sql v5)

```sql
CREATE TABLE IF NOT EXISTS schedule_entries (
    employee_id     TEXT,
    date            TEXT,
    status          TEXT,
    comment         TEXT,
    approval_status TEXT    DEFAULT 'draft',
    version         INTEGER NOT NULL DEFAULT 1,
    updated_at      TEXT,
    PRIMARY KEY (employee_id, date),
    FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE
);
```

- Составной PK `(employee_id, date)`. Бизнес-ключ записи = строка `"employee_id:date"` (далее — `entryKey`).
- Индексов, кроме неявного PK, у schedule_entries НЕТ. Запросы в sync.php идут по выражению `employee_id || ':' || date = :k` (индекс не используется — full scan). При росте матрицы стоит добавить индекс по employee_id+date (см. риски).
- `version INTEGER NOT NULL DEFAULT 1` — оптимистичная версия (E8, схема v3).
- `approval_status TEXT DEFAULT 'draft'` — не CHECK-ограничение; допускаются любые строки. Фактически используется `'draft'` и `'approved'`.
- Формат `date`: `'YYYY-MM-DD'` (TEXT). Проверка формата есть только в entries.php POST/PUT (date_create), save.php дату не валидирует.
- `updated_at` — ISO-8601 `date('c')`.

Фактическое состояние dev-БД: в schedule_entries 0 записей (матрица пуста; фикстуры удалены smoke-тестами). Статус-значения в БД сейчас не представлены, но семантика восстанавливается по фронту (index.html, js/storage.js):

| server status | UI-тип (popup) | Комментарий |
|---|---|---|
| `vacation` | Отпуск | отпуск |
| `sick`      | Больничный | больничный |
| `trip`      | Командировка | командировка (уже есть в UI, data-type="trip", TYPE_TO_STATUS.trip='trip') |
| `day_off`   | Отгул | канонизация: UI `dayoff` → сервер `day_off` (E8-2, save.php allowedStatuses супервайзера = ['trip','day_off','dayoff']) |
| (пусто/null) | — | отсутствие записи = рабочий день |

- `comment` для trip семантически = «Город» (placeholder в index.html:3747 «поле комментария = Город для командировки, Причина для отпуска»).

### 1.2 Канонизация статусов

- Фронт: `TYPE_TO_STATUS = { vacation:'vacation', sick:'sick', trip:'trip', dayoff:'day_off' }` (index.html:2564-2570).
- storage.js `legacyToServer`: `status: (type === 'dayoff') ? 'day_off' : type`.
- БД сходится к `day_off`; CSS-алиас `day_off`→`type-dayoff` (index.html:2554-2562).

---

## 2. Полный API-контракт

### 2.1 Общие элементы

- Все ответы JSON: `sendJson($data, $code)` — `Content-Type: application/json; charset=utf-8`, CORS `*`, JSON_PRETTY_PRINT + UNESCAPED_UNICODE.
- Ошибки: `{ "error": "<msg>" }` (коды 400/401/403/404/405/500). `error()` по умолчанию 400.
- Методы: OPTIONS-preflight обрабатывает `handleOptions()` во всех эндпоинтах.
- Сессия: PHP native session, cookie PHPSESSID, httponly, SameSite=Lax (auth.php:32-38).

### 2.2 load.php — GET (require_auth, любая роль)

Вход: —
Выход (ScheduleState):
```json
{
  "version": 1,
  "year": <int, из meta 'current_year', дефолт 2026>,
  "groups":   [ { "id","name","sortOrder" } ],
  "positions":[ { "id","name","sortOrder" } ],
  "employees":[ { "id","fullName","positionId","location","groupId","phone","photoUrl","isTechnical","requiresFullProfile","sortOrder","createdAt","updatedAt" } ],
  "entries":  { "empId:YYYY-MM-DD": { "employeeId","date","status","comment","approvalStatus","version","updatedAt" } },
  "holidays": { "YYYY-MM-DD": { "date","type","label" } },
  "vacationBalances": { "empId:YYYY": { "employeeId","year","totalDays","usedDays","remainingDays" } },
  "lastSyncId": <int, MAX(sync_log.id)>,
  "updatedAt": "<ISO8601>"
}
```
- Чтение НЕ фильтруется по зоне (E8-4: все видят всех).
- `entries`/`holidays`/`vacationBalances` сериализуются как JSON-объекты (не массивы) через `(object)`.
- Ошибки: 401 `unauthorized`; 500 `Server error: <msg>`.

### 2.3 save.php — POST (require_auth + require_edit)

Вход (полное состояние; legacyToServer формирует именно это):
```json
{
  "groups":[ { "id","name","sortOrder" } ],
  "positions":[ ... ],
  "employees":[ { "id","fullName","positionId","location","groupId","phone","photoUrl","isTechnical","requiresFullProfile","sortOrder" } ],
  "entries":{ "empId:YYYY-MM-DD": { "employeeId","date","status","comment","approvalStatus","entryVersion" } },
  "holidays":{ ... },
  "vacationBalances":{ ... },
  "year": <int>
}
```
Семантика — «полное состояние» (full-state sync), НЕ точечный upsert:
- employees/entries/positions/groups: upsert (INSERT ... ON CONFLICT DO UPDATE).
- **SYNC-удаление**: записи schedule_entries за годы, присутствующие в payload (и сотрудники, отсутствующие в payload), удаляются. Записи годов, не представленных в payload, не трогаются. Для супервайзера чужие зоны защищаются от удаления (см. 4.4).
- Транзакция BEGIN/COMMIT вокруг всего.
- Groups/positions/employees обрабатываются только для admin (`$e82IsAdmin`). Supervisor их payload игнорирует.

Выход:
```json
{ "success": true, "savedAt": "<ISO8601>",
  "conflicts": [ { "key","clientVersion","serverVersion","serverEntry" } ],
  "appliedVersions": { "empId:YYYY-MM-DD": <newVersion> },
  "rejections": [ { "key","reason" } ] }
```
- `conflicts` — отторжения по версии (E8).
- `appliedVersions` — финальные версии принятых (включая no-op эхо).
- `rejections` — по-записные отказы супервайзера: `out_of_scope`, `status_not_allowed`, `approved_record_immutable`.
- Ошибки: 400 `Invalid JSON body`, 401/403 (см. auth), 500.

Мерж-логика по записи (порядок проверок в save.php:293-436):
1. Определить empId/date → key.
2. Права супервайзера: зона сотрудника (group_id) == scope_group_id? иначе reject out_of_scope.
3. Статус: только trip/day_off/dayoff для супервайзера? иначе reject status_not_allowed.
4. Approved-guard: существующая запись `approval_status='approved'` и пользователь не admin → reject approved_record_immutable.
5. Конфликт версий: если в payload `entryVersion` (или `version`) и он != server version → conflicts[] (не reject, а конфликт; запись НЕ применяется; keepKeys защищает от SYNC-удаления).
6. No-op эхо: если serverRow совпадает с инкомингом (status+comment+approval) → не инкремент, appliedVersions[key]=serverVersion.
7. Иначе применить: version = serverVersion + 1, sync_log('entry', key, 'upsert'), audit('entry.upsert'), appliedVersions[key]=newVersion.

Ответ конфликта содержит `serverEntry` (полная актуальная запись) — фронт мержит её в матрицу.

### 2.4 sync.php

**GET api/sync.php?afterId=N** (require_auth, любая роль — чтение):
- Курсор = `id` из sync_log. `afterId` — последний обработанный клиентом id; по умолчанию 0.
- Выход:
```json
{ "success": true, "serverTime": "...", "afterId": N,
  "lastSyncId": <MAX(sync_log.id)>,
  "entries": { "empId:date": { "employeeId","date","status","comment","approvalStatus","version","updatedAt" } },
  "deletedEntries": [ "empId:date", ... ],
  "employeesChanged": [ "empId", ... ],
  "employeesDeleted": [ "empId", ... ] }
```
- «Изменением» считается наличие события в sync_log с id > afterId (entity_type entry/employee). Для каждого события сервер отдаёт АКТУАЛЬНОЕ состояние из БД; если записи больше нет — ключ в deletedEntries. События дедуплицируются DISTINCT entity_type+entity_id.
- Чтение не зональное (E8-4) — все видят все изменения.

**POST api/sync.php** (require_auth + require_edit):
- Тело `{ keys: ["empId:date", ...] }` → `{ success, serverTime, lastSyncId, versions: { key: <int> } }` (пред-проверка версий; отсутствующая запись = 0).
- Тело `{ deletes: [ { employeeId, date }, ... ] }` → удаление записей с зональной проверкой (супервайзер только своя зона), sync_log('entry', key, 'delete'). Ответ `{ success, serverTime, lastSyncId, deleted: N }`.
- Ошибки: 401/403, 500.

Формат события sync_log (DDL v3):
```sql
CREATE TABLE sync_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    entity_type TEXT,     -- 'entry' | 'employee'
    entity_id   TEXT,     -- 'empId:date' для entry; 'empId' для employee
    action      TEXT,     -- 'upsert' | 'delete'
    actor       TEXT,     -- username | 'api'
    updated_at  TEXT      -- ISO8601
);
CREATE INDEX idx_sync_log_id ON sync_log(id);
```
Ротация: save.php `sync_log_rotate()` — держит не более 10000 последних событий (DELETE id < max-10000). Если ротация «съест» события, которые клиент ещё не видел, дельта молча потеряется — риск (см. 11).

### 2.5 entries.php — CRUD отдельных записей

| Метод | URL | Права | Вход | Выход | Ошибки |
|---|---|---|---|---|---|
| GET | ?employeeId&year / ?year / ?employeeId / пусто | auth | query | массив нормализованных entries (camelCase, БЕЗ version!) | 401, 500 |
| POST | — | auth+edit (+зона) | body {employeeId,date,status,comment,approvalStatus} | normalizeEntry(row) | 400 missing_*, invalid_date; 403 zone_forbidden / cannot_modify_approved; 401 |
| PUT | ?employeeId&date | auth+edit (+зона) | body {status,comment,approvalStatus} | normalizeEntry(row) | 400; 403 cannot_modify_approved; 404 entry_not_found |
| DELETE | ?employeeId&date | auth+edit (+зона, +admin при force) | body {force} | {success,deleted,employeeId,date} | 403 cannot_delete_approved; admin-only для force; 404 |

ВАЖНО (баг/грань): `normalizeEntry()` (entries.php:365-378) НЕ возвращает `version` (в отличие от load.php/sync.php). PUT/POST в entries.php также не инкрементируют version и не пишут sync_log. То есть точечный CRUD-путь (entries.php) живёт мимо E8-версионирования и мимо polling-дельты — правки через него не доедут до других клиентов через sync.php, пока не будет полного save. Это прямой задел для trips API: делать инкрементальные операции через новый эндпоинт, а не копировать pattern entries.php.

### 2.6 Прочие эндпоинты (карта)

- login.php POST → {success,user:{id,username,displayName,role,canEdit,isAdmin,scopeGroupId}}; errors invalid_credentials(401). audit auth.login / auth.login_failed.
- logout.php, session.php GET {authenticated,user}.
- change_password.php POST (auth) — require_auth; audit password_change.
- employees.php GET/POST/PUT/DELETE (auth / edit; детали в карте 2.7).
- groups.php, positions.php — CRUD admin/supervisor (auth+edit; supervisor только своя зона по scope).
- holidays.php, holidays_provider.php — справочник праздников.
- export.php GET (auth, любая роль) — полный JSON backup ScheduleState (?download=1) без version/lastSyncId.
- audit_export.php GET (require_admin) — выгрузка audit_log xlsx/csv/md.
- import.php POST (require_admin) — восстановление состояния.
- reset.php GET (auth) — полный ScheduleState c no-cache (для кнопки «Сбросить»); НЕ содержит version и lastSyncId.
- upload.php (auth+edit) — фото.
- vacation_import.php POST — ВНЕШНИЙ API по Bearer token (`meta.external_api_token`); импорт отпусков диапазонами, резолв сотрудника по id или ФИО; пишет sync_log (actor=external_api) и audit vacation_import.run.
- debug_token.php, seed_positions.php, init_db.php — CLI/dev.

---

## 3. Approval guard (кто и как правит approved записи)

### 3.1 Где проверяется

1. **save.php:363-374** — supervisor (не admin) при существующей записи `approval_status='approved'` → запись отклоняется (rejections reason `approved_record_immutable`). Admin проходит.
2. **entries.php POST:122-138** — не-admin, существующая approved, новый approvalStatus != 'approved' → 403 `cannot_modify_approved`.
3. **entries.php PUT:222-231** — не-admin, текущая approved, новый approvalStatus != 'approved' → 403 `cannot_modify_approved`.
4. **entries.php DELETE:313-325** — approved без `force` → 403 `cannot_delete_approved`; с `force=true` → только admin (require_admin()).
5. **sync.php POST deletes (sync.php:52-123)** — НЕ содержит approved-guard! Супервайзер своей зоны может удалить approved-запись напрямую через sync.php POST deletes. Есть зональная проверка, но не approval. Расхождение с entries.php — риск (см. 11.1).

### 3.2 Паттерн

- Guard применяется ТОЛЬКО к не-админам (supervisor). Admin всегда может править и удалять approved.
- Supervisor НЕ может изменить approved запись даже на другой approved (в save.php guard срабатывает на любую попытку записи по approved-строке, независимо от нового approvalStatus).
- «Кто может ставить approved»: любая роль с can_edit (supervisor/admin) может УСТАНОВИТЬ approval_status='approved' (проверок на «кто согласовывает» нет — только защита от снятия). Это важно для trips: кто одобряет командировку — потребует отдельной политики.

---

## 4. Роли и авторизация

### 4.1 Модель

- `users` таблица: `can_edit` (0/1), `is_admin` (0/1), `scope_group_id` (TEXT, зона-группа).
- `user_role($row)` (auth.php:90-99): `is_admin` → `admin`; `can_edit` → `supervisor`; иначе `viewer`.
- Сессия: PHP $_SESSION['user_id'] → users.id (current_user(), кэш в статике).

Dev-БД пользователи: admin (admin, scope NULL), supervisor_zone0 (can_edit=1, scope g0), supervisor_zone1 (can_edit=1, scope g1), viewer_test (0,0,scope NULL).

### 4.2 Механизм защиты эндпоинтов

- `require_auth()` — 401 если не залогинен.
- `require_edit()` — 401 если не залогинен; 403 если !is_admin && !can_edit.
- `require_admin()` — 401/403.
- `can_edit_group(?groupId)` (auth.php:164-187): admin → true; viewer → false; supervisor → `groupId !== null && groupId === scope_group_id`.
- `require_group_edit(?groupId)` — обёртка над can_edit_group.

Паттерн доезда роли до эндпоинта: каждый endpoint сам вызывает require_* и делает зональные SELECT group_id из employees для целевого сотрудника. (Роль НЕ передаётся через middleware-контекст; проверки инлайновые.)

### 4.3 Ролевая матрица (факт)

| Действие | viewer | supervisor | admin |
|---|---|---|---|
| load/sync GET/reset/export | да | да | да |
| save.php POST | 403 (require_edit) | да, но только trip/day_off и своя зона | да (полный) |
| entries.php POST/PUT/DELETE | 403 | да, своя зона, без approved-редактирования | да |
| entries.php DELETE approved | 403 | 403 | да (force) |
| sync.php POST deletes | 403 | да, своя зона (без approved-guard!) | да |
| employees/groups/positions CRUD | 403 | supervisor: своя зона (groups.php проверяет scope) | да |
| import.php, audit_export.php | 403 | 403 | да |
| Изменение approved | нет | нет | да |

### 4.4 Зональный скоуп

- supervisor_zone0 → g0, supervisor_zone1 → g1 (scope_group_id).
- Зона сотрудника = `employees.group_id`.
- save.php/sync.php/entries.php проверяют `group_id === scope_group_id` per-записи.
- Чтение зоной НЕ ограничено (E8-4, по требованию владельца).

Паттерн для нового trips API: копировать route-уровень (require_auth/require_edit/require_admin) + по-записную зональную проверку через group_id сотрудника + approved-guard.

---

## 5. Механизм миграций схемы

### 5.1 Как применяется DDL

- `Database::SCHEMA_VERSION = 5` (db.php:30).
- `migrate()` (db.php:97-135): если `meta.schema_version >= 5` → no-op; иначе:
  1. `file_get_contents(schema.sql)` — полный файл с `CREATE TABLE IF NOT EXISTS ...` (идемпотентно);
  2. `applyIncrementalMigrations($current)` — пошаговые ALTER для существующих БД:
     - v1→v2: `ALTER TABLE users ADD COLUMN scope_group_id TEXT` (addColumnIfNotExists);
     - v2→v3: `ALTER TABLE schedule_entries ADD COLUMN version INTEGER NOT NULL DEFAULT 1` + CREATE sync_log;
     - v3→v4: CREATE audit_log + idx_audit_log_ts;
     - v4→v5: cleanupAuditLog() (одноразовая чистка старее 7 дней);
  3. `setMeta('schema_version', 5)`.
- `addColumnIfNotExists()` использует `PRAGMA table_info` — идемпотентно.
- SQLite-ограничение: `ALTER TABLE ADD COLUMN ... NOT NULL` допустим только с DEFAULT — у version есть DEFAULT 1. Новые NOT NULL-колонки без DEFAULT потребуют другой стратегии.
- Прагма `foreign_keys=ON` вырезается из schema.sql перед выполнением (нельзя менять внутри транзакции).

### 5.2 Когда вызывается

- `migrate()` вызывается в начале КАЖДОГО эндпоинта (load/save/sync/entries/login/...): `$db->migrate()`.
- Значит, runtime-миграция = «грязный» паттерн: первый же HTTP-запрос после деплоя нового кода применяет DDL автоматически. Для prod это работает (не нужно пересоздавать app.db), но цена — миграция может выполниться на чтении (GET load) и при конкурентных запросах.

### 5.3 Как безопасно добавить trips/trip_participants (рекомендация)

Прод-БД перезаписывать нельзя (DEPLOY_HOSTLAND.md; данные в data/app.db). Безопасный путь:
1. В schema.sql добавить `CREATE TABLE IF NOT EXISTS trips (...)` и `trip_participants (...)` (идемпотентно — старые БД получат их при первом migrate).
2. Поднять `SCHEMA_VERSION` до 6 и в `applyIncrementalMigrations()` при `$current < 6` выполнить те же CREATE TABLE IF NOT EXISTS (для БД, где схема уже накатана файлом, но версия старая — это безопасный дубль).
3. Никаких ALTER c NOT NULL без DEFAULT; для FK на employees использовать `ON DELETE CASCADE` где уместно, `ON DELETE SET NULL` для опциональных.
4. Развернуть НОВЫЙ код (php-файлы) → первый запрос сам применит миграцию. Либо предварительно прогнать `php api/init_db.php` на проде по инструкции DEPLOY_HOSTLAND (но CLI на проде — PHP 5.3, см. AGENTS.md: smoke-test на хостинге нельзя! init_db требует PHP с password_hash и типизацией — на 5.3 не пойдёт; деплой через файлы + runtime-migrate).
5. Обязательно бэкап data/app.db перед выкладкой (правило AGENTS.md).

---

## 6. audit_log и sync_log

### 6.1 audit_log (E5, схема v4)

```sql
CREATE TABLE IF NOT EXISTS audit_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    ts          TEXT,          -- ISO8601
    actor       TEXT,          -- username или 'api'
    role        TEXT,          -- admin|supervisor|viewer|anonymous
    action      TEXT,          -- auth.login, entry.upsert, entry.delete, employee.create/update/delete, ...
    entity_type TEXT,          -- user|entry|employee|group|position|holiday|system
    entity_id   TEXT,
    details     TEXT           -- JSON
);
CREATE INDEX idx_audit_log_ts ON audit_log(ts);
```

- Пишется: login/login_failed/logout/password_change (auth-путь), entry.upsert/delete (save.php, entries.php), employee.create/update/delete (save.php, employees.php), photo.upload, import.run, vacation_import.run, reset.run, position/group/holiday upsert/delete.
- Вызывается функция `audit($pdo, $action, ...)` — ТОЛЬКО внутри транзакции, через PDO соединение; actor/role автозаполняются из current_user()/user_role().
- Ретенция: 7 дней. Механизм:
  - `migrate()` при v4→v5 — разовая чистка;
  - `audit()` при каждой записи с вероятностью 5% вызывает `audit_cleanup($pdo)` (DELETE ts < now-7d);
  - идемпотентное `CREATE TABLE IF NOT EXISTS` внутри audit() (для путей без migrate).
- Наблюдение из dev-БД: 634 entry.upsert, 504 entry.delete, 383 auth.login, 36 auth.login_failed, 49 employee.create, 41 employee.update, 94 employee.delete, 34 vacation_import.run. Очистка активно работает (id до ~1867 при тысячах событий).
- Потребители: audit_export.php (admin, xlsx/csv/md).

### 6.2 sync_log (E8, схема v3)

- DDL см. п.2.4. Пишут: save.php (entries/employees upsert+delete), sync.php POST deletes, vacation_import.php (actor=external_api).
- Каждое изменение entities пишет строку; дельта-клиент читает id > курсор.
- Ротация save.php: ≤10000 событий.
- Потенциальная потеря при ротации (после >10k изменений между poll-циклами) — см. риски.

---

## 7. Системные уведомления на backend

### 7.1 Вывод: выделенного push/poll-уведомлений НЕТ

- Нет WebSocket/SSE/серверных очередей/таблицы notifications; grep по api/ не находит notification-API.
- Ближайший механизм — **polling-дельта sync.php** (E8): клиент каждые 20 сек + на focus делает `GET api/sync.php?afterId=cursor` (index.html:5170-5207), мержит entries/deletedEntries/employees*, показывает toast «Матрица обновлена: другой пользователь внёс изменения» (index.html:5192-5195) и бейдж «обновлено HH:MM» (updateBadge).
- Конфликтные отторжения → toast «Часть правок отклонена: ячейку изменил другой пользователь» (index.html:5155-5157).
- Это ровно тот канал, который можно расширить для «Заведена новая командировка»: trips должны писаться в sync_log (entity_type='trip') и/или получать собственный лёгкий poll-эндпоинт; видимость — всем аутентифицированным (как E8-4).

### 7.2 Мультипользовательский режим

- Существует: любой пользователь с can_edit может править (в своей зоне/статусе), polling-дельты разъезжаются всем.
- Но уведомления «на кого-то конкретно» (например, супервайзеру о новой заявке) не реализованы нигде.

---

## 8. Конфликты: точная механика optimistic concurrency

- Поле: `schedule_entries.version` (INTEGER NOT NULL DEFAULT 1).
- load.php/sync.php отдают `version` каждой записи; фронт хранит по-дневную карту `window.__syncVersions['empId:YYYY-MM-DD']` (index.html:5046-5062, storage.js versionMap, mergeAdjacentRanges сохраняет max-версию на диапазон, но по-дневная карта — single source of truth).
- Клиент при save вкладывает `entryVersion` в каждую запись диапазона (storage.js:375-376): `if (typeof vmap[key] === 'number') entry.entryVersion = vmap[key];` — локальные новые правки шлются БЕЗ entryVersion → принимаются безусловно.
- Сервер (save.php:305-389):
  - serverVersion = SELECT version FROM schedule_entries (0, если нет строки);
  - `$clientVersion = $entry['entryVersion'] ?? $entry['version'] ?? null;`
  - если не-admin и clientVersion !== null и clientVersion !== serverVersion → конфликт:
    ```php
    $conflicts[] = [
        'key'           => $key,
        'clientVersion' => (int) $clientVersion,
        'serverVersion' => $serverVersion,
        'serverEntry'   => $serverRow ?: null,
    ];
    $keepKeys[$key] = true;  // защита от SYNC-удаления
    continue;
    ```
  - принято → version = serverVersion + 1.
- Фронт (handleConflicts, index.html:5133-5158): принимает serverEntry (applyServerEntry), различает «эхо» собственного инкремента (clientVersion+1==serverVersion или ключ в appliedVersions) от реального конфликта; тост только для реального.
- Как не получить silent overwrite: для trips повторить в точности этот паттерн (version на строку + entryVersion в payload + conflicts[] в ответе + appliedVersions канонизация) — НЕ копировать entries.php, где version не трогается вовсе.

---

## 9. Валидация пересечений (сейчас)

- save.php и entries.php НЕ проверяют пересечения отпуск/отгул/командировка для одного сотрудника на одну дату (PK (employee_id,date) допускает только одну запись на дату, но НЕ запрещает «два отпуска подряд перекрывающихся диапазонов» — диапазон распаковывается по дням, и на каждый день одна строка; перекрытие двух типов невозможно по PK).
- Фактически пересечение «командировка+отпуск» на ОДНИ сутки невозможно на уровне данных (одна строка на дату). Пересечения родов (например, отпуск 5 дней и командировка 2 дня внутри) превращаются в конфликт «последний пишет поверх» — фронт распаковывает ranges и они могут перезаписать друг друга по дням.
- Проверки диапазонов/валидации «нет перекрытия» на backend НЕТ (ни в save, ни в entries). Единственная защита от невалидных дат — `date_create()` в entries.php POST/PUT.
- Для trips: запрет «командировка + отпуск/отгул на пересекающиеся даты» потребует НОВОЙ проверки (диапазонная валидация до записи, в транзакции). Паттерн-основа есть только для одиночной записи; диапазонной бизнес-логики нет.

---

## 10. Генерация ID сущностей

- Серверные ID генерирует **сервер** (PHP) через `genId($prefix) = uniqid($prefix, true)` (helpers.php:95-98) — например `emp_6548b12c1a9f04.12345678`. В dev-БД встречаются emp_1, emp_qc6d_1787771726, emp_qc6d_1787771738 (и legacy-числовые, пришедшие от фронта).
- Фронт (legacyToServer) формирует ID сотрудников как `'emp_' + legacyId` (storage.js:325), где legacyId — числовой id из локального каунтера. То есть ID могут приходить и с клиента (emp_<int>).
- groups/positions: клиентские стабильные слаги `g<dept>` / `pos_<slug>` (storage.js:296-319).
- entries: составной ключ `empId:date`, клиент его же использует.
- Для trips: рекомендация — серверный `genId('trip_')` при создании через новый эндпоинт, а не клиентский UUID (единообразно с employees); участники — `trip_participants` PK (trip_id, employee_id).

---

## 11. Риски и грань существующей архитектуры

### 11.1 Риски

1. **sync.php POST deletes не имеет approved-guard** (sync.php:52-123): супервайзер своей зоны может удалить approved-запись. entries.php DELETE защищает (403/require_admin), save.php защищает (approved_record_immutable), sync.php — нет. Несоответствие.
2. **entries.php (POST/PUT/DELETE) не пишет version и sync_log**: правки через точечный CRUD не подхватываются polling-дельтой других клиентов и не версионируются. Несогласованность двух write-путей.
3. **Sync-дельта может потеряться при ротации**: sync_log_rotate удаляет старые события при id > 10000. Клиент с курсором < (max-10000) получает дельту с молчаливыми дырками (нет маркера «пропущено»). Курсор хранится только в памяти (window.__syncCursor), после перезагрузки load.php отдаёт актуальный lastSyncId → дыры не так страшны, но в активной многопользовательской сессии возможны.
4. **Отсутствие индексов на schedule_entries**: sync.php и save.php выборки по `employee_id`, `date` и `employee_id || ':' || date` — full scan PK-таблицы; при тысячах записей матрицы станет заметно. Рекоменд. `CREATE INDEX idx_entries_emp_date ON schedule_entries(employee_id, date)`.
5. **Отсутствие миграций со сложными ALTER**: только ADD COLUMN с DEFAULT; любые rename/rebuild требуют ручного SQL в applyIncrementalMigrations с бэкапом.
6. **Нет CHECK/ENUM** на status/approval_status — возможны «мусорные» значения; валидация только на прикладном уровне (и то не вся: save.php не валидирует status вообще).
7. **Производственный деплой на PHP 5.3**: код с type hints/strict_types не запускается CLI-путями на хостинге; runtime-migrate выполняется первым HTTP-запросом — нужен аккуратный rollout (сначала файлы, потом проверка grep-маркеров/HTTP-кодов).
8. **Нет ограничения «кто согласовывает»**: любой can_edit может поставить approved. Для командировок понадобится явная политика (например, только admin/руководитель зоны).
9. **current_year в dev-БД = 2099** (meta) — тестовая аномалия; при импорте/отображении матрицы фронт может уехать в 2099. Стоит почистить перед выкладкой.

### 11.2 Что НЕ надо копировать из существующего кода в trips API

- Full-state sync-удаление «по отсутствию в payload» (п.2.3) — для trips нужен точечный CRUD/статусный workflow, иначе удаление трипа случайно затронет чужие записи.
- Паттерн entries.php без version/sync_log (см. риск 2).
- Паттерн sync.php deletes без approved-guard (см. риск 1).

---

## 12. Рекомендуемая модель trips/trip_participants + версии (ЭСКИЗ, не реализация)

> Цель раздела — дать архитектурную заготовку для декомпозиции (T3+): эскиз схемы и контрактов, согласованный с существующими паттернами (version/entryVersion/conflicts/appliedVersions из E8, зоны из E8-2/E8-3, аудит E5). Не реализация.

### 12.1 Схема (миграция v6)

```sql
-- Миграция v5 → v6 (db.php applyIncrementalMigrations, $current < 6)
CREATE TABLE IF NOT EXISTS trips (
    id             TEXT PRIMARY KEY,            -- genId('trip_')
    title          TEXT NOT NULL,               -- цель/название
    city           TEXT,                        -- город (комментарий legacy 'trip' = город)
    start_date     TEXT NOT NULL,               -- 'YYYY-MM-DD'
    end_date       TEXT NOT NULL,
    status         TEXT NOT NULL DEFAULT 'draft', -- draft | submitted | approved | rejected | cancelled
    approval_status TEXT NOT NULL DEFAULT 'draft',
    comment        TEXT,
    created_by     TEXT,                        -- username
    approved_by    TEXT,                        -- username при согласовании
    trip_admin_id  TEXT,                        -- ответственный (FK employees SET NULL)
    version        INTEGER NOT NULL DEFAULT 1,  -- E8-паттерн
    created_at     TEXT,
    updated_at     TEXT
);
CREATE TABLE IF NOT EXISTS trip_participants (
    trip_id     TEXT NOT NULL,
    employee_id TEXT NOT NULL,
    is_lead     INTEGER DEFAULT 0,              -- руководитель поездки
    PRIMARY KEY (trip_id, employee_id),
    FOREIGN KEY (trip_id)     REFERENCES trips(id)     ON DELETE CASCADE,
    FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_trips_dates ON trips(start_date, end_date);
CREATE INDEX IF NOT EXISTS idx_trip_participants_emp ON trip_participants(employee_id);
```

- `version` на trips — по образцу schedule_entries (оптимистичная конкуренция; клиент шлёт entryVersion, сервер сверяет и инкрементирует).
- Участников версионировать не нужно (пересборка множества вместе с trips-строкой).
- `approval_status` для trips отдельно от schedule_entries — у командировки свой workflow; НЕ путать с approved-guard ячеек матрицы.

### 12.2 Контракты эндпоинтов (эскиз)

**GET api/trips.php** (require_auth) — список трипов (все аутентифицированные; зона не фильтрует чтение, как E8-4):
```json
{ "success": true, "trips": [ { "id","title","city","startDate","endDate","status",
   "approvalStatus","comment","createdBy","approvedBy","tripAdminId",
   "participants": ["emp_1","emp_2"], "version", "updatedAt" } ], "lastSyncId": N }
```
- Пагинация/год по query `?year=YYYY` (substr(start_date,1,4)), как entries.php.

**POST api/trips.php** (require_auth + require_edit + зональная проверка ВСЕХ участников: каждый employee.group_id ∈ {scope_group_id} для supervisor; admin — без ограничений) — создать:
- Вход: `{ title, city, startDate, endDate, status?, comment?, tripAdminId?, participantIds: [...] }`.
- Сервер: genId('trip_'), INSERT trips + participants (транзакция), version=1, sync_log('trip', id, 'upsert') — **чтобы уведомление «Заведена новая командировка» доехало через polling-дельту** (п.7).
- Выход: `{ success, trip: {...}, version: 1 }`.
- Ошибки: 400 invalid_dates / date_range_invalid / participants_required / participant_not_found; 403 zone_forbidden; 409 overlapping (если введена бизнес-проверка).

**PUT api/trips.php?id=** (require_auth + require_edit + зона):
- Вход: `{ ...поля, entryVersion }`.
- Сервер: SELECT version → сверка → конфликт (как save.php:376-389) либо инкремент.
- Approved-guard: не-admin НЕ может менять/снимать status='approved' (копия паттерна 3.1); approved может ставить только (политика) admin или супервайзер зоны, и только `draft→submitted→approved` вперёд.
- Выход: `{ success, trip: {...}, version: newVersion, conflict: null|{clientVersion,serverVersion,serverTrip} }`.

**DELETE api/trips.php?id=** (require_auth + require_edit + зона):
- approved ⇒ только admin + `force` (копия entries.php DELETE:318-325); sync_log('trip', id, 'delete').

**POST api/trips.php/approve** (или PUT ?action=approve) — статусный переход:
- `submitted → approved` (кто: admin или руководитель зоны; фиксировать approved_by).
- Вход `{ id, entryVersion }`; выход как PUT.

### 12.3 Пересечения (командировка ↔ отпуск/отгул)

- Проверку выполнять в транзакции при создании/изменении: для каждого участника и каждой даты из [start_date..end_date] проверить отсутствие schedule_entries(status='vacation'|'sick'|'trip'|'day_off') с пересечением.
- Паттерн-основа: PK (employee_id,date) уже исключает двойную запись на дату; нужна только проверка диапазона ДО вставки:
```sql
SELECT 1 FROM schedule_entries
 WHERE employee_id = :eid AND date BETWEEN :start AND :end
   AND status IN ('vacation','sick','trip','day_off') LIMIT 1;
```
- Ответ 409 `overlapping_entry { employeeId, date, status }`. Замечание: существующий код пересечения НЕ проверяет (см. п.9) — для trips это добавляется.

### 12.4 Уведомления

- «Заведена новая командировка»: через существующий polling-канал — записать sync_log('trip', id, 'upsert'); sync.php расширить веткой entity_type='trip' (по образцу entry/employee, sync.php:192-221). Фронт (SyncClient.applyDelta) получит tripsChanged/tripsDeleted и покажет toast. Никаких новых push-механизмов не требуется; при желании — отдельный лёгкий GET api/trips.php?changedAfter=N.

### 12.5 Не забыть

- Зональный write-guard для участников (E8-2/E8-3 паттерн, по-записный).
- version/entryVersion/conflicts/appliedVersions (E8 паттерн) — единообразно с matrix.
- audit($pdo, 'trip.create' / 'trip.update' / 'trip.approve' / 'trip.delete', ...) — по образцу entry.*.
- sync_log запись на каждое изменение для дельты.
- Миграция через schema.sql + applyIncrementalMigrations($current < 6) + SCHEMA_VERSION=6; НЕ пересоздавать app.db.

---

## Приложение A. Карта файлов и строк (доказательная база)

| Файл | Строки | Содержимое |
|---|---|---|
| api/schema.sql | 56-66 | DDL schedule_entries с version |
| api/schema.sql | 120-128 | DDL sync_log + idx |
| api/schema.sql | 134-144 | DDL audit_log + idx |
| api/db.php | 30, 97-135, 145-194 | SCHEMA_VERSION=5; migrate(); пошаговые миграции v1..v5 |
| api/db.php | 203-214 | addColumnIfNotExists (PRAGMA table_info) |
| api/auth.php | 32-38, 47-74, 90-99, 123-202 | сессия; current_user; user_role; require_auth/edit/admin; can_edit_group |
| api/load.php | 25, 96-112, 150-168 | require_auth; entries с version; lastSyncId |
| api/save.php | 26-27, 69-194, 262-436, 438-519, 587-605 | require_edit; E8-2 роли; версионность+guard; SYNC-удаление; ротация; ответ |
| api/save.php | 363-374 | approved guard (approved_record_immutable) |
| api/save.php | 376-389 | конфликт версий (conflicts[]) |
| api/sync.php | 36, 157-234 | require_auth; GET дельта; DISTINCT; актуальное состояние |
| api/sync.php | 48-123 | POST deletes; зона; БЕЗ approved-guard |
| api/entries.php | 122-138, 222-231, 313-325 | approved guards POST/PUT/DELETE |
| api/entries.php | 365-378 | normalizeEntry — БЕЗ version |
| api/helpers.php | 36-45, 95-98, 150-228 | sendJson; genId (uniqid); audit() |
| api/vacation_import.php | 45-60, 61+ | Bearer-API; внешний импорт |
| js/storage.js | 151-251, 285-396 | serverToLegacy / legacyToServer; dayoff→day_off; entryVersion |
| js/storage.js | 370-376 | entryVersion из __syncVersions |
| index.html | 2554-2570 | TYPE_CSS aliases; TYPE_TO_STATUS (trip:'trip', dayoff:'day_off') |
| index.html | 4898-5225 | SyncClient: poll 20s, applyDelta, handleConflicts, toasts |
| index.html | 5170-5195 | poll(); toast «другой пользователь внёс изменения» |
| index.html | 5133-5158 | handleConflicts: эхо vs реальный конфликт |
| api/reset.php | 25, 121-131 | require_auth; ScheduleState без version/lastSyncId |
| api/E8_SYNC.md | весь | протокол E8 (полезно для trips-дизайна) |

## Приложение B. Наблюдения из live dev-БД (SELECT-only)

- meta: schema_version=5, external_api_token=..., current_year=2099 (аномалия).
- users: admin, supervisor_zone0 (can_edit=1, g0), supervisor_zone1 (can_edit=1, g1), viewer_test.
- groups: g0..g6 (g0=Smoke Fixture Group, g1=Группа эксплуатации, ..., g6=Транспорт).
- employees: 1 (emp_1, Smoke Fixture Employee).
- schedule_entries: 0 строк.
- holidays: каталог в data/holidays/.
- sync_log: последние события emp_qc6d_* (удаления фикстур smoke-тестов), id до ~4573.
- audit_log: 634 entry.upsert / 504 entry.delete / 383 auth.login / 36 auth.login_failed; из них видно ежедневную очистку E5-4 (id растёт медленно).

## Приложение C. Проверки (что было выполнено)

- Чтение всех файлов scope (api/*.php, js/storage.js, index.html SyncClient, schema.sql, E8_SYNC.md).
- sqlite3 .schema и SELECT (только чтение) по meta/users/groups/employees/schedule_entries/audit_log/sync_log.
- Сервер не запускался, записей в БД не делалось. Единственный write — настоящий файл отчёта reports/T2_backend_audit.md.