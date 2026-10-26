# AUDIT-2026-10 — Блок G: качество кода и сопровождаемость

Исполнитель: sd_worker_04 (kanban t_8e772872). Коммит: `101c846` (detached worktree `/home/hermes/audit-wt/w4`, собственная копия dev-БД). Дата: 2026-10-25.
Режим: ревью + план. В репозитории ничего не правилось; ручные проверки на dev — свой сервер на порту 8094 (остановлен), после каждой изменяющей серии `git checkout -- data/app.db`. Штатные сьюты поднимали собственные временные серверы: smoke — случайный порт 18880–19380, `scripts/test_trips_frontend.sh` — жёстко 8091 (порт не настраивается, см. G-07); оба остановлены самими скриптами. К проду запросов этот блок не делал (данные прода — из 00_MAP.md).

СТАТУС: завершено.

## 1. Резюме

Штатные тесты зелёные (smoke 76/76, e51 23/23, e52 41/41, hygiene 19/19, trips 7/7), но они не проверяют главные защитные механизмы проекта. У guard'ов E10 против массового стирания (их ввели после трёх инцидентов с потерей данных на проде), у relay HelpMe, у восстановления через import.php и у безопасности (XSS/CSRF/эндпоинты без auth) регрессионных тестов нет (G-03).
Главный архитектурный дефект — правила роли, зоны и approved реализованы inline: 9 копий зональной проверки (entries.php ×3, sync.php ×1, save.php ×2, trips.php ×3) с тремя разными семантиками. Параллельные REST-эндпоинты, которыми UI не пользуется (entries/employees/groups/positions/sync-deletes), обходят правила save.php. На dev подтверждено: supervisor создаёт и меняет утверждённые отпуска/больничные и удаляет approved-записи, viewer удаляет записи через `PUT sync.php` (G-01; часть, относящаяся к безопасности, передана в A).
Во фронтенде две несовместимые модели зоны: матрица берёт зону из username `supervisor_zoneN` (G-02).
Сопровождаемость: тройная копия сборки состояния (load/reset/export), legacy-путь `trip` открыт, ~200 строк мёртвого кода, CODEMAP устарел на 21% ссылок, API_DOCUMENTATION.json не обновлялся с baseline, у ответов API три формы ошибок, `$e->getMessage()` отдаётся клиенту в 19 местах.
Итого 11 находок: P0 — 0, P1 — 2, P2 — 6, P3 — 3. В первую очередь (до следующей фазы): G-01 (единая политика + закрыть непубличные пути записи) и G-03 (регрессионные тесты E10/relay/import/G-01).

## 2. Таблица находок

| ID | P | Категория | Место | Заголовок | Уверенность |
|---|---|---|---|---|---|
| G-01 | P1 | G (+B), CWE-863/1041 | api/sync.php:95-101; api/entries.php:103-158,208-246; api/employees.php:138-139,240-241; api/groups.php:58-59; api/save.php:458-530 | Правила роли/зоны/approved продублированы (9 inline-копий зональной проверки) и расходятся; непубличные эндпоинты обходят правила save.php | подтверждено (код + dev) |
| G-03 | P1 | G | api/smoke_test.php; scripts/*; api/save.php:202-247,328-351,621-645,138-174 | Нет тестов guard'ов E10, relay, import-восстановления, безопасности | подтверждено (прогон + код) |
| G-02 | P2 | G (+E), CWE-1041 | index.html:3885-3913; js/trips.js:2069-2104; api/auth.php:107-119 | Две модели зоны во фронтенде; матрица определяет зону по username | подтверждено по коду |
| G-04 | P2 | G (+B) | api/db.php:292-323,430; api/save.php:492; index.html:2762 | Legacy `status='trip'` не закрыт на сервере, миграция одноразовая | подтверждено по коду |
| G-05 | P2 | G (+C) | api/load.php:36-169; api/reset.php:30-130; api/export.php:33-138 | Тройная копия сборки состояния, расхождения; reset.php мёртв | подтверждено по коду |
| G-07 | P2 | G | test_*.sh/php (корень); js/test_trips_overlay.js; scripts/test_trips_frontend.sh:24-33; scripts/check_syntax.js:7; api/init_db.php:20-21 | Тестовый набор невоспроизводим: устаревшие/сломанные скрипты, пустой тест, нет E2E, хардкод порта/пути | подтверждено (прогон + код) |
| G-09 | P2 | G | docs/API_DOCUMENTATION.json | Документация API не обновлялась с baseline: нет trips/relay/audit_export, неверные auth/методы/коды | подтверждено по коду |
| G-10 | P2 | G, CWE-209 | api/helpers.php:53-57,124-127; 19 catch-блоков (список в G-10) | Три формы ошибок, человекочитаемые коды, getMessage() клиенту | подтверждено (код + dev) |
| G-06 | P3 | G, CWE-561 | js/trips.js:987,1291,1499,1874,2866,3001; index.html:3460,4016,4029,5598 | Мёртвый код: legacy-модалка командировок, невызываемые helpers/CSS | подтверждено по коду |
| G-08 | P3 | G | CODEMAP.md | CODEMAP устарел (50/237 ссылок смещены), не покрывает api/ | подтверждено (скрипт сверки) |
| G-11 | P3 | G | index.html:6-1948, 2488-5819 | Монолит index.html; бизнес-правила продублированы в UI | подтверждено по коду |

## 3. Детальные находки

### 3.0. Прогон тестов в worktree (факт, 2026-10-25 12:49–12:50 +05)

| Набор | Команда | Результат |
|---|---|---|
| Backend smoke | `php api/smoke_test.php` | **76 passed, 0 failed out of 76**, «DB intact: YES», exit 0; после прогона `data/app.db` изменена (`git diff --stat`: 1683456 → 1699840 Б) → возвращена `git checkout -- data/app.db` |
| e51 | `node scripts/test_e51_pick_geometry.js` | **23 passed, 0 failed**, exit 0 |
| e52 | `node scripts/test_e52_pick_semantics.js` | **41 passed, 0 failed**, exit 0 |
| hygiene | `node scripts/test_r4_hygiene.js` | **19 passed, 0 failed**, exit 0 |
| trips frontend | `bash scripts/test_trips_frontend.sh` | **7/7 PASS**, exit 0; оставил в корне неотслеживаемый `test_cookies.jar` (удалён вручную, см. G-09) |
| E2E-харнесс | `/tmp/e5_final.js`, `/tmp/e6_final.js` | **файлов нет** (`ls: cannot access`) — прогнать невозможно, см. G-08 |
| доп.: `node js/test_trips_overlay.js` | — | exit 0, **0 строк вывода**: файл только объявляет функции/экспорт, тесты не вызываются (см. G-08) |
| доп.: `node scripts/check_syntax.js index.html` | — | 1 inline-скрипт, синтаксис OK (без аргумента скрипт проверяет файл ОСНОВНОГО каталога — хардкод пути, см. G-09) |

Итог: все штатные сьюты зелёные (76 + 23 + 41 + 19 + 7 = 166 проверок, 0 fail). Зелёный прогон при этом НЕ покрывает ни одного из дефектов G-01…G-03, подтверждённых ниже на dev, — см. матрицу покрытия G-04.

### G-01 | Правила роли/зоны/approved реализованы inline (9 копий зональной проверки) и расходятся между эндпоинтами; параллельные REST-эндпоинты без потребителя во фронтенде обходят правила save.php | P1 | G (+B; CWE-863, CWE-1041)

**Место:** `api/save.php:92,111,181` (groups/positions/employees — только admin), `api/save.php:458-483` (зона), `:491-502` (только trip/day_off), `:504-515` (approved immutable), `:517-530` (версия); `api/entries.php:103-116,132-138` (POST), `:208-246` (PUT), `:301-340` (DELETE); `api/sync.php:95-97,101-172`; `api/trips.php:437-459,555-572,579-581,716-718,803`; `api/employees.php:90-91,138-139,240-241`; `api/groups.php:58-59,84-85,133-134`; `api/positions.php:58-59,84-85,133-134`; `api/holidays.php:20-21` (auth не подключён); неиспользуемые `api/auth.php:164-202` (`can_edit_group`, `require_group_edit`).

**Матрица проверок (по коду 101c846, расхождения подтверждены на dev):**

| Правило | save.php (UI) | entries.php | sync.php POST/PUT deletes | trips.php | employees.php | groups.php / positions.php | holidays.php |
|---|---|---|---|---|---|---|---|
| Аутентификация | require_auth :26 | require_auth (все методы) | require_auth :36 | require_auth :387 | require_auth | require_auth | **нет** |
| Право записи | require_edit :27 | require_edit | **require_edit только если метод POST** (:95-97), блок deletes выполняется для ЛЮБОГО метода (:101) | require_edit :407 | require_edit | require_edit | **нет** |
| Admin-only сущности | groups/positions/employees только admin (:92,:111,:181) | — | — | — | **supervisor может create/update/delete любого сотрудника** | **supervisor может create/update/delete** | **любой, включая анонима** |
| Зона supervisor | по `scope_group_id`; сотрудник без группы → out_of_scope (fail closed, :467-471) | сотрудник без группы / несуществующий → **проверка пропускается** (fail open, :110) | то же fail open (:124) | без группы → foreign (fail closed, :449-451, :566) | **нет зональной проверки** | — | — |
| Разрешённые статусы supervisor | только `trip`/`day_off`/`dayoff` (:492) | **любой статус (vacation, sick…)** | — (удаление любого статуса) | n/a | n/a | n/a | n/a |
| approved/confirmed guard | любое изменение approved запрещено не-admin (:506) | запрещено только ПОНИЖЕНИЕ approved→не-approved (:132-138, :244); **смена status/comment при approved разрешена**; создание сразу `approved` разрешено | **guard отсутствует** — supervisor удаляет approved | confirmed_immutable (:579, :716) | — | — | — |
| Версия E8 (`version`) | +1 на каждую запись (:558) | **не увеличивается** (INSERT/UPDATE без `version`) | n/a | entryVersion (T3-8/9) | — | — | — |
| sync_log (E10-6 freshness) | да | POST/DELETE да (:175-186, :355-367), **PUT нет** (:276-281) | да | да | **нет** | **нет** | **нет** |
| audit | да | да | **нет** (удаления через sync.php не аудируются) | да | да | да | да |

**Доказательство (минимальное):**
```php
// api/sync.php:95-101 — guard записи только для POST, обработка deletes — для любого метода
if ($method === 'POST') {
    require_edit();
}
$body = getJsonBody();
if (isset($body['deletes']) && is_array($body['deletes']) && $body['deletes'] !== []) {
// api/entries.php:110 — fail open, если у сотрудника нет группы
if ($empGroupId !== false && $empGroupId !== null) { ... zone_forbidden ... }
// api/save.php:492 vs entries.php POST — в entries.php нет аналога
$allowedStatuses = ['trip', 'day_off', 'dayoff'];
```

**Воспроизведение на dev (127.0.0.1:8094, скрипт `~/.hermes/profiles/sd_worker_04/cache/scratch/divergence.sh`, затем `git checkout -- data/app.db`):**
- A. `supervisor_zone0`: `POST api/entries.php {"employeeId":"emp_1","date":"2099-03-01","status":"vacation","approvalStatus":"approved"}` → **200**, запись vacation/approved создана (save.php дал бы `status_not_allowed`; ср. smoke [32]).
- B. `supervisor_zone0`: `PUT api/entries.php?employeeId=emp_1&date=2099-03-01 {"status":"sick","approvalStatus":"approved"}` → **200**, approved-запись изменена (save.php: `approved_record_immutable`). После двух записей `version` = **1**.
- C. `supervisor_zone0`: `POST api/sync.php {"deletes":[{"employeeId":"emp_1","date":"2099-03-01"}]}` → **200 `deleted:1`** — approved-запись удалена (entries.php требует force+admin, smoke [22]).
- D. `viewer_test`: тот же deletes через `POST` → 403 `forbidden`, через **`PUT` → 200 `deleted:1`** (сотрудник без группы, approved-запись).
- E. `supervisor_zone0` (зона g0): `PUT api/employees.php?id=<сотрудник g1>` → 200, `DELETE` с `{"confirm":true}` → 200 `deletedId` (save.php разрешает правку сотрудников только admin).
- F. `supervisor_zone0`: `POST api/groups.php` → **201** (в save.php groups — только admin).
- G. sync_log после employees.php POST/PUT/DELETE — **0 событий** по сотруднику.

**Сценарий сбоя:** правило меняют в одном эндпоинте (как в E8-2: статусная проверка дописана только в save.php), остальные 6 копий остаются старыми. Злонамеренный или просто «продвинутый» supervisor (а в случае D — viewer) из DevTools вызывает непубличный эндпоинт и обходит ограничения, которые UI и save.php соблюдают. Фронтенд эти эндпоинты не использует (grep `api/*.php` по index.html/js: только load/save/sync GET/trips/upload/holidays_provider/audit_export/session/login/logout/change_password), поэтому регрессия не видна ни пользователям, ни smoke.

**Последствия:** нарушение модели прав (supervisor создаёт/меняет утверждённые отпуска и больничные, удаляет approved; viewer удаляет записи; supervisor удаляет сотрудников чужой зоны каскадом вместе с записями), правки не попадают в версионность E8 и freshness E10-6 → другие вкладки их не видят и могут затереть. Сопровождаемость: 9 копий зональной проверки (entries.php:103,208,301; sync.php:119; save.php:458,665; trips.php:437,555,788) с тремя разными семантиками для «сотрудник без группы».

**Исправление (не применялось):** единая политика в `auth.php` + использование во всех эндпоинтах; неиспользуемые фронтендом эндпоинты записи — admin-only.
```php
// api/auth.php — добавить
/** Единая зональная политика: fail closed для не-admin. */
function entry_write_policy(PDO $pdo, string $employeeId, ?string $newStatus, ?array $serverRow): ?string
{
    $u = current_user();
    if ($u === null) { return 'unauthorized'; }
    if (!empty($u['is_admin'])) { return null; }
    if (empty($u['can_edit'])) { return 'forbidden'; }
    $st = $pdo->prepare('SELECT group_id FROM employees WHERE id = :id LIMIT 1');
    $st->execute([':id' => $employeeId]);
    $g = $st->fetchColumn();
    $scope = $u['scope_group_id'] ?? null;
    if ($g === false || $g === null || $scope === null || (string) $g !== (string) $scope) { return 'out_of_scope'; }
    if ($newStatus !== null && !in_array($newStatus, ['trip', 'day_off', 'dayoff'], true)) { return 'status_not_allowed'; }
    if ($serverRow && ($serverRow['approval_status'] ?? '') === 'approved') { return 'approved_record_immutable'; }
    return null;
}
```
```php
// api/sync.php:95 — guard для всех мутирующих методов и только POST для deletes
if ($method !== 'GET') {
    require_edit();
}
if ($method !== 'POST' && $method !== 'GET') {
    sendJson(['error' => 'method_not_allowed'], 405);
}
// в цикле deletes (вместо :120-129):
$chkRow = $pdo->prepare('SELECT approval_status FROM schedule_entries WHERE employee_id = :e AND date = :d');
$chkRow->execute([':e' => $employeeId, ':d' => $date]);
$why = entry_write_policy($pdo, (string) $employeeId, null, $chkRow->fetch(PDO::FETCH_ASSOC) ?: null);
if ($why !== null) { continue; }
```
```php
// api/entries.php POST/PUT/DELETE — заменить три inline-блока (:103-116, :208-221, :301-314) и approved-проверки на:
$why = entry_write_policy($pdo, (string) $employeeId, $status /* PUT: $newStatus; DELETE: null */, $existing ?: null);
if ($why !== null) { sendJson(['error' => $why], $why === 'unauthorized' ? 401 : 403); }
// и в INSERT/UPDATE: version = COALESCE(version,0)+1 (ON CONFLICT ... version = schedule_entries.version + 1); в PUT — запись в sync_log как в POST.
```
```php
// api/employees.php, api/groups.php, api/positions.php: POST/PUT/DELETE — require_admin() вместо require_edit()
// (паритет с save.php:92,111,181); в employees.php после каждой мутации — sync_log($pdo,'employee',$id,'upsert'|'delete',now()).
// api/auth.php:164-202 — удалить can_edit_group/require_group_edit либо реализовать через entry_write_policy.
```
Регрессионные тесты к патчу — в G-04.

**Уверенность:** подтверждено (по коду и на dev, пункты A–G). **Статус риска:** не принят; глобальная ВИДИМОСТЬ (E8-4) здесь ни при чём — речь о записи. Пункты D и E — дефекты авторизации, переданы в A (раздел 6); B_CORRECTNESS §6 уже передал в A employees.php DELETE.

### G-02 | Две несовместимые модели «зоны» во фронтенде: матрица вычисляет зону из имени пользователя, командировки — из scopeGroupId | P2 | G (+E; CWE-1041)

**Место:** `index.html:3885-3913` (`getSupervisorZone`, `canEditVacationEmployee`); `js/trips.js:2069-2077` (`employeeZone`), `:2087-2104` (`canDeleteTrip`); `api/auth.php:107-119` (`public_user` отдаёт только `scopeGroupId`).

**Доказательство:**
```js
// index.html:3888-3898
var raw = user.zone;
if (raw === undefined || raw === null || raw === '') raw = user.supervisorZone;
if (raw === undefined || raw === null || raw === '') raw = user.dept;
...
var match = identity.match(/supervisor[_-]?zone([0-6])/i);   // зона из username
// index.html:3912
return supervisorZone !== null && Number(emp.dept) === supervisorZone;
// js/trips.js:2071-2076 — другая модель
var raw = emp.groupId != null ? emp.groupId : emp.dept; ... return ... ('g' + n)
```
`public_user()` полей `zone`/`supervisorZone`/`dept` не возвращает → для матрицы зона supervisor определяется ТОЛЬКО regex по username `supervisor_zoneN`.

**Сценарий сбоя:** администратор заводит реального супервайзера `ivanov` со `scope_group_id='g0'`. Командировки (trips.js) его зону видят, матрица отпусков — нет: `getSupervisorZone` → null → `canEditVacationEmployee` = false на всех ячейках (fail closed). Наоборот, учётка, названная `supervisor_zone3`, но с `scope_group_id='g0'`, в матрице получит UI-права на зону 3 (сервер отклонит, но молча: `rejections[]` фронт не обрабатывает — save.php:487-489). Связь «индекс ZONES ↔ g<N>» нигде не задокументирована.

**Последствия:** функциональная поломка для любых учёток, кроме тестовых; правило зоны продублировано в 3 местах (сервер, матрица, командировки) с разной семантикой.

**Исправление:** один источник — `scopeGroupId` с сервера:
```js
// index.html:3885 — заменить тело getSupervisorZone
function getSupervisorZone(user) {
  if (!user || user.role !== 'supervisor' || !user.scopeGroupId) return null;
  var m = String(user.scopeGroupId).match(/^g(\d+)$/i);
  return m ? Number(m[1]) : null;   // индекс ZONES == N из g<N> (задокументировать в CODEMAP/ARCHITECTURE)
}
```
Лучше — вынести `employeeZone/userZone` в `js/storage.js` и использовать из обоих модулей.

**Уверенность:** подтверждено по коду (смоделировать реального супервайзера на dev без изменения users не делал — требует INSERT в users; логика однозначна). **Статус:** не принят.

### G-03 | Тесты не покрывают ни одного guard'а массового стирания E10, relay, восстановление и тесты безопасности; зелёный smoke не ловит G-01 | P1 | G (CWE-1121 / отсутствие регрессионных тестов)

**Место:** `api/smoke_test.php` (76 проверок, перечень [1]–[76] в выводе прогона); `scripts/test_trips_frontend.sh:36-171`; `scripts/test_e51_pick_geometry.js`, `test_e52_pick_semantics.js`, `test_r4_hygiene.js` (только pick-UI trips.js через vm-шим); защищаемый код — `api/save.php:202-247,328-351` (E10-2), `:621-645` (E10-4), `:138-174,352-372,649-662,720-731` (E10-6), `api/trip_relay.php`, `api/import.php`.

**Матрица «критичный путь → тест» (поиск по именам эндпоинтов/аудит-действий во всех сьютах + чтение smoke):**

| Критичный путь | Тест | Статус |
|---|---|---|
| login ok / wrong password / session anon | smoke [1], [2], [3] | есть |
| anon → 401: export, load, save, employees, groups, positions, upload, trips GET | smoke [12]–[17], [20], [44] | есть |
| anon → holidays.php (POST/PUT/DELETE без auth) | — | **нет** (эндпоинт без auth на проде, 00_MAP) |
| anon → debug_token.php / smoke_test.php / init_db.php по вебу | — | **нет** |
| logout (уничтожение сессии), change_password (все 4 ветки) | — | **нет** |
| viewer запрет записи: save | smoke [35] | есть |
| viewer запрет записи: trips POST | smoke [45], trips_frontend Test 6 | есть |
| viewer запрет: sync.php POST/PUT/DELETE, entries, employees, groups, positions, upload | — | **нет** (G-01 п. D — дефект) |
| supervisor: статус только trip/day_off (save) | smoke [32] | есть |
| supervisor: статус через entries.php | — | **нет** (G-01 п. A — дефект) |
| supervisor: чужая зона save / sync-delete / trips | smoke [33], [40], [42], [45]=T45, [55] | есть |
| supervisor: чужая зона employees/groups/positions | — | **нет** (G-01 п. E, F) |
| approved: DELETE без force → 403 | smoke [22] | есть |
| approved: supervisor правит approved через save (`approved_record_immutable`) | — | **нет** (ветка save.php:504-515 не исполняется ни одним тестом) |
| approved: через entries.php PUT / sync.php deletes | — | **нет** (G-01 п. B, C) |
| confirmed trips immutable | smoke [53], [54] | есть |
| E8 версии / конфликт / echo no-op | smoke [26]–[31], [36], T3-8/9 | есть |
| **E10-2** `employee.wipe_blocked` (≥3 пустых photo/location) | — | **нет** (smoke [76] лишь обходит гард, не проверяет его) |
| **E10-2** `employee.mass_delete_blocked` (≥3) | — | **нет** |
| **E10-4** `entry.mass_delete_blocked` (≥10 сотрудников) | — | **нет** |
| **E10-6** `clientLastSyncId`: stale_delete_blocked (employee/entry), staleValueRejects | — | **нет** (ни один тест не шлёт `clientLastSyncId`; приёмка E10-6 «attack replica 9/9» — разовый харнесс вне репозитория) |
| relay: poll / callback / reveal / неверный X-Auth-Token / идемпотентность callback | — | **нет** (в смоке и сьютах `trip_relay` не встречается) |
| trips confirm → trip_requests создана | — | **нет** (T3-10 проверяет только статус confirmed) |
| vacation_import: Bearer ok / неверный | smoke [23], [24], [25] | есть |
| vacation_import: поиск по ФИО, неоднозначность, batch, overlap c approved | — | **нет** |
| import.php: supervisor 403 | smoke [19] | есть |
| import.php: успешное восстановление admin, роллбэк при ошибке, trip_participants | — | **нет** (C-03 — дефект именно здесь) |
| export.php: содержимое / роль viewer | — (только anon 401) | частично |
| reset.php | smoke [58] | есть (эндпоинт мёртвый, см. G-05) |
| audit_export: форматы, 403 viewer/supervisor | smoke [65]–[69] | есть |
| upload.php: валидный файл, неверный тип, размер, EXIF | — (только anon 401) | **нет** |
| holidays_provider | smoke [11] | есть |
| XSS (экранирование ФИО/комментариев/полей trips при рендере) | — | **нет** |
| CSRF / Origin / CORS (`ACAO:*`), SameSite | — | **нет** |
| freshness на клиенте (storage.js шлёт clientLastSyncId, обрабатывает rejections) | — | **нет** |

Итог: из 9 обязательных по ТЗ блоков (авторизация, роли/зоны, approved/confirmed, E10-guard'ы, relay, vacation_import, import.php, безопасность, frontend-sync) полностью покрыты 0, частично 5, не покрыты E10-guard'ы, relay, import-восстановление, тесты безопасности.

**Сценарий сбоя:** два инцидента массовой потери данных на проде (E10: 2026-09-18 фото/локации ~40 сотрудников; 2026-09-28 — 1360 записей календаря; 07-08.10 — больничные) закрыты guard'ами без регрессионных тестов. Любой рефакторинг save.php (821 строка, один try-блок) может снять гард молча: smoke останется 76/76. Аналогично — relay (машинный интерфейс с ПДн для HelpMe) не проверяется вообще.

**Последствия:** повторение инцидентов E10 незаметно до жалобы пользователей; дефекты G-01 существовали и прошли приёмку всех фаз с зелёным smoke.

**Исправление (не применялось):** добавить в `api/smoke_test.php` (в стиле существующих `$run(...)`, с уникальными emp_smoke_* и очисткой в `cleanup()`), минимум:
```php
$run('E10-2 mass employee delete >=3 blocked', function () use ($base, $cookieAdmin) {
    // создать 3 emp_smoke_md_*, затем save.php с employees = все, КРОМЕ этих трёх
    // assert: 200, все три есть в БД, в audit_log есть employee.mass_delete_blocked
});
$run('E10-4 entry mass delete >=10 employees blocked', ...);      // 10 emp_smoke + по записи 2099; save без entries 2099
$run('E10-6 stale clientLastSyncId keeps fresh entry', function () use ($base, $cookieAdmin) {
    // cursor = load.php lastSyncId; entries.php POST новой записи; save.php {clientLastSyncId: cursor, year:2099, entries: []}
    // assert: запись цела, audit sync.stale_delete_blocked
});
$run('relay: poll wrong token 401 / poll+callback ok / reveal viewer 403', ...);
$run('sync.php PUT deletes as viewer -> 403', ...);               // регрессия к G-01 D
$run('entries.php supervisor vacation -> 403 status_not_allowed', ...); // регрессия к G-01 A
$run('import.php admin roundtrip export->import keeps trips', ...);     // регрессия к C-03
$run('XSS: employee fullName <img onerror> stored, load.php returns raw; UI escape tested in JS suite', ...);
```
и JS-сьют `scripts/test_escape.js` (vm-шим как в e51) — рендер карточки/матрицы/командировки с `<img src=x onerror=...>` в ФИО/комментарии/location, assert отсутствия элемента `img` в DOM-шиме.

**Уверенность:** подтверждено по коду (перечень тестов из реального прогона + grep по всем сьютам). **Статус:** не принят.

### G-04 | Legacy-путь `status='trip'` в schedule_entries не закрыт на сервере, а миграция legacy→Trip одноразовая | P2 | G (+B)

**Место:** `api/db.php:270-273, 292-323, 430` (`migrateLegacyTrips`, флаг `trips_legacy_migrated`); `api/save.php:492` (supervisor разрешён `'trip'`); `api/entries.php:118-158` (статус не валидируется); `index.html:2762` (`TYPE_TO_STATUS.trip`), `:4146-4164` (UI уже ведёт на Trip-сущность); `reports/ARCHITECTURE_TRIPS.md:39` («депрекейтед как write-path»).

**Доказательство:**
```php
// api/db.php:296-302 — после первого прогона миграция больше не выполняется
$flagStmt = $this->pdo->prepare("SELECT value FROM meta WHERE key = 'trips_legacy_migrated'");
...
if ($flagStmt->fetch(PDO::FETCH_COLUMN)) { return; }
// api/save.php:492 — сервер по-прежнему принимает legacy-статус
$allowedStatuses = ['trip', 'day_off', 'dayoff'];
```
Миграция копирует строки в `trips`/`trip_participants` (`db.php:350-355`), но исходные `schedule_entries` со `status='trip'` не удаляет.

**Сценарий сбоя:** старая вкладка (до T5) или прямой вызов entries.php/save.php создаёт `status='trip'` → запись живёт вне сущности Trip: не попадает в relay (HelpMe), не участвует в `trips_check_overlaps` (trips.php:45 «legacy 'trip' НЕ блокируют»), в матрице отображается как отдельный тип рядом с overlay командировки. Повторной миграции не будет (флаг).

**Последствия:** две модели командировок в данных; неконсистентность отчётности/пересечений; мёртвая ветка TYPE_TO_STATUS.trip продолжает поддерживаться.

**Исправление:**
```php
// api/save.php:492 и в entry_write_policy (G-01): убрать 'trip'
$allowedStatuses = ['day_off', 'dayoff'];
// api/save.php в цикле entries до version-check (для всех ролей):
if ((string) ($entry['status'] ?? '') === 'trip' && !($serverRow && $serverRow['status'] === 'trip')) {
    $rejections[] = ['key' => $key, 'reason' => 'legacy_trip_deprecated'];
    $keepKeys[$key] = true; $payYears[substr((string) $date, 0, 4)] = true; continue;
}
// api/entries.php POST/PUT: if ($status === 'trip') { sendJson(['error' => 'legacy_trip_deprecated'], 400); }
```
`index.html:2762` — удалить `trip: 'trip'` из TYPE_TO_STATUS после проверки, что все входы в «Командировку» идут через `window.Trips` (4146-4164).

**Уверенность:** подтверждено по коду. **Статус:** проектное решение «депрекейтед» задокументировано (ARCHITECTURE_TRIPS.md:39), но не реализовано на сервере.

### G-05 | Сборка полного состояния скопирована в load.php / reset.php / export.php и разошлась; reset.php не используется фронтендом | P2 | G (+C)

**Место:** `api/load.php:36-169`, `api/reset.php:30-130`, `api/export.php:33-138`.

**Доказательство:** три независимых копии SELECT/маппинга groups/positions/employees/entries/holidays/vacationBalances/year. Расхождения:
```php
// load.php:96,109,151-167 — entries с version, lastSyncId
'version' => isset($row['version']) ? (int) $row['version'] : 1,  ... 'lastSyncId' => $lastSyncId,
// reset.php:82 / export.php:80 — без version, без lastSyncId, без trips
'SELECT employee_id, date, status, comment, approval_status, updated_at FROM schedule_entries'
```
`grep "reset.php" index.html js/*.js` — 0 вхождений: кнопка «Сбросить» (Фаза 8, `reset.php:6-12`) из UI удалена, эндпоинт остался (smoke [58] его проверяет).

**Сценарий сбоя:** клиент, загрузивший состояние из reset.php, получает записи без `version` (клиент подставит v1) и без курсора `lastSyncId` → после первого save: ложные E8-конфликты у supervisor и отключённый freshness-guard E10-6 (нет `clientLastSyncId`). export.php → import.php теряет trips и версии (C-03, блок C). Любое новое поле (например, RPA-поля trips) надо добавлять в три места.

**Последствия:** дрейф форматов, скрытая регрессия E10-6 при повторном использовании reset.php, лишняя поверхность (reset/export доступны viewer).

**Исправление:** вынести сборку в `api/state.php`:
```php
// api/state.php
function build_state(PDO $pdo, bool $withSync = true): array { /* тело load.php:36-150 + trips при $withSync */ }
// load.php:   sendJson(build_state($pdo));
// export.php: sendJson(build_state($pdo, true) + ['exportedAt' => now()]);  // с version и trips — см. C-03
// reset.php:  удалить файл (и тест smoke [58]); из DEPLOY_HOSTLAND.md §1 — убрать.
```

**Уверенность:** подтверждено по коду (diff load/reset, grep потребителей). **Статус:** не принят.

### G-06 | Мёртвый код во фронтенде: legacy-модалка командировок, невызываемая валидация аванса, неинжектируемый CSS | P3 | G (CWE-561)

**Место (функция объявлена, вызовов 0 — поиск по index.html + js/*.js):**
- `js/trips.js:987-1013` `createTripModal`, `:1291-1378` `showTripModal` (второй, устаревший шаблон формы командировки рядом с действующим `renderTripFormInPanel` `:1109-1220`);
- `js/trips.js:1499-1524` `validateAdvanceAmount` (E12-3) — не подключена; та же проверка продублирована inline в `saveTrip` `:1662-1667`;
- `js/trips.js:1874` `showTripSelectionModal` (+ используемая только им `selectTripForEmployee` `:1923`), `:2866` `positionEmployeePickDock` (dock удалён в R3), `:3001` `getEmployeesForPick`;
- `index.html:3460` `setRangeVacationType`, `:4016` `showCommentRow`, `:4029` `closeCellPopup`, `:5598` `InjectTripStatusCSS` (определена, не вызывается — стили `.trip-blue/.status-forecast` из неё не применяются).

**Доказательство:** скрипт `~/.hermes/profiles/sd_worker_04/cache/scratch/deadcode.py` (подсчёт вхождений идентификатора во всех трёх файлах = 1). TODO/FIXME/XXX/HACK в index.html, js/*.js, api/*.php — 0 (grep), закомментированного кода — 1 строка-комментарий (index.html:4614, не код).

**Сценарий сбоя:** правка формы командировки вносится не в тот шаблон (их два — `showTripModal` и `renderTripFormInPanel`); блок E (E-01) уже фиксирует поломку in-panel формы из-за ссылок на удалённые поля — типичное следствие параллельных шаблонов.

**Последствия:** ~200 строк неисполняемого кода в и без того большом trips.js (3079 строк), ложные ориентиры для разработчиков и CODEMAP.

**Исправление:** удалить перечисленные функции; в `saveTrip` (`js/trips.js:1662`) заменить inline-проверку вызовом `validateAdvanceAmount(document.getElementById('tripAdvanceAmount'))` и `if (!el.checkValidity()) return;` либо удалить helper — оставить одну реализацию. Прогнать e51/e52/r4.

**Уверенность:** подтверждено по коду (динамических вызовов по строковому имени — `window[...]`/`Trips[...]` — для этих имён не найдено; `initFromServer` исключён как IIFE). **Статус:** не принят.

### G-07 | Набор тестов невоспроизводим: устаревшие test_* в корне, «пустой» JS-тест, отсутствующий E2E-харнесс, хардкод портов/путей, артефакт в дереве | P2 | G

**Место и статус каждого скрипта (101c846):**

| Файл | Последний коммит | Состояние | Вывод |
|---|---|---|---|
| `test_approved_guard.sh` | aa16c93 (baseline 2026-08-29) | хардкод `127.0.0.1:8090` (`:4`), ручной запуск сервера, `set -e` | устарел (покрыт smoke [22]) — удалить |
| `test_supervisor_edit.sh` | aa16c93 | хардкод 8090 (`:4`) | устарел (smoke [33]/[34]) — удалить |
| `test_zone_filters.sh` | aa16c93 | пароль `test123` (`:11,:40`; в dev-БД — `changeme`), проверяет ЗОНАЛЬНЫЙ ФИЛЬТР ЧТЕНИЯ (`:52`), снятый в E8-4 (sync.php:212-216) | **неработоспособен и проверяет отменённое поведение** — удалить |
| `test_fixes.php` | aa16c93 | `require_once 'api/load.php'` (`:9`) — исполняет эндпоинт, `sendJson()` делает `exit` → скрипт завершается на подключении; ожидает зональную фильтрацию (`:25`) | **неработоспособен** — удалить |
| `test_employees_count.php` | aa16c93 | хардкод 8090 (`:6,:16,:32,:41`), только печать без assert | отладочный — удалить |
| `test_t43_debug.php` | aa16c93 | хардкод порт 19000 (`:4`), «Debug T43» | отладочный — удалить |
| `js/test_trips_overlay.js` | cc090ed (2026-08-30) | `node js/test_trips_overlay.js` → exit 0, **0 строк вывода**: функции тестов только экспортируются (`:14-15`), не вызываются; лежит в `js/` — каталоге прод-статики | вакуумный тест, попадает в прод-пакет `js/` — перенести в `scripts/` и вызвать, либо удалить |
| `scripts/test_trips_frontend.sh` | — | фиксированный порт **8091** (`:24-25`) — коллизия с параллельными worktree/сервером разработчика (при занятом порте `php -S` умирает, а curl уходит на чужой сервер; smoke от этого защищён `smoke_test.php:24-43`, этот скрипт — нет); cookie-jar `test_cookies.jar` в CWD (`:33`) — после прогона в корне репозитория остался неотслеживаемый файл (наблюдалось 2026-10-25); по сути это API-тест trips, а не «frontend» | исправить |
| `scripts/check_syntax.js` | — | путь по умолчанию — `/home/hermes/service-center-app/index.html` (`:7`): из worktree без аргумента проверяет ЧУЖОЙ файл | исправить |
| `/tmp/e5_final.js`, `/tmp/e6_final.js` (AGENTS.md «E2E-харнесс») | вне git | файлов нет | E2E-набор утерян; хранить в `scripts/` |
| `AGENTS.md` (CODEMAP-команда) | — | ссылается на `js/vacations.js` — файла нет | исправить документ |
| `api/debug_token.php` | aa16c93 | диагностика Bearer без auth, эхо заголовка (`:11-24`), префикс+суффикс токена (`:48`), на проде исполняется (00_MAP) | отладочный, мёртвый для продукта — удалить (безопасность — блок A) |
| `api/init_db.php` | aa16c93 | CLI-guard пишет в `STDERR` (`:20-21`) — константа не определена под mod_php → Fatal вместо отказа (00_MAP: прод 200 + Fatal); докблок «schema_version = 1» (`:11`) устарел (схема v8, миграции в db.php) | живой только как CLI; guard исправить: `if (PHP_SAPI !== 'cli') { http_response_code(404); exit; }`, из прод-пакета убрать |
| `api/seed_positions.php` | aa16c93 | сидирует 12 должностей; UI справочник должностей больше не использует (`index.html:5276-5278`: «справочник из api/positions.php больше не используется интерфейсом») | устарел; оставить только если init_db.php нужен для свежей установки, из прод-пакета убрать |
| `api/smoke_test.php` | — | работает с боевой dev-БД `data/app.db` (см. C-06), нет CLI-guard (`PHP_SAPI`), лежит в прод-пакете (00_MAP, F-02); **оставляет «сиротский» сервер**: `proc_open('php -S … > log 2>&1')` (`:200-206`) запускает php через `/bin/sh`, `proc_terminate($proc)` (`:1799`) убивает только shell — после прогона 2026-10-25 12:49 процесс `php -S 127.0.0.1:19249 -t /home/hermes/audit-wt/w4` (PPID 837, т.е. осиротел) висел ещё 13:50 мин, пока не был убит вручную | см. C-06/F-02; добавить guard; запуск через `exec php -S …` в `$cmd` (тогда proc_terminate попадает в php) |

**Доказательство:** `head`/`grep` по файлам (номера строк выше), фактический прогон (раздел 3.0).

**Сценарий сбоя:** новый исполнитель запускает «тесты из корня» — получает ложные FAIL (`test_zone_filters.sh`, пароль/логика E8-4) или ложный PASS (`test_trips_overlay.js`); параллельные worktree (как в этом аудите: 8090–8094) ломают `test_trips_frontend.sh`; E2E-регрессия E5/E6 не воспроизводима.

**Последствия:** снижение доверия к тестам, ручной труд при приёмке, риск отправить тестовые файлы на прод (`js/test_trips_overlay.js` в каталоге статики).

**Исправление:**
```bash
git rm test_approved_guard.sh test_supervisor_edit.sh test_zone_filters.sh test_fixes.php test_employees_count.php test_t43_debug.php
git mv js/test_trips_overlay.js scripts/test_trips_overlay.js   # + в конце файла вызвать runAll и process.exit(failed?1:0)
```
```bash
# scripts/test_trips_frontend.sh:24-33
PORT="${PORT:-$((18900 + RANDOM % 400))}"
php -S 127.0.0.1:$PORT router.php > /dev/null 2>&1 &
BASE_URL="http://127.0.0.1:$PORT"
JAR_FILE="$(mktemp)"; trap 'rm -f "$JAR_FILE"; cleanup' EXIT
```
```js
// scripts/check_syntax.js:7
const file = process.argv[2] || path.join(__dirname, '..', 'index.html');
```
```php
// api/smoke_test.php — сразу после declare(strict_types=1);
if (PHP_SAPI !== 'cli') { http_response_code(404); exit; }
```
E2E-харнесс — закоммитить в `scripts/e2e_*.js` с таймаутом ≤120 с и задокументировать в AGENTS.md; в AGENTS.md заменить `js/vacations.js` на `js/storage.js`.

**Уверенность:** подтверждено (прогон + чтение кода). **Статус:** не принят.

### G-08 | CODEMAP.md устарел и не покрывает backend: 50 из 237 ссылок (trips.js — 48 из 73) указывают на неверные строки | P3 | G

**Место:** `CODEMAP.md` (245 строк сырого `rg --json`), последний коммит `4f25cbd 2026-09-24`; после него index.html/js менялись в `bbac9d3` (E10-5, 2026-09-28), `0361e6f` (E12 Ф1, 2026-09-29), `f61a3e1` (E10-6, 2026-10-10).

**Доказательство (скрипт `~/.hermes/profiles/sd_worker_04/cache/scratch/codemap.py`, сверка `line_number` с текущим текстом строки):**
- всего 237 записей: точных 187, **смещённых 50**, отсутствующих 0;
- `js/trips.js`: 48 из 73 смещены (напр. `showTripModal` 1252 → 1291, `closeTripForm` 1182 → 1221, `openTripModal` 1225 → 1264);
- `js/storage.js`: 2 из 30 (`saveVacation` 537 → 542, `isServerMode` 582 → 591);
- `index.html`: 134/134 точны;
- api/*.php (save.php 821, trips.php 891, smoke_test.php 1826 строк) в CODEMAP **отсутствуют**; команда генерации в AGENTS.md ссылается на несуществующий `js/vacations.js`.

**Сценарий сбоя:** AGENTS.md объявляет CODEMAP «первичным источником номеров строк» и запрещает повторный grep → исполнитель правит/ссылается на строку, смещённую на 39 строк (в trips.js это другая функция).

**Последствия:** ошибочные ссылки в отчётах/патчах, лишние итерации агентов.

**Исправление:** генерировать CODEMAP скриптом и проверять актуальность в CI/перед задачей:
```bash
# scripts/gen_codemap.sh
rg -n --no-heading "function |const .*=.*=>" index.html js/trips.js js/storage.js api/*.php \
  | awk -F: '{printf "%s:%s  %s\n",$1,$2,$3}' > CODEMAP.md
echo "<!-- generated $(git rev-parse --short HEAD) $(date -I) -->" >> CODEMAP.md
```
и в AGENTS.md: «CODEMAP устарел, если `git log -1 --format=%h -- index.html js/` новее хеша в его последней строке».

**Уверенность:** подтверждено (скрипт сверки по 101c846). **Статус:** не принят.

### G-09 | docs/API_DOCUMENTATION.json не обновлялся с baseline: нет trips/relay/audit_export, неверные auth/методы/коды ошибок | P2 | G

**Место:** `docs/API_DOCUMENTATION.json` (17 049 Б, `"version": "1.1.0"`, `"updated": "2026-08-16"`, последний коммит `aa16c93 2026-08-29`, до T3/E8-2/E10/E12). Файл отдаётся анонимно на проде (00_MAP: `/docs/API_DOCUMENTATION.json` 200).

**Расхождения документ ↔ код (скрипты `apidoc.py`, `apidoc2.py` в scratch):**

| # | Документ | Код 101c846 |
|---|---|---|
| 1 | эндпоинтов 18; **нет** `trips.php`, `trip_relay.php`, `audit_export.php` | существуют, используются UI/роботом (js/trips.js:17, index.html:5808) |
| 2 | `holidays` — только GET, ошибка 401 unauthorized | `api/holidays.php` GET/POST/PUT/DELETE, **auth не подключён** (`:20-21`), прод отдаёт 200 анонимно |
| 3 | `groups`, `positions` — только GET | GET/POST/PUT/DELETE (`groups.php:56-159`, `positions.php:56-159`) |
| 4 | `sync` — GET + POST `{keys}` | дополнительно `{deletes:[…]}` для любого метода (`sync.php:101`) |
| 5 | `save` — conflicts[] | плюс `clientLastSyncId` (вход), `appliedVersions`, `rejections` (`out_of_scope`/`status_not_allowed`/`approved_record_immutable`), stale-отклонения E10-6 — не описаны |
| 6 | `entries` 403 = `protected` | `cannot_delete_approved`, `cannot_modify_approved`, `zone_forbidden` (`entries.php:113,137,245,334`) |
| 7 | `change_password` 400 `passwords_match`, 401 `invalid_credentials` | `same_password` (`change_password.php:58`), `wrong_password` (`:50`) |
| 8 | `employees` 400 `confirmation_required` | текст `'Confirmation required: pass { "confirm": true } in body'` (`employees.php:247`) |
| 9 | `export` — «доступен всем (включая viewer)» | совпадает с кодом, но это ПДн-выгрузка (передано в A ранее в 00_MAP) |
| 10 | роли: `supervisor_zone0 (ГКС)`, `supervisor_zone1 (ГЭ)` — жёстко | роль определяется `scope_group_id` (auth.php:90-119) |
| 11 | `X-Auth-Token`, `reveal`, `poll`, `callback`, `advanceAmount`, RPA-поля v1.2 | 0 упоминаний |

**Сценарий сбоя:** интегратор HelpMe/внешней системы или новый разработчик опирается на документ: не знает о relay-контракте, ожидает 401 от holidays.php (а там открытая запись), обрабатывает несуществующие коды ошибок.

**Последствия:** документ вводит в заблуждение относительно модели безопасности (п. 2) и контрактов; публичная доступность расширяет разведку для атакующего.

**Исправление:** (1) убрать `docs/` из прод-пакета (DEPLOY_HOSTLAND.md §1) или закрыть `docs/.htaccess` `Require all denied`; (2) обновить JSON: добавить trips/trip_relay/audit_export, исправить строки 2–8, `version: "1.2.0"`, `updated`; (3) добавить в smoke тест-сверку «каждый api/*.php с HTTP-входом описан в docs/API_DOCUMENTATION.json» (простая проверка по `url`).

**Уверенность:** подтверждено по коду. **Статус:** не принят.

### G-10 | Неединообразные ответы API: три формы ошибок, смесь кодов и человекочитаемых фраз, 200 с ошибками внутри, `$e->getMessage()` клиенту в 19 местах | P2 | G (CWE-209 — детали в A)

**Место:** `api/helpers.php:124-127` (`error()` → `{error}`), `:53-57` (`'Method not allowed'`); `api/login.php:31,46`, `api/change_password.php:43-58` (`{success:false,error}`); человекочитаемые `error('Missing id parameter')` (employees/groups/positions), `'Employee not found'`, `'Holiday not found'`, `'No fields to update'`, `'Confirmation required: …'`; `api/trips.php:457,571,803` (`{error, foreignEmployees}`); `api/save.php:816-818` и `api/vacation_import.php` (HTTP 200 с `rejections[]`/`errors[]`); `api/trips.php` PATCH → 400 `missing_id` вместо 405 (проверено на dev).
`$e->getMessage()` уходит клиенту: `audit_export.php:105`, `change_password.php:76`, `employees.php:282`, `entries.php:381`, `export.php:141`, `groups.php:162`, `holidays.php:156`, `import.php:185`, `load.php:171`, `login.php:61`, `positions.php:162`, `reset.php:133`, `save.php:820`, `sync.php:305`, `trip_relay.php:213`, `trips.php:891`, `upload.php:179`, `vacation_import.php:398` (в теле 200 `db_error: …`), `:439`.

**Доказательство:**
```php
error('Server error: ' . $e->getMessage(), 500);            // 17 эндпоинтов, одинаковая строка
sendJson(['success' => false, 'error' => 'wrong_password'], 401);   // change_password.php:50
error('Employee not found', 404);                             // employees.php
sendJson(['error' => 'zone_forbidden', 'foreignEmployees' => $foreign], 403); // trips.php:457
```
dev: `GET entries.php` anon → `{"error":"unauthorized"}` 401; `GET employees.php?id=nope` → `{"error":"Employee not found"}` 404; `PATCH save.php` → `{"error":"Method not allowed"}` 405; `PATCH trips.php` → `{"error":"missing_id"}` 400.

**Сценарий сбоя:** фронтенд вынужден знать форму ответа каждого эндпоинта; ошибки PDO (SQL, пути к файлу БД, имена колонок) показываются пользователю/роботу. Отклонения save.php (`rejections`) фронт не обрабатывает (save.php:487-489) — пользователь не узнаёт, что правка не сохранена.

**Последствия:** хрупкая клиентская логика, утечка внутренних деталей, «тихая» потеря правок.

**Исправление:** единый контракт в helpers.php и замена во всех catch:
```php
// api/helpers.php
function api_error(string $code, int $http = 400, array $extra = []): void
{
    sendJson(['success' => false, 'error' => $code] + $extra, $http);   // error — всегда snake_case код
}
function api_fail(Throwable $e): void
{
    $rid = bin2hex(random_bytes(6));
    error_log('[api ' . $rid . '] ' . get_class($e) . ': ' . $e->getMessage() . ' @ ' . $e->getFile() . ':' . $e->getLine());
    api_error('server_error', 500, ['requestId' => $rid]);
}
// requireMethod(): api_error('method_not_allowed', 405);
// все `catch (Throwable $e) { error('Server error: ' . $e->getMessage(), 500); }` → `catch (Throwable $e) { api_fail($e); }`
// человекочитаемые: 'Missing id parameter' → 'missing_id', 'Employee not found' → 'employee_not_found',
//   'Confirmation required…' → 'confirmation_required' (как в документации), 'No fields to update' → 'no_fields'
// trips.php: в default-ветке маршрутизации метода — api_error('method_not_allowed', 405) ДО проверки id
```
`{error}` сохраняется (поле `error` есть в обоих форматах) — фронт совместим; `success:false` добавляется.

**Уверенность:** подтверждено (код + dev). **Статус:** не принят. Утечка деталей исключений — передано в A.

### G-11 | Монолит index.html: 1,17 МБ, 1 942 строки CSS и 3 331 строка JS inline, бизнес-правила (роль/зона/approved) продублированы в UI | P3 | G

**Место:** `index.html:6-1948` (`<style>`), `:1993-1994` (статичная разметка матрицы, 932 257 символов в одной строке — D-02/F-01), `:2488-5819` (единственный inline `<script>`, 125 619 символов), `:2544-2560` (`applyRoleGating`), `:3390-3419` (UI-guard approved-диапазонов), `:3876-3913` (зона, G-02), `:4065-4070` (approved в popup); `js/trips.js:456-474, 2087-2116` (свои canEdit/isAdmin/зона).

**Доказательство:** `wc -c index.html` = 1 168 199; `grep -n "<script" index.html` → 2 внешних (storage.js, trips.js) + 1 inline; `node scripts/check_syntax.js index.html` — «scripts: 1». Правило «не-admin не меняет approved» реализовано в save.php:506, entries.php:132/244 (иначе), index.html:3418 (для ВСЕХ ролей: «never split/remove an approved range»), trips.js (для confirmed) — 4 места, 3 семантики.

**Сценарий сбоя:** правка правила требует синхронного изменения сервера и 2 JS-модулей; без модульности и сборки нет юнит-тестов для логики матрицы (сьюты e51/e52/r4 грузят trips.js через vm-шим, index.html — только regex-проверки CSS).

**Последствия:** высокая стоимость изменений, конфликтные правки (hotspot index.html/trips.js в истории E5–E12), невозможность протестировать логику матрицы изолированно.

**Исправление (поэтапно, без сборщика — совместимо с Hostland):** вынести inline-скрипт в `js/matrix.js` (`<script src="js/matrix.js?v=<hash>">`), CSS — в `css/app.css`; правила прав — в `js/policy.js` с единственным источником `user.scopeGroupId`/`isAdmin` и зеркальным PHP-модулем `entry_write_policy` (G-01); строку 1994 удалить (D-02/F-01). Первый шаг — механический перенос без изменения логики, с прогоном e51/e52/r4/trips.

**Уверенность:** подтверждено по коду. **Статус:** архитектурный долг, не принят.

<!-- end findings -->

## 4. Проверено, проблем не найдено

По пунктам чек-листа G (что проверено и признано корректным):

- **Архитектура / дублирование правил.** Корректно и единообразно: `require_auth()` стоит первым во всех эндпоинтах данных, кроме задокументированных публичных (login, logout, session, holidays_provider) и holidays.php (G-01/A); `require_admin()` — в import.php:32-33 и audit_export.php (smoke [68]/[69]); в trips.php зональная проверка во всех трёх копиях одинаково fail-closed (`:449-451`, `:566`, `:797-799`), confirmed-guard одинаковый в DELETE и PUT (`:579`, `:716`). `js/storage.js` — единственный адаптер API для load/save/sync, 0 неиспользуемых функций. Read-путь (load.php, sync.php GET) после E8-4 одинаков для всех ролей (проектное решение — не дефект).
- **Мёртвый код / TODO.** `grep -E "TODO|FIXME|XXX|HACK"` по index.html, js/*.js, api/*.php, router.php, upload.php — 0 совпадений (одно «XXXXXXXXXX» в комментарии маски телефона, js/trips.js:1467). Закомментированного кода (эвристика `deadcode.py`) — 0. PHP-функции api/*.php — все вызываются (кроме магических `__construct/__clone` синглтона db.php). Корневой `upload.php` — живой тонкий делегат к api/upload.php (используется index.html).
- **Синтаксис.** `php -l` по 30 файлам (api/*.php, upload.php, router.php) — ошибок нет; `node --check` js/storage.js, js/trips.js, scripts/*.js — ошибок нет; inline-скрипт index.html — валиден (`check_syntax.js`).
- **Тесты.** Smoke сам себя обеспечивает фикстурами (`smoke_test.php:253-298`), выбирает случайный свободный порт и проверяет, что отвечает именно его сервер (`:24-43`, `:226-235`), проверяет «DB intact» — хорошая практика. Все 5 штатных сьютов зелёные (раздел 3.0).
- **Читаемость / именование.** Маппинг snake_case БД → camelCase API единообразен (`normalizeEntry` entries.php:394-407, load.php, sync.php:252-260); все SQL с пользовательскими значениями — через prepare/bind (динамический `LIKE` в save.php:613-617 строится через `$pdo->quote`); стиль `declare(strict_types=1)` и docblock-шапки есть во всех основных эндпоинтах. Окончания строк — LF везде, кроме `api/vacation_import.php` (CRLF во всех 457 строках) — косметика, отдельной находкой не оформлено.
- **CODEMAP.md:** раздел index.html (134 записи) точен на 101c846 — проблема только в trips.js/storage.js и отсутствии api/ (G-08).
- **docs/API_DOCUMENTATION.json:** описания login/session/logout/load/upload/vacation_import/import совпадают с кодом по URL, методу и основным полям (расхождения — G-09).

## 5. Что не удалось проверить

- E2E-харнесс `/tmp/e5_final.js` / `/tmp/e6_final.js` (AGENTS.md) — файлов нет на хосте; браузерный E2E не прогонялся.
- G-02 на живой учётке: проверка «реальный supervisor с произвольным username» требует INSERT в `users` dev-БД и браузерного сеанса; вывод сделан по коду (`public_user()` не отдаёт `zone/supervisorZone/dept`).
- Совпадение состава прод-пакета с репозиторием (какие из test_*/debug-файлов реально на проде) — только по 00_MAP.md (анонимные GET координатора); собственных запросов к проду этот блок не делал.
- Покрытие relay/import — оценено по отсутствию тестов; функциональная корректность самих trip_relay.php/import.php — зона блоков A/B/C (C-03).
- Приёмочный харнесс E10-6 «attack replica 9/9» (reports/E10_6_FRESHNESS_SYNC_DEPLOY.md) в репозитории не найден — повторить его нельзя.

## 6. Передано в A

- api/sync.php:95-101 — require_edit() только для метода POST, блок deletes исполняется для PUT/DELETE: viewer удаляет записи (подтверждено на dev, G-01 п. D).
- api/sync.php:101-172 — удаление через deletes без approved-guard и без audit (supervisor удалил approved, G-01 п. C).
- api/entries.php:118-158, :237-266 — supervisor пишет любой статус (vacation/sick) и меняет approved-записи при сохранении approvalStatus='approved' (G-01 п. A, B).
- api/employees.php:138-139, :240-241 — supervisor правит/удаляет сотрудников чужой зоны (G-01 п. E; пересекается с B §6).
- api/groups.php:58-59,84-85,133-134; api/positions.php:58-59,84-85,133-134 — supervisor создаёт/удаляет группы и должности (G-01 п. F).
- 19 мест `error('Server error: ' . $e->getMessage(), 500)` и `vacation_import.php:398` (`db_error: …` в теле 200) — раскрытие деталей исключений клиенту (G-10; список файл:строка там).
- docs/API_DOCUMENTATION.json, api/schema.sql, api/E8_SYNC.md отдаются анонимно (00_MAP) и описывают внутренние контракты (G-09).
- api/smoke_test.php:200-206 — при веб-вызове порождает процесс `php -S`, который не завершается proc_terminate (сиротский сервер, G-07) — усиливает риск из 00_MAP.

## 7. Самопроверка

| ID | Защита уровнем выше? | Проектное решение? | Итог |
|---|---|---|---|
| G-01 | Проверены require_* в каждом методе (матрица); `.htaccess` для api/ не ограничивает методы; save.php-guard'ы на entries/sync/employees не распространяются; фронтенд эти пути не вызывает, но они доступны через HTTP (воспроизведено на dev) | E8-4 касается только видимости; спецификация ролей (PROMPT, trips.php:37-40, save.php:73-77) требует для supervisor «только trip/day_off, approved — read-only» — код entries/sync это нарушает | подтверждено |
| G-02 | Сервер отклоняет чужую зону (save.php:473) — поэтому P2, не выше: дефект функциональный, без обхода прав | нет (комментарий index.html:3882 «server must enforce the same rule» — ожидается одна модель) | подтверждено по коду |
| G-03 | Тестов вне репозитория (CI) нет; харнессы E10/E6 — разовые, вне git | нет | подтверждено |
| G-04 | Серверного запрета 'trip' нет ни в save.php, ни в entries.php, ни в CHECK схемы (C-04) | депрекейт задокументирован (ARCHITECTURE_TRIPS.md:39), но не реализован — указано в статусе | подтверждено |
| G-05 | reset.php защищён require_auth, но доступен viewer; потребителей нет | reset.php задуман для «Сбросить» (Фаза 8), кнопки в UI нет | подтверждено |
| G-06 | Проверены строковые/динамические вызовы — нет | нет | подтверждено |
| G-07 | — | нет | подтверждено прогоном |
| G-08 | — | CODEMAP по AGENTS.md должен обновляться при правках — не выполнено | подтверждено |
| G-09 | — | нет | подтверждено |
| G-10 | Глобального обработчика ошибок/`display_errors=Off` в коде нет (F-03) | нет | подтверждено |
| G-11 | — | монолит без сборки — исторический выбор (PROMPT «vanilla JS без сборки»); оценён как долг P3, не выше | подтверждено |

Дубли с другими блоками исключены: smoke пишет в dev-БД — C-06 (здесь только ссылка); статичный снимок матрицы — D-02/F-01; export→import — C-03; прод-пакет — F-02; display_errors — F-03.

AC4: в `/home/hermes/audit-wt/w4` `git status --porcelain` пуст (проверено после последней серии, dev-БД возвращена), свой dev-сервер 8094 остановлен, «сиротский» `php -S` от smoke (порт 19249) найден и остановлен, `test_cookies.jar` удалён. AC5: к проду запросов не было; токены/хеши/ПДн в отчёт не выводились (телефон в ответе employees.php на dev был замаскирован сервером, тестовые ФИО — синтетические «G Audit …»).
