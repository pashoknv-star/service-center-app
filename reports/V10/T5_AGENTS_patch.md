# V10-T5 — патч для `AGENTS.md` (применяет координатор)

`AGENTS.md` воркер не правит. Предлагаемые изменения — «было / стало».

## 1. Таблица сьютов — строка `transport (V10-T2)`

**Было** (хвост строки): «… журнал, атомарность); **до V10-T5 ожидаемо красный и в общий gate не входит** (`OPT_SUITES`)»

**Стало:** «… журнал, атомарность); реализация — `api/transport_requests.php`, `api/transport_assignments.php`, `api/transport_warnings.php` (V10-T5), зелёный: `RESULTS: 157 passed, 0 failed`; из `OPT_SUITES` в `ALL_SUITES` переносится при приёмке T5 (две правки в `scripts/verify_all.sh`: перенос имени и уход из `OPT_SUITES`)». После переноса добавить `transport 157` в перечень эталонов (строка «на 2026-11-18 (…)»).

## 2. Раздел «Решения владельца 2026-11-21 (V10)» — добавить пункты

- Запись в модуле «Транспорт» (заявки, назначения; справочники T1 пока на `transport_tx`) — через `transport_write($pdo, callable)` из `api/transport_lib.php`: `BEGIN IMMEDIATE`, повтор ≤ 3 попыток **только** на `BEGIN IMMEDIATE` (пауза 40/80 мс), завершение `exec('COMMIT')`/`exec('ROLLBACK')` по собственному флагу; не взяли блокировку — 503 `busy`; тело транзакции не перезапускается. Проверка пересечений, `confirm_token` и запись назначения — внутри одной такой транзакции.
- Предупреждения назначений не блокируют: `confirm_token` = `<exp>.<hmac>` (срок 30 мин), подпись привязана к сессии и пользователю, операции (`create|<request_id>` / `update|<assignment_id>`) и отпечатку набора (коды + конкретные конфликты). Любой иной токен → 409 `confirmation_required` с актуальными предупреждениями.
- Таблица ручных переходов статусов заявки — в `api/transport_requests.php` (`TRQ_TRANSITIONS`) и `reports/V10/T5_REPORT.md` §2; `new → assigned` — только автоматически при создании назначения, возврат в `new` при удалении последнего (из `assigned`/`in_progress`).
- Отсутствия сотрудников для предупреждений `driver_absent`/`crew_absent`: `schedule_entries.status IN ('vacation','sick','trip')` и `trip_participants` (любой статус командировки); `day_off` не считается (`api/transport_warnings.php`, шапка).

`PROGRESS.md` в T5 не менялся (границы задачи): строка для Current State — «V10-T5: API заявок/назначений/предупреждений реализован, сьют `transport` 157/157; коммит — см. `reports/V10/T5_REPORT.md`».
