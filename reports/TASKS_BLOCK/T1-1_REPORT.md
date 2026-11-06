# T1-1 — Блок «Задачи»: БД + api/tasks.php + тесты (backend)

Исполнитель: sd_worker_02 · Дата: 2026-11-07 · Kanban: t_25df1d43
Основание: `specs/00_COMMON.md`, `specs/T1-1.md`, `TZ.md` v0.2 §1–3, §6.

## Итог

Серверное ядро блока реализовано и проверено. `bash scripts/verify_all.sh` → `GATE: PASS (9 suites)`,
новый сьют `tasks` 33/33, существующие сьюты без регрессий (smoke 84/84, e51 23, e52 41, hygiene 19, trips 7).
Деплой не выполнялся, push не выполнялся, n8n/LLM не вызываются.

## Отклонения от ТЗ (важно)

1. **Версия схемы — 9, а не 7.** В ТЗ написано «schema version 7», но `api/db.php` уже на v8
   (v7 = E12-1 RPA-поля, v8 = E12-2 `trip_requests`). Понижать версию нельзя, поэтому блок «Задачи» = **v9**.
   Если нужен другой номер — решение координатора.
2. **`holidays_provider.php` — минимальный рефакторинг** (требование «через существующий holidays_provider»):
   endpoint-часть обёрнута в `if (!defined('HOLIDAYS_PROVIDER_AS_LIB'))`, логика чтения JSON/fallback вынесена в
   функцию `holidays_provider_year()`. Поведение HTTP-endpoint не изменилось (тест G1: ответ идентичен
   `data/holidays/2027.json`, fallback для 2031, 400 для 1999, 405 для POST).
3. **`AGENTS.md` не обновлён:** строка про BASELINE («smoke 84, e51 23, …») осталась со старым перечнем без `tasks 33`.
   Правка защищённого файла инструкций была заблокирована (нет интерактивного одобрения) — не обходилась.
   Единственный источник эталона — массив `BASELINE` в `scripts/verify_all.sh` (обновлён). Координатору: поправить строку в AGENTS.md.
4. `check_state`: см. «Точка расширения n8n» ниже — в T1-1 при ненастроенном n8n итог `ok` (локальные правила авторитетны).

## Что реализовано

### Миграция БД (TZ §1)
- `api/schema.sql` + `api/db.php` (`SCHEMA_VERSION = 9`, блок `if ($current < 9)`): таблицы `tasks`, `task_assignees`
  (role `assignee|watcher`, PK `(task_id, employee_id, role)`, FK ON DELETE CASCADE), `task_checklist`;
  индексы `idx_tasks_start_at`, `idx_tasks_status`, `idx_task_assignees_emp` (+ `idx_task_checklist_task`);
  CHECK на `status`, `check_state`, `priority 1..3`, `role`. Только `CREATE ... IF NOT EXISTS` — идемпотентно, данные не затрагиваются.
- Тесты M1–M4: миграция v6→v9 на копии реальной `data/app.db`; 10 существующих таблиц побайтово равны (md5 строк), `meta` без изменений;
  повторный запуск и «откат» на v8 с живой строкой задачи — данные сохранены.
  (Побочный эффект, существовавший ДО T1-1: `migrate()` вызывает `cleanupAuditLog()` — чистит audit_log старше 7 дней.)

### Правила — `api/tasks_rules.php` (TZ §3; эталон для n8n в T1-4)
`tasks_validate_period`, `tasks_matrix_facts`, `tasks_blocked_days`, `tasks_suggest_start`, `tasks_notes_from_facts`,
`tasks_check_period` (формат результата = контракт webhook `tasks-validate`: `blocked_days`, `suggested_start`, `notes`),
`tasks_calendar_facts`, `tasks_day_info` (таблица `holidays` приоритетнее `data/holidays/*.json`, затем fallback провайдера).
- Блок: у любого **исполнителя** (assignee; наблюдатели не учитываются) день со `schedule_entries.status ∈ {sick, trip}`
  или покрытый `trips`+`trip_participants` (любой статус forecast/confirmed). Выходной/праздник/`vacation`/`day_off` — только `notes`.
- `suggested_start` — ближайшая дата ≥ start, где весь период той же длины вне блоков (горизонт 400 дней, иначе `null`).
- Макс. длина периода — 366 дней (`period_too_long`).

### API — `api/tasks.php` (TZ §2)
| Запрос | Результат |
|---|---|
| GET `?from&to&employee_id` (+`status`, `include_archived=1`) | список; без `employee_id` — все задачи диапазона; `employee_id` = исполнитель или наблюдатель |
| GET `?id=` | карточка |
| POST | создать (FR-10 внутри транзакции) → 201 |
| PUT `?id=` + `version` | править/переназначать (assignees/watchers/checklist); `version` обязателен |
| POST `?id=&action=close\|reopen` | смена статуса (идемпотентно, `version` опционален) |
| DELETE `?id=` | архив `archived=1` (version++), из списка скрыта, по id читается |
| GET `?calendar_facts&employee_id=a[,b]&from&to` | `Authorization: Bearer <meta.external_api_token>`; по дням: `matrix_status`, `day_type`/`is_day_off`/`holiday_label`, `trip{id,status}` |

- RBAC: чтение — любой авторизованный; запись — `require_admin()` (anon → 401, supervisor/viewer → 403). calendar_facts — только токен (сессия не принимается).
- Вычисляемые поля в GET: `first_day`, `last_day`, `days[]`, `conflict` (+`conflict_days`; только открытая неархивная), `notes[]`.
- Ошибки: 409 `VERSION_CONFLICT` (с `current_version` и актуальной карточкой), 422 `TASK_BLOCKED_BY_SICK_OR_TRIP`
  (`blocked_days`, `suggested_start`, `suggested_end`, время суток сохраняется), 400-коды валидации (`title_required`, `invalid_start_at`, `end_before_start`, `assignees_required`, `employee_not_found`, …).
- FR-10 при PUT проверяется **только если изменились срок или исполнители** — иначе правка текста задачи, у которой позже появился больничный (conflict, AC-4), блокировалась бы. Решение принято мной, не ТЗ — подтвердить.
- Аудит (`audit_log`, entity_type `task`): `task.create`, `task.update` (changed, from/to version, assignees_before/after, period_before/after), `task.close`, `task.reopen`, `task.archive`. Сбой аудита откатывает мутацию. Отказы (401/403/409/422) в аудит не пишутся.
- Приватность: из сотрудника отдаются только `employee_id` и `full_name`; тест P1 проверяет отсутствие `phone`/`photo`/значений телефона и фото в списке, карточке, POST-ответе, calendar_facts и audit_log, а также что токен не появляется в ответах.
- Не затронуты: `save.php`, `load.php`, `trips.php` (регрессия — smoke 84/84 и trips 7/7).

### Точка расширения n8n (T1-4)
`tasks_external_validate()` / `tasks_resolve_check_state()` в `tasks_rules.php`. Вызов webhook НЕ реализован.
Env `TASKS_VALIDATE_WEBHOOK_URL` не задан → `check_state='ok'`; задан, но вызов недоступен (сейчас всегда) → `check_state='pending'` (основа AC-8). T1-4 заменяет тело `tasks_external_validate()` на HTTP-вызов с таймаутом 3 с.

## Изменённые / новые файлы
- `api/schema.sql`, `api/db.php` — схема v9
- `api/tasks.php` (новый), `api/tasks_rules.php` (новый)
- `api/holidays_provider.php` — рефакторинг в библиотеку (см. отклонение 2)
- `api/tasks_test.php` (новый сьют, 33 теста, на временной копии БД через `SC_APP_DB`; `data/app.db` не меняется — сверка sha1)
- `scripts/verify_all.sh` — сьют `tasks`, `BASELINE[tasks]=33`
- `PROGRESS.md` — Current State
- `reports/TASKS_BLOCK/T1-1_REPORT.md` (этот файл)

В рабочем дереве есть чужие изменения, не относящиеся к задаче и **не включённые в коммит**: `reports/BACKLOG.md`,
`staff_project/Roadmap доработок (обновлён).xlsx`, `reports/backlog/`, а также остальные файлы `reports/TASKS_BLOCK/` (BFT.md, TZ.md, mockups.html, specs/ — материалы координатора).

## Соответствие критериям приёмки (TZ §6)
| AC | Статус | Тест |
|---|---|---|
| AC-1 (API-часть) admin создаёт/правит/закрывает/переоткрывает; supervisor/viewer → 403 | выполнено | H2, H3, H4, H6, H7, H9 |
| AC-3 срок через выходной/праздник/отпуск сохраняется; через sick/trip → 422 + suggested_start | выполнено | F1, F2, F3, R2, R3 |
| AC-4 больничный поверх задачи не блокируется, задача получает conflict | выполнено (запись через реальный `entries.php`) | F5 |
| AC-5 PUT со старым version → 409, данные не затёрты | выполнено | H8 |
| AC-7 audit_log содержит все мутации | выполнено | H4, H6, H9, H10, H12 |
| AC-8 (основа) n8n недоступен → pending | только точка расширения, юнит-тест | R6 |
| AC-2, AC-6 (e2e), AC-9 | вне T1-1 (UI / n8n / LLM) | — |

Покрытие требований 2–6: RBAC-матрица anon/supervisor/viewer/admin (H1–H3, C1), эндпойнты (H4–H11), вычисляемые поля (F3, F5, H11), FR-10 (F1–F4, R2–R4), calendar_facts (C1–C3), приватность/version/audit (P1, H8, H12).
Проверка чувствительности: временная подмена `require_admin()` → `require_edit()` ломала H2 и H12 (тесты не «зелёные впустую»); изменение возвращено.

## Проверка — фактический вывод

### `bash scripts/verify_all.sh` (rc=0)
```
verify_all: fddc477 2026-11-07 02:07:18 suites: smoke tasks e51 e52 hygiene trips syntax phplint pii

SUITE    RES  PASSED EXPECT   TIME  NOTE
smoke    PASS     84     84    21s  
tasks    PASS     33     33     2s  
e51      PASS     23     23     3s  
e52      PASS     41     41     0s  
hygiene  PASS     19     19     0s  
trips    PASS      7      7     4s  
syntax   PASS      -      -     0s  
phplint  PASS     32      -     2s  
pii      PASS      -      -     0s  
clean    PASS

GATE: PASS (9 suites)
```
Базовый прогон до правок (clock-in): `GATE: PASS (8 suites)`, smoke 84, e51 23, e52 41, hygiene 19, trips 7, phplint 29.

### `php api/tasks_test.php` (rc=0), итог
```
=== RESULTS: 33 passed, 0 failed out of 33 ===
DB intact: YES
```
Полный построчный вывод (33 строки PASS) воспроизводится командой `php api/tasks_test.php`.

## Риски / замечания
- Контракт ответов (snake_case, `assignees`/`watchers` как массивы `{employee_id, full_name}`, `checklist[]`) выбран мной по TZ §2 — T1-2/T1-3 (UI) должны опираться на него; зафиксирован в шапке `api/tasks.php`.
- Список ограничен 2000 строк; для каждой задачи считаются факты/пометки (≈2 запроса + дни). При ~50 сотрудниках/недельном окне (R-4) нагрузка небольшая; при больших диапазонах стоит добавить батч-запрос фактов.
- Тестовый сьют требует учётки `admin`, `supervisor_zone0`, `viewer_test` с паролем `changeme` в закоммиченной dev-БД (как и smoke).
- Сервисный токен dev-БД (`external_api_token`) лежит в закоммиченном `data/app.db`; в ходе работы я однажды случайно вывел его в терминал при осмотре meta (dev-токен, уже находящийся в репозитории). В отчёты/код/логи он не попал; на проде токен свой.
- Режим push/деплой: не выполнялись (правило: push — только координатор, деплой — только по команде «Деплой»).
