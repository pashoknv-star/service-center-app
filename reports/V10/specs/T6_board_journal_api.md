# V10-T6 — Транспорт: API доски и чтения журнала (фаза B)

Сначала прочитай `reports/V10/specs/00_COMMON.md`, `reports/V10/specs/CONTRACT.md` (раздел `transport_board.php`/`transport_journal.php`, таблица прав), `reports/V10/T1_REPORT.md`.

Workspace: worktree `/home/hermes/wt/v10-t6` (ветка `v10-t6-board`). Работай и коммить только там; main и чужие worktree не трогай. Исполнитель: sd_worker_01. Не пушить, не деплоить, `AGENTS.md` не править (патч-файлом).

## Объём

1. `api/transport_board.php` — `GET ?from=YYYY-MM-DD&to=YYYY-MM-DD` (период ≤ 31 день, иначе 422 `range_too_long`): одним запросом — базы с ТС (текущая `base_id`), назначения периода (заявка, ТС, водитель, бригада, остановки, `start_at`/`end_at`, `version`), очередь нераспределённых заявок (`status = new`, без назначений), отсутствия водителей/бригады (`schedule_entries`, `trips` — только факт и тип для подсветки, без лишних персональных данных), `can_edit` по каждой заявке и `can_move_vehicle` для текущего пользователя (из `transport_lib.php`). Доступно всем авторизованным ролям, чужие заявки видны всем. Не N+1: число SQL-запросов не зависит от числа назначений (проверить тестом-счётчиком или явным обоснованием в отчёте).
2. `api/transport_journal.php` — только `GET`, только admin (остальные 403, аноним 401): фильтры `from`, `to`, `entity_type`, `entity_id`, `actor`, `action`, пагинация (`limit` ≤ 200, `offset`), `format=csv` — выгрузка (с экранированием ячеек, начинающихся с `= + - @`). Ничего не пишет.
3. Читай и используй `transport_lib.php`; существующие сигнатуры не менять.

## Тесты (новый сьют `transportboard`, файл `api/transport_board_test.php`, образец — `api/transport_db_test.php`)

Красный прогон до реализации — `reports/V10/T6_RED_run_before_impl.txt`. Минимум ≥ 60 проверок: права по ролям (admin, supervisor_zone0/1, viewer_test, аноним), период и граничные даты, перенос ТС виден на доске после `action=move`, назначение через полночь попадает в оба дня, очередь нераспределённых, отсутствия подсвечиваются, журнал: фильтры, пагинация, CSV-экранирование, не-admin 403, журнал не меняется после чтения. Фикстуры — через API T1 и прямые INSERT в копию БД (`SC_APP_DB`), данные синтетические. В `scripts/verify_all.sh` — `BASELINE`, `ALL_SUITES`, `run_suite` для `transportboard` (только эти строки).

## Границы

Твои файлы: `api/transport_board.php`, `api/transport_journal.php`, `api/transport_board_test.php`, строки `transportboard` в `scripts/verify_all.sh`. Не трогать: `api/transport_requests.php`, `api/transport_assignments.php`, `api/transport_warnings.php` (T5, параллельно), `api/transport_vehicles.php`, схему, `js/`, `index.html`, `AGENTS.md`, `data/app.db`. Если нужна функция в `transport_lib.php` — добавить новую, не менять существующие.

## Приёмка

- `bash scripts/verify_all.sh transportboard` зелёный; полный `bash scripts/verify_all.sh` → `GATE: PASS` (`tripsform` — при красном перезапуск отдельно, оба прогона в отчёт); `php -l`, `check_syntax.js`, `check_no_pii.sh` OK; `data/app.db` не тронут.
- Отчёт `reports/V10/T6_REPORT.md`: формат ответа доски (пример JSON с синтетикой), как устроен одиночный запрос, GATE-таблица.
- Коммит с `t_…` своей карточки.

## Индекс кода

```
Индекс кода (CodeGraph/CODEMAP/rg) — навигация, не истина. Класс задачи: 🟡.
- Перед правкой читай реальный файл (локальный контекст) и сверяй с rg по проекту.
- «Нет вызовов/не используется/impact пуст» ≠ доказательство; для delete/rename/сигнатур — rg по всему репо.
- Триггеры ручной проверки: динамика, DI/события, HTML-строки/window.*, одноимённые символы, JS↔PHP по URL, конфиги/SQL/миграции.
- Индекс устарел после merge/rebase/смены ветки — не доверяй; CODEMAP не покрывает api/*.php.
- Утверждения в квитанции — с file:line и источником (индекс / файл / тест). При 3 расхождениях индекса с файлом — прекрати его использовать и сообщи.
- Приёмка только по git diff, verify_all.sh (GATE таблица целиком), тестам.
```
