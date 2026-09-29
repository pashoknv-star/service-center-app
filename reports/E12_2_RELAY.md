# E12-2: Relay v2 — отчёт о реализации и прогоне

Дата: 2026-09-29. Исполнитель: sd_worker_02. Задача: t_59931f05.
Все проверки ниже — РЕАЛЬНО выполненные команды с их фактическими ответами.
Код прошлой попытки в дереве отсутствовал (откачан); api/trip_relay.php написан
с нуля. Отчётный e2e — живой php -S на порту 8210, SC_APP_DB на КОПИИ dev-БД.

## 1. Изменённые файлы (file:line)

| Файл | Что изменено |
|---|---|
| api/helpers.php:100-113 | `generateRequestId(string $tripId, int $participantNum): string` — общая функция; формат `SC-` + первые 4 символа trip id + `-` + номер участника + `-` + unixtime. В trip_relay.php НЕ переопределяется. |
| api/db.php:33 | `SCHEMA_VERSION = 8`. |
| api/db.php:245-272 | Инкрементальная миграция v7→v8: `CREATE TABLE IF NOT EXISTS trip_requests (...)` + индексы `idx_trip_requests_status`, `idx_trip_requests_created_at` (идемпотентно). |
| api/schema.sql:1-13, 192-215 | Шапка Version: 8; таблица `trip_requests` + 2 индекса (для свежих БД). |
| api/trips.php:307-368 | `trips_build_rpa_payload()` — payload контракта v1.2: даты DD.MM.YYYY, `days = (end-start)/86400 + 1`, D5 `sentAt = now()` (момент генерации), D6 NULL-строки → `''`. |
| api/trips.php:643-696 | Триггер в `PUT ?action=confirm` ВНУТРИ транзакции после UPDATE статуса: на каждого участника — строка trip_requests; D4 дубль-защита `SELECT 1 ... WHERE trip_id AND employee_id AND status IN ('queued','delivered')`; D1 — сбой очереди не валит confirm (try/catch + error_log). |
| api/trips.php:24-29 | Обновлён header-докблок (confirm → очередь, D1/D4). |
| api/trip_relay.php (новый, 214 строк) | Релей: token-хелперы (:50, :72), reveal (:103), poll GET (:113), callback POST (:158). |

js/, index.html — НЕ тронуты.

## 2. D1–D7

- **D1** (confirm не падает от очереди): постановка trip_requests обёрнута в try/catch
  внутри confirm-транзакции (api/trips.php:642-695); ошибка уходит в error_log,
  confirm возвращает 200.
- **D2** (токен): `relay_ensure_token()` — `INSERT OR IGNORE INTO meta ('rpa_relay_token', bin2hex(random_bytes(32)))` при первом обращении; просмотр владельцем — `GET ?action=reveal` под require_auth+require_edit; в обычных ответах relay токена нет (проверено grep-ом, AC g).
- **D3** (poll/callback без PHP-сессии): в trip_relay.php require_auth вызывается ТОЛЬКО в ветке reveal; GET/POST аутентифицируются исключительно X-Auth-Token (AC c: робот-запрос без cookie → 200).
- **D4** (дубль-защита): SELECT перед INSERT на каждого участника; повторные confirm-циклы не плодят строки, пока заявка queued/delivered (AC b).
- **D5** (sentAt): `now()` в момент генерации payload (api/trips.php:337), не дата поездки; в e2e sentAt=2026-09-29T08:48:35+00:00 при поездке 01.02.2027.
- **D6** (ФИО): fullName из `employees.full_name` по employee_id (SELECT в триггере); NULL/удалённый сотрудник → `''`. Проверено участником-призраком: `fullName: ""`.
- **D7** (идемпотентная миграция): dev-копия БД v6 → v8 поднялась при первом запросе; повторные migrate() за время прогона ошибок не вызывали; meta.schema_version=8 на копии.

## 3. Статические проверки

```
$ php -l api/helpers.php && php -l api/db.php && php -l api/trips.php && php -l api/trip_relay.php
No syntax errors detected in api/helpers.php
No syntax errors detected in api/db.php
No syntax errors detected in api/trips.php
No syntax errors detected in api/trip_relay.php
```

## 4. Smoke (полный сьют, реальная dev-БД data/app.db)

```
$ php api/smoke_test.php
[64] audit cutoff format ...: PASS
...
[76] E5-6 save.php employee.delete audit via payload removal: PASS
=== RESULTS: 76 passed, 0 failed out of 76 ===
DB intact: YES      (exit 0)
```

T3-10 (confirm + admin edit confirmed) и T3-11 в числе прошедших 76/76.

После смоука по правилу репозитория:

```
$ git checkout -- data/app.db
$ sqlite3 data/app.db "SELECT value FROM meta WHERE key='schema_version';"   → 6 (базовое)
```

## 5. Живой e2e (php -S :8210, SC_APP_DB=копия dev-БД)

Подготовка:

```
$ cp data/app.db $SCRATCH/e12_2_e2e.db          # копия, data/app.db не участвует
$ SC_APP_DB=.../e12_2_e2e.db php -S 127.0.0.1:8210 router.php &   # background
$ curl -s http://127.0.0.1:8210/api/session.php → {"authenticated": false}
$ curl -s -c admin.jar -X POST .../api/login.php -d '{"username":"admin","password":"changeme"}' → 200 success
```

### (a) confirm forecast-trip с 2 участниками → ровно 2 queued

Создан trip «E12-2 final» (location=Сочи, origin=Екатеринбург,
hotel, transportOut avia, transportBack required=0 zd, advance 12000, phone,
participants emp_2 01-04.02.2027, emp_3 02-05.02.2027) → 201.

```
$ curl -b admin.jar -X PUT ".../api/trips.php?id=trip_6abb7b62...&action=confirm" -d '{}'
→ HTTP:200
$ sqlite3 e12_2_e2e.db "SELECT COUNT(*) FROM trip_requests WHERE trip_id='trip_6abb7b62...' AND status='queued';"
→ 2
$ sqlite3 ... "SELECT request_id, employee_id FROM trip_requests WHERE trip_id='trip_6abb7b62...' ORDER BY employee_id;"
SC-trip-1-1790671715 | emp_2
SC-trip-2-1790671715 | emp_3
```

### (b) повторный цикл (forecast → confirm) → новых строк НЕТ

```
$ curl -b admin.jar -X PUT ".../api/trips.php?id=<TF>" -d '{"status":"forecast","entryVersion":2}' → HTTP:200
$ curl -b admin.jar -X PUT ".../api/trips.php?id=<TF>&action=confirm" -d '{}'                      → HTTP:200
$ sqlite3 ... "SELECT COUNT(*) FROM trip_requests WHERE trip_id='<TF>';"
→ 2  (было 2, новых нет — D4 сработала)
```

Дополнительно (стресс-вариант на другом trip): при наличии 4 queued-строк по
2 trip-ам цикл forecast→confirm×2 дал `before=8 after=8` — ни одной новой строки.

### (c) аутентификация poll

```
$ curl .../api/trip_relay.php                                    → {"error":"missing_token"}  HTTP:401
$ curl -H 'X-Auth-Token: xyz' .../api/trip_relay.php             → {"error":"invalid_token"}  HTTP:401
$ curl -H "X-Auth-Token: <reveal-токен>" .../api/trip_relay.php  → 200 {requestId, payload}   (БЕЗ cookie/jar — робот-сценарий)
```

### (d) payload GET1 (полный фактический ответ)

```json
{
    "requestId": "SC-trip-1-1790671715",
    "payload": {
        "requestId": "SC-trip-1-1790671715",
        "sentAt": "2026-09-29T08:48:35+00:00",
        "employee": { "fullName": "Ivanov Ivan", "phone": "+7-900-555-66-77" },
        "trip": {
            "destination": "Сочи", "origin": "Екатеринбург",
            "dateStart": "01.02.2027", "dateEnd": "04.02.2027",
            "details": "финальный прогон", "hotel": "Жемчужина", "days": 4
        },
        "transport": {
            "out":  { "required": 1, "mode": "avia", "from": "Екатеринбург", "to": "Сочи" },
            "back": { "required": 0, "mode": "zd",   "from": "Сочи", "to": "Екатеринбург" }
        },
        "businessProcess": "Служебная командировка",
        "advance": { "amount": 12000 }
    }
}
```

fullName = реальное ФИО из employees (Ivanov Ivan); phone = trips.phone;
sentAt = момент confirm-а (2026-09-29), НЕ дата поездки (01.02.2027);
days = 4 (01–04.02 включительно); даты DD.MM.YYYY; back.required=0 прошёл как есть.

### (e) выдача по одному разу

```
GET1 → requestId SC-trip-1-1790671715 (emp_2)
GET2 → requestId SC-trip-2-1790671715 (emp_3)
GET3 → {"requestId": null}  HTTP:200
GET4 → {"requestId": null}
sqlite: обе строки status='delivered', claimed_at NOT NULL
```

Очерёдность «старейшая первая» отдельно видна на общем прогоне: при 4 queued
задачах (2 trip-а) GET выдавал их строго по возрастанию created_at
(SC-trip-1-…607 → SC-trip-2-…607 → SC-trip-1-…626 → SC-trip-2-…626).

### (f) callback

```
$ curl -X POST -H "X-Auth-Token: ..." -d '{"requestId":"SC-trip-1-1790671715","status":"created","ticketId":"SD-2027-001","attempt":1}'
→ {"success":true} HTTP:200
sqlite: status=created, ticket_id=SD-2027-001, attempts=1, done_at NOT NULL

$ curl -X POST ... -d '{"requestId":"SC-trip-2-1790671715","status":"failed","reason":"рейс не найден","attempt":2}'
→ 200; затем validation_error (reason «нет hotel», attempt 3) → 200 — перезапись last-write-wins
sqlite: status=validation_error, last_error=нет hotel, attempts=3

$ curl -X POST ... -d '{"requestId":"SC-xxx-9-1","status":"created"}'   → {"error":"request_not_found"} HTTP:404
$ curl -X POST ... -d '{"requestId":"...","status":"foo"}'              → {"error":"invalid_status"}  HTTP:400
```

### (g) reveal и секретность токена

```
$ curl -b admin.jar '.../api/trip_relay.php?action=reveal'   → {"success":true,"token":"73ddb841...750"}  HTTP:200
$ curl -b sup.jar  '.../api/trip_relay.php?action=reveal'    → token, и он ПОБАЙТОВО равен
  sqlite3 "SELECT value FROM meta WHERE key='rpa_relay_token'" (diff OK), и рабочему токену робота
$ curl '.../api/trip_relay.php?action=reveal' (без сессии)   → {"error":"unauthorized"} HTTP:401
grep <token> get1.json (ответ poll)         → совпадений 0
grep <token> (ответ callback)               → совпадений 0
```

### (доп) D6-крайний случай

Trip с участником emp_ghost, добавленным в копию БД напрямую (строки в
employees нет): confirm → 200; payload этого участника: `"fullName": ""`,
`"phone": ""` (не null). Всего строк trip_requests за прогон — по трём trip-ам,
ни одного падения confirm.

## 6. Состояние после работы

- Сервер :8210 остановлен (process kill; в access-логе виден весь прогон 401/200/404/400).
- Копия БД $SCRATCH/e12_2_e2e.db остаётся в scratch (не является артефактом репо).
- data/app.db: schema_version=6 (базовое), таблицы trip_requests нет.
- git status: изменения ТОЛЬКО api/{helpers,db,trips}.php, api/schema.sql, api/trip_relay.php (новый), настоящий отчёт. Файлы js/trips.js, js/trips.js.backup_E12_3, test_cookies.jar, reports/E12_3_*.md принадлежат параллельной задаче E12-3 — не мои.

## 7. Что НЕ делалось (вне скоупа)

- js/, index.html — не тронуты (по скоупу задачи).
- Прод-деплой на Hostland — только по явной команде владельца (AGENTS.md).
- Пуш в main — после приёмки фазы координатором.
