# V10-T5 — Транспорт: API заявок, назначений и предупреждений (фаза B)

Сначала прочитай `reports/V10/specs/00_COMMON.md` (решения владельца обязательны), `reports/V10/specs/CONTRACT.md` (часть 2 — твой контракт), `reports/V10/ADR_DB.md` (§2.2, §5 — как писать безопасно), `reports/V10/T1_REPORT.md` и `reports/V10/T2_REPORT.md`.

Workspace: worktree `/home/hermes/wt/v10-t5` (ветка `v10-t5-api`). Работай и коммить только там; main и чужие worktree не трогай. Исполнитель: sd_worker_03. Не пушить, не деплоить, `AGENTS.md` не править (патч-файлом `reports/V10/T5_AGENTS_patch.md`).

## Объём

Реализовать часть 2 `CONTRACT.md` целиком:

1. `api/transport_requests.php` — `GET` (`?id=`, список `from/to/status`, `can_edit` считает сервер), `POST`, `PUT`, `PUT ?action=status` (таблица переходов — свой раздел в отчёте; недопустимый → 422 `invalid_transition`), `DELETE` → 405.
2. `api/transport_assignments.php` — `POST`/`PUT`/`DELETE`, `dry_run`, `confirm_token` (привязан к набору предупреждений; чужой/устаревший набор → отказ), автоматика статуса (`new→assigned` при первом назначении, возврат в `new` при удалении последнего), валидации 422 из контракта.
3. `api/transport_warnings.php` (внутренняя библиотека): `vehicle_overlap`, `driver_overlap`, `crew_overlap`, `driver_absent`, `crew_absent`, `vehicle_in_repair`, `route_sum_mismatch`. Коды статусов отсутствия (отпуск/болезнь/командировка) — **из исходников** (`schedule_entries`, `trips`, `rg` по `api/` и `index.html`), не из памяти; в отчёт — `file:line`.
4. Права — только через `api/transport_lib.php` (`transport_can_edit_request`, `transport_allowed_drivers`, `TRANSPORT_EDIT_DELEGATION`); новую логику ролей не изобретать.
5. Проверка пересечений и запись — **в одной транзакции `BEGIN IMMEDIATE`** (`exec('BEGIN IMMEDIATE')`; `PDO::inTransaction()` ручной BEGIN не видит — вести свой флаг, см. `AGENTS.md`, ловушка V10). Журнал — `transport_journal_write` в той же транзакции; `VERSION_CONFLICT` и отказы журнал не засоряют. Повторов после `SQLITE_BUSY` в прод-коде нет — для писателей модуля сделать ограниченный (≤ 3, с короткой паузой) повтор только на `BEGIN IMMEDIATE`.
6. Идентификаторы `tr_`/`ta_`, время `YYYY-MM-DDTHH:MM` (+05), шаг 15 минут — через `transport_check_step`/`transport_now_local`.

## Границы

Твои файлы: `api/transport_requests.php`, `api/transport_assignments.php`, `api/transport_warnings.php`, при необходимости добавление функций в `api/transport_lib.php` (не менять существующие сигнатуры), `scripts/verify_all.sh` — **не трогай** (сьют `transport` в `OPT_SUITES` переносит в `ALL_SUITES` координатор при приёмке). Не трогать: `api/transport_vehicles.php`, `api/schema.sql`, `api/db.php`, `js/`, `index.html`, **тесты сьюта `transport` (`api/transport_test.php`) — не править ни строчки**. Если тест, по-твоему, расходится с контрактом — `kanban block` с цитатой контракта и номером проверки (решение за координатором), а не правка теста.

## Приёмка

- `bash scripts/verify_all.sh transport` → `RESULTS: 157 passed, 0 failed`, `DB intact: YES` **без изменений `api/transport_test.php`** (проверка: `git diff main -- api/transport_test.php` пуст).
- Полный `bash scripts/verify_all.sh` → `GATE: PASS` (браузерный `tripsform` флейкает под нагрузкой — при красном перезапусти отдельно и приведи оба прогона).
- `php -l`, `node scripts/check_syntax.js`, `bash scripts/check_no_pii.sh` → OK. `data/app.db` не тронут.
- Отчёт `reports/V10/T5_REPORT.md`: таблица переходов статусов, коды статусов отсутствия (`file:line`), как устроены `confirm_token` и транзакция, отклонения от контракта (если есть), GATE-таблица.
- Коммит с `t_…` своей карточки в сообщении (хук `commit-msg`).

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
