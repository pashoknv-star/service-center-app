# V10-T5 — Транспорт: API заявок, назначений и предупреждений (сьют `transport` → GREEN)

Задача Kanban `t_a8604210`. Worktree `/home/hermes/wt/v10-t5`, ветка `v10-t5-api`, база `89e3171` (+ main `61d82fc` — только документы). Исполнитель sd_worker_03. Не пушилось, не деплоилось, `AGENTS.md` не менялся (патч — `T5_AGENTS_patch.md`), `data/app.db` не тронут, `api/transport_test.php` не менялся (`git diff main -- api/transport_test.php` пуст), `scripts/verify_all.sh` не менялся.

## 1. Что сделано

| Файл | Что |
|---|---|
| `api/transport_requests.php` (новый) | `GET` (`?id=`; список `from/to/status`; `can_edit` — сервер), `POST`, `PUT`, `PUT ?action=status`, `DELETE` → 405. Переходы — `TRQ_TRANSITIONS` (`:48`). Журнал `request.create/update/status` |
| `api/transport_assignments.php` (новый) | `POST` / `PUT` / `DELETE`, `dry_run`, `confirm_token` (`tas_confirm :278`), автоматика статуса (`tas_auto_assigned :338`; возврат в `new` — `tas_delete :472`), валидации 422, журнал `assignment.create/update/delete` + `request.status` (автосмена) |
| `api/transport_warnings.php` (новый, библиотека; прямой запрос → 404) | 7 кодов предупреждений (`transport_collect_warnings :179`), отсутствия (`transport_absences :124`), `confirm_token` (`transport_confirm_issue :365` / `transport_confirm_valid :372`) |
| `api/transport_lib.php` (только добавлено, существующие сигнатуры не менялись) | `transport_write()` (`:360`) — `BEGIN IMMEDIATE` с повтором ≤ 3 только на `BEGIN`; `transport_is_busy`, `transport_read_version`, `transport_int`, `transport_parse_local`, `transport_add_minutes`; выборки `transport_fetch_request/assignment`, `transport_assignments_of`, `transport_assignment_public`, `transport_request_public` |
| `reports/V10/T5_evidence/` | `t5_probe.php` + `t5_probe_run.txt` — 21 дополнительная проверка сверх сьюта (§6) |
| `reports/V10/T5_AGENTS_patch.md` | «было/стало» для `AGENTS.md` |

Не трогались: `api/transport_vehicles.php`, `api/schema.sql`, `api/db.php`, `js/`, `index.html`, `scripts/verify_all.sh`, `api/transport_test.php`.

Формат ответов (контракт обёртки не фиксировал — принято как у T1): `{success, request}`, `{success, requests, truncated}`, `{success, assignment, request:{id,status,version}}`, DELETE назначения — `{success, request:{id,status,version}}` (200). Ошибки — `{"error":"<код>"}` (`transport_fail`).

## 2. Таблица переходов статусов заявки

Ручные переходы — только `PUT ?id=&action=status {status, version}`; всё, чего нет в таблице, → 422 `invalid_transition` `{from,to}`. Неизвестный/пустой/отсутствующий `status` → 422 `invalid_status`.

| из \ в | new | assigned | in_progress | done | cancelled |
|---|---|---|---|---|---|
| **new** | — | ❌ (только авто) | ❌ | ❌ | ✅ |
| **assigned** | ❌ | — | ✅ | ✅ | ✅ |
| **in_progress** | ❌ | ❌ | — | ✅ | ✅ |
| **done** | ✅ (возврат) | ❌ | ❌ | — | ❌ |
| **cancelled** | ✅ (возврат) | ❌ | ❌ | ❌ | — |

Автоматика (в той же транзакции, с `version`+1 и записью журнала `request.status` с `auto:true`):
* `new → assigned` — при создании назначения (первого; в `new` с оставшимися после возврата назначениями — любого);
* `assigned | in_progress → new` — при удалении **последнего** назначения; из `new` / `done` / `cancelled` статус не меняется.

Решения, не заданные контрактом (T2 §6.6 просил зафиксировать): `new → in_progress/done` запрещены (нет назначения — нечего выполнять); `assigned → done` напрямую разрешён (диспетчер мог не отметить «в работе»); `assigned/in_progress → new` вручную запрещён (инвариант «new = нет назначений» держит автоматика); `done → cancelled` запрещён; `X → X` → `invalid_transition`. При отмене/завершении/возврате в `new` назначения **не удаляются** (после `done → new` / `cancelled → new` заявка `new` может иметь назначения — этого требует тест R16); назначения отменённой заявки в пересечениях не учитываются. Правка полей заявки (`PUT`) разрешена в любом статусе. Назначения заявок `done`/`cancelled` не создаются, не правятся и не удаляются — 422 `request_closed`.

## 3. Коды статусов отсутствия — из исходников

`schedule_entries.status IN ('vacation','sick','trip')` и `trip_participants` (период участника включительно, **любой** статус командировки — `forecast` и `confirmed`). Источники (прочитаны на текущем коммите):

| Факт | file:line |
|---|---|
| Таблица `schedule_entries` (`employee_id,date,status,comment,approval_status,version`) | `api/schema.sql:65-75` |
| Статусы, которые пишет supervisor: `['trip','day_off','dayoff']`; `vacation`/`sick` пишет только admin | `api/save.php:499` (комментарий — `:495-497`) |
| UI-типы и серверные имена: `vacation`, `sick`, `trip`, `dayoff→day_off` | `index.html:2544-2570` (`VACATION_TYPES`, `TYPE_CSS`, `TYPE_TO_STATUS`) |
| Legacy-статус `'trip'` в `schedule_entries` | `api/db.php:693` |
| Существующая проверка отсутствий для командировок: `vacation`,`day_off` блокируют, `sick` и legacy `trip` — нет | `api/trips.php:56-58`, `:172` |
| Таблицы `trips` (`status forecast|confirmed`) и `trip_participants (trip_id, employee_id, start_date, end_date)` | `api/schema.sql:160-194` |
| Константа в коде | `api/transport_warnings.php:40` (`TRANSPORT_ABSENCE_SCHEDULE_STATUSES`) |

Принято: `day_off` (отгул) не отсутствие (контракт: «отпуск/болезнь/командировка»); `approval_status` не учитывается (черновик отпуска — плановое отсутствие); прогнозная командировка (`forecast`) даёт предупреждение (предупреждения не блокируют, ложное срабатывание дешевле пропуска). Дни назначения: от даты `start_at` до даты момента `end_at − 1 мин` (`transport_last_day :49`; `end_at` ровно 00:00 не затрагивает следующий день).

## 4. Как устроены транзакция и `confirm_token`

**Транзакция** (`transport_write`, `api/transport_lib.php:360`): `exec('BEGIN IMMEDIATE')` с ≤ 3 попытками (`TRANSPORT_BEGIN_ATTEMPTS`), пауза 40/80 мс, повтор — **только** на самом `BEGIN IMMEDIATE` при `SQLITE_BUSY/LOCKED` (`transport_is_busy`); не удалось → 503 `busy` (тело транзакции никогда не перезапускается). Завершение — `exec('COMMIT')` / `exec('ROLLBACK')` по собственному флагу `$open` (не `PDO::inTransaction()` / `PDO::commit()` — ловушка AGENTS V10). Любое исключение (в т.ч. `TransportApiError` 409/403/422 или сбой журнала) откатывает всё; ответ формирует `transport_handle`. Порядок внутри писателей: проверки формы, прав и справочников — **до** `BEGIN IMMEDIATE` (быстрый отказ без блокировки, ADR_DB §6.2) и ещё раз внутри транзакции (прав/статуса/версии/водителя), затем перечитать данные → вычислить предупреждения → проверить токен → записать назначение, бригаду, маршрут → `transport_journal_write` → автосмена статуса. `VERSION_CONFLICT`, `confirmation_required`, 403/404/422 и `dry_run` не пишут ничего — журнал чистый (сьют J8).

**`confirm_token`** = `<exp>.<hmac_sha256>` (срок 30 минут). HMAC по `exp | users.id | операция | отпечаток набора`, ключ = `sha256(session_id | users.id)` (отдельного секрета в БД нет; токен из другой сессии не годится). Операция — `create|<request_id>` / `update|<assignment_id>`. Отпечаток набора = sha256 по отсортированным парам `код=детали`: для пересечений — id конфликтующих назначений, для отсутствий — сотрудник и виды отсутствия, для маршрута — сумма/длительность, для ремонта — id ТС (`transport_warnings_fingerprint :341`). Поэтому токен «для другого набора», для другой заявки/назначения, из другой сессии, с подменённым сроком, просроченный, мусорный, пустой или нестроковый → 409 `confirmation_required` с **актуальным** набором предупреждений (токен в 409 не выдаётся — подтверждение идёт через `dry_run`). Набор вычисляется внутри `BEGIN IMMEDIATE`, поэтому устаревший (появился/исчез конфликт между `dry_run` и записью) токен отклоняется. `dry_run` всегда возвращает `confirm_token` (для пустого набора он ни на что не нужен). В журнале и `override_json` — предупреждения **без текста** (`message` содержит ФИО сотрудников; в журнале только id).

Права — только через `transport_can_edit_request` (viewer/чужая заявка → 403 раньше валидации и предупреждений, `dry_run` тоже); карта `TRANSPORT_EDIT_DELEGATION` не менялась, нового кода ролей нет. Чтение — всем авторизованным; `GET` назначений отдельно нет (вложены в заявку).

## 5. Решения и отклонения (контракт молчит / уточнён)

Отклонений от текста контракта нет; ниже — места, где контракт/тесты неоднозначны и принято решение (для addendum координатора):

1. **Пересечения учитывают кросс-роли:** водитель, занятый в другом назначении как член бригады, даёт `driver_overlap`; член бригады, занятый как водитель, — `crew_overlap`. Назначения заявок `cancelled` не учитываются, `done` — учитываются (T2 Q2 — прошу подтвердить).
2. **`route_sum_mismatch`** проверяется только при непустом `stops` (маршрута нет — сравнивать нечего).
3. **Не больше одного предупреждения каждого кода** (в `conflicts` / `employee_ids` — списки); дополнительные поля предупреждений на верхнем уровне: `conflicts[]`, `employee_id(s)`, `kinds`, `vehicle_id`, `route_min`, `duration_min`.
4. **Порядок `assignments` в заявке** — порядок создания (`rowid`); сьют A4 этого требует.
5. **`PUT` назначения** — отсутствующие поля берутся из текущего (кроме `version`); `request_id` менять нельзя (422 `request_change_forbidden`); без изменений — 200 без записи/версии/журнала. `PUT` заявки: правятся `title/subscriber/address/comment`; `status` в теле ≠ текущему → 422 `status_change_forbidden`; `id/display_no/created_by` игнорируются; `POST` с `status` ≠ `new` → 422 `invalid_status`.
6. **`GET` списка:** при `from/to` — заявки, у которых есть назначение, пересекающее диапазон дней (заявки без назначений не попадают; очередь `new` — `?status=new` без дат); `status` — один или список через запятую; неизвестный → 422 `invalid_status`; плохой диапазон → 422 `invalid_range`; лимит 2000 + `truncated`.
7. **Новые коды 422** сверх контракта: `invalid_stops`, `invalid_crew`, `invalid_title`, `invalid_subscriber|address|comment|source`, `invalid_range`, `invalid_status`, `status_change_forbidden`, `request_change_forbidden`, `id_required`, `version_required`, `invalid_version`; 400 `invalid_action`; 503 `busy`.
8. **Журнал:** `entity_type` = `request` | `assignment`; действия `request.create|update|status`, `assignment.create|update|delete`; у заявки в `before/after` — только изменённые поля (создание — снимок, в нём `subscriber/address/comment` — данные абонента, журнал не очищается и виден только admin; если владелец считает это ПДн — убрать из снимка одной правкой `trq_snapshot`); у назначения — полные снимки (id, время, маршрут, состав бригады — id).
9. Время — `YYYY-MM-DDTHH:MM` строго (`transport_parse_local`: несуществующие дата/время и `T24:00` отвергаются), арифметика `end_at` в UTC-наивном виде без переходов, шаг — `transport_check_step`; `duration_min` — целое (допускается `60.0`), `0 < x ≤ 10080`.

## 6. Проверки

| Что | Результат |
|---|---|
| `bash scripts/verify_all.sh transport` (3 прогона подряд после исправления A4 + прогон внутри полного gate) | `RESULTS: 157 passed, 0 failed`, `DB intact: YES` (`transport PASS 157 157`) |
| Первый прогон на готовом коде | 156/157: A4 (порядок `assignments`) → исправлено сортировкой по `rowid`; тест не менялся |
| `git diff main -- api/transport_test.php` | пуст |
| `reports/V10/T5_evidence/t5_probe.php` (21 проверка вне сьюта) | `21 checks, 0 failed`: токен чужой заявки/чужой сессии/с подменённым сроком/левый/устаревший после изменения набора конфликтов → 409; частичный PUT; PUT вхолостую (версия не растёт); смена `request_id` → 422; `from`-only, `from>to`, `status` списком/мусором; DELETE при `cancelled` → 422; `in_progress` + удаление последнего → `new`; **удержание записи другим соединением → 503 `busy` за 15,2 с (3×`busy_timeout`)**, после снятия — запись проходит |
| `php -l` (4 файла) | без ошибок |
| `node scripts/check_syntax.js`, `bash scripts/check_no_pii.sh` | `failed: 0`, `OK` |

Не проверено: PHP 8.1 (на хосте только 8.3.6; код без возможностей новее 8.1: `never`, `array_is_list` — 8.1; SQL — без CTE/оконных/RETURNING); реальные ФИО в тестах/отчёте не используются.

## 7. GATE

Полный `bash scripts/verify_all.sh` на чистом дереве, коммит `cda4c53` (код = итоговому; позже изменён только комментарий-шапка `transport_warnings.php` и добавлены отчёты), `rc=0`, 2026-11-21 13:54–14:12:

```
SUITE    RES  PASSED EXPECT   TIME  NOTE
smoke    PASS     84     84     3s
tasks    PASS     66     66     5s
tasksn8n PASS     27     27    26s
tasksatt PASS     24     24     7s
tasklinks PASS     37     37     9s
transportdb PASS    117    117     7s
tasksui  PASS    334    334    32s
tasksmx  PASS     79     79     9s
taskscal PASS    220    220     9s
director PASS    101    101    24s
emptasks PASS     34     34     6s
tasklinksui PASS    211    211   148s
e51      PASS     23     23     0s
e52      PASS     41     41     1s
hygiene  PASS     19     19     0s
trips    PASS      7      7     3s
tripsform PASS    131    131    69s
tripsstatus PASS    147    147    81s
syntax   PASS      -      -     0s
phplint  PASS     45      -     8s
pii      PASS      -      -     0s
refs     PASS     28     28    31s  удалено 0, со ссылками 0, исключений 0
tasklink PASS     43     43    14s  коммитов 2, с кодом 1, нарушений 0
clean    PASS

GATE: PASS (23 suites)
```

`transport` в общий gate не входит (`OPT_SUITES`); отдельно: `bash scripts/verify_all.sh transport` → `transport PASS 157 157`, `RESULTS: 157 passed, 0 failed`, `DB intact: YES`.

**Первый полный прогон** (на коммите `61f4b8a`, параллельно шёл gate другого воркера, load average 4–5) — `GATE: FAIL (3)`: `tripsform FAIL 109/131`, `tripsstatus FAIL 143/147` (браузерные сценарии, см. R1) и `clean FAIL` (в дереве появился мой неотслеженный `T5_AGENTS_patch.md` — артефакт моего порядка действий). Остальные 20 сьютов — PASS. Затем: `bash scripts/verify_all.sh tripsform tripsstatus` на `cda4c53` → `tripsform PASS 131`, `tripsstatus PASS 147`, `GATE: PASS (2 suites)`; второй полный прогон (таблица выше) — зелёный целиком.

## 8. Риски и открытые вопросы

* **R1 Тихий хост нужен для браузерных сьютов:** `tripsform`/`tripsstatus` флейкают под нагрузкой (на моём первом прогоне параллельно шёл gate другого воркера: `tripsform FAIL 109/131`, `tripsstatus FAIL 143/147` — UI-сценарии выбора дат/сбоя confirm; файлы `api/trips.php`, `js/`, `index.html` не менялись); отдельный перезапуск обоих — зелёный (см. §7).
* **R2 `confirm_token` привязан к сессии:** при перелогине между `dry_run` и записью токен станет недействительным (409 → повторить `dry_run`); срок 30 мин. Без таблицы в БД: замена схемы не нужна, но «один раз» токен не гарантирует (повторное применение к тому же набору допустимо).
* **R3 Q2 (cancelled/done в пересечениях)** и кросс-роли (§5.1) — решение за координатором; меняется одной строкой в `transport_find_overlaps` (`api/transport_warnings.php:73`).
* **R4 `transport_tx` (T1) не заменён на `transport_write`:** справочники/перенос по-прежнему без повтора на `BEGIN IMMEDIATE`; переключить — отдельной мелкой задачей (границы T5 запрещают править `transport_vehicles.php`).
* **R5 Нагрузка списка:** `GET` без `from/to` отдаёт до 2000 заявок с назначениями; для доски (T6) нужен собственный запрос с диапазоном.
* **Приёмка:** перенос сьюта `transport` из `OPT_SUITES` в `ALL_SUITES` (`scripts/verify_all.sh`) — координатор, по патчу `T5_AGENTS_patch.md` §1.
