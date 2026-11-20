# V10-T1 — Транспорт: схема v15, ТС, базы, пул водителей, перенос ТС, журнал

Сначала прочитай `reports/V10/specs/00_COMMON.md` и `reports/V10/specs/CONTRACT.md` — решения владельца и контракт обязательны. План — `reports/V10/PLAN.md`.

Workspace: worktree `/home/hermes/wt/v10-t1` (ветка `v10-t1-schema`). Работай и коммить только там; main и чужие worktree не трогай. Исполнитель: sd_worker_01. Не пушить, не деплоить, `AGENTS.md` не править (патч-файлом).

## Объём

1. **Схема v15** (`api/schema.sql`, `api/db.php`: `SCHEMA_VERSION` 14→15 + `applyIncrementalMigrations`): все таблицы из `CONTRACT.md` — `transport_bases`, `vehicles`, `transport_driver_pool`, `transport_requests`, `transport_assignments`, `assignment_crew`, `assignment_stops`, `geo_cache`, `transport_journal`; индексы по `(vehicle_id,start_at,end_at)` и `(driver_id,start_at,end_at)`; CHECK кратности 15 для `duration_min` (и `stay_min`/`leg_min` у остановок). Только добавление, идемпотентно. `employee_id`/`driver_id` — TEXT (как `employees.id`). Миграцию проверить на КОПИИ `data/app.db` (v14→v15, повторный запуск ничего не ломает, прежние данные на месте, `data/app.db` не изменён).
2. **Журнал `transport_journal`:** триггеры `BEFORE UPDATE`/`BEFORE DELETE` → `RAISE(ABORT, …)`; очистка `audit_log` (`api/helpers.php` `audit_cleanup`, `api/db.php` ротация) журнал не затрагивает — доказать тестом (искусственно «состарить» записи и вызвать очистку).
3. **`api/transport_lib.php`** — функции из `CONTRACT.md` (роль/пользователь, `transport_can_move_vehicle`, `transport_can_edit_request` с `TRANSPORT_EDIT_DELEGATION`, `transport_allowed_drivers`, `transport_journal_write`, проверка шага 15, локальное время +05).
4. **`api/transport_vehicles.php`** — строго по `CONTRACT.md` «Часть 1»: GET; справочники баз/ТС/пула (admin); `action=move` (admin или viewer). Каждая мутация пишет журнал в той же транзакции (действия: `base.create|update`, `vehicle.create|update|move`, `driver_pool.add|remove`). Версионирование ТС и 409 `VERSION_CONFLICT` как в `api/tasks.php`.
5. **Не сломать:** существующие сьюты; тесты, зашитые на `schema_version == 14`, обновить осознанно (список файлов — в отчёте, найди `rg "schema_version" api scripts`).
6. Допустимые водители — по **названию** группы «Транспорт», не по `g6`; в dev-БД в этой группе нет сотрудников — фикстуры в тестах создавать самому (синтетические имена, не «Сотрудник NN» — это шаблон `check_no_pii.sh`).

## Границы

Твои файлы: `api/schema.sql`, `api/db.php`, `api/transport_lib.php`, `api/transport_vehicles.php`, новый `api/transport_db_test.php`, `scripts/verify_all.sh` (сьют `transportdb`: `BASELINE`, `ALL_SUITES`, `run_suite`), существующие тесты — только ожидания `schema_version`. **Не трогать:** `api/transport_requests.php`, `api/transport_assignments.php`, `api/transport_test.php` (T2/T5), `js/*`, `index.html`, `css/*`.

## Тесты (новый сьют `transportdb`, файл `api/transport_db_test.php`, на временной копии БД через `SC_APP_DB` — по образцу `api/tasks_links_test.php`)

Красный прогон до реализации — в `reports/V10/T1_RED_run_before_fix.txt`. Минимум кейсов: миграция v14→v15 на копии (повтор, данные на месте, `meta.schema_version = 15`); все таблицы и индексы существуют; CHECK шага 15; журнал: UPDATE и DELETE падают, запись при мутациях, `audit_cleanup` его не трогает; CRUD баз и ТС (admin), уникальность имени базы и госномера, `use_move`, `version_required`, 409; пул (добавление, дубль, удаление, `driver_in_use`); `drivers` = группа ∪ пул без дублей, без телефона/фото; **роли по таблице прав в `CONTRACT.md`**: admin — всё; supervisor_zone0/supervisor_zone1 — чтение, но не справочник и не `move` (403); **viewer_test — чтение и `move` (200), остальная запись 403**; аноним 401; `move`: неизвестная база, `same_base`, версия, журнал `vehicle.move` с before/after, назначения не меняются; `transport_can_edit_request` — юнит-проверки таблицы прав (admin, zone0 на свои и на заявки zone1, zone1 только свои, viewer никогда); изоляция (`data/app.db` не тронут — «DB intact: YES»). Ориентир ≥ 80 проверок.

## Приёмка

- `bash scripts/verify_all.sh transportdb`, затем полный `bash scripts/verify_all.sh` → `GATE: PASS`; `BASELINE` обновлён; `php -l` для изменённых файлов; `node scripts/check_syntax.js`; `bash scripts/check_no_pii.sh`.
- Отчёт `reports/V10/T1_REPORT.md`: контракт как реализован (отклонения от `CONTRACT.md` — отдельным списком, лучше блок до реализации), что проверено на копии БД, список обновлённых тестов `schema_version`, готовый идемпотентный DDL v15 для прод-БД отдельным разделом, риски. Если для `AGENTS.md` нужны правки (сьют, BASELINE) — `reports/V10/T1_AGENTS_patch.md`.

## Индекс кода

```
Индекс кода (CodeGraph/CODEMAP/rg) — навигация, не истина. Класс задачи: 🔴.
- Перед правкой читай реальный файл (локальный контекст) и сверяй с rg по проекту.
- «Нет вызовов/не используется/impact пуст» ≠ доказательство; для delete/rename/сигнатур — rg по всему репо.
- Триггеры ручной проверки: динамика, DI/события, HTML-строки/window.*, одноимённые символы, JS↔PHP по URL, конфиги/SQL/миграции.
- Индекс устарел после merge/rebase/смены ветки — не доверяй; CODEMAP не покрывает api/*.php.
- Утверждения в квитанции — с file:line и источником (индекс / файл / тест). При 3 расхождениях индекса с файлом — прекрати его использовать и сообщи.
- Приёмка только по git diff, verify_all.sh (GATE таблица целиком), тестам.
```
