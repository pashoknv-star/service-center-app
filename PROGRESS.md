# PROGRESS — service-center-app

Короткий файл состояния. Читать **первым** в начале сессии (clock-in), обновлять в конце (clock-out).
Где что лежит (у каждого факта один источник):
- живые статусы задач — Hermes Kanban (`hermes kanban list`);
- выполнение этапов — Роадмап `staff_project/Roadmap доработок (обновлён).xlsx`, только после одобрения владельца;
- контекст и подводные камни — `reports/HANDOFF.md`;
- отложенные работы — `reports/BACKLOG.md`.

## Current State

- Last commit: см. `git log --grep "T1-3"` (T1-3, 2026-11-07, поверх `6aadaee`); `c0ce47c` — последний прод-релевантный коммит (main = origin/main, push делает координатор).
- Прод: HOTFIX-H0 выложен (коммит `4cf6f27`), анонимная матрица OK — `reports/HOTFIX_H0/DEPLOY_REPORT.md`.
- Gate: `bash scripts/verify_all.sh` → `GATE: PASS (11 suites)` на T1-3, 2026-11-07 (smoke 84, tasks 33, tasksui 63, tasksmx 70, e51 23, e52 41, hygiene 19, trips 7, syntax, phplint 32 файла, pii, clean).
- Блок «Задачи» (T1-1, backend): схема v9 (`tasks`, `task_assignees`, `task_checklist`), `api/tasks.php`, `api/tasks_rules.php`, сьют `api/tasks_test.php` (на временной копии БД). Отчёт: `reports/TASKS_BLOCK/T1-1_REPORT.md`. В ТЗ значилось «v7», но v7/v8 уже заняты E12 → фактически v9.
- Блок «Задачи» (T1-2, frontend): `js/tasks.js` (панель Список/Доска/Календарь, вкладка «Задачи» в панели отпусков, `window.Tasks.*`, `window.openTasksPanel({employeeId,date,view})` для T1-3), точечные вставки в `index.html` (вкладка, контейнер, `<script>`), сьют `scripts/test_tasks_frontend.js` (63, сьют `tasksui` в verify_all). Отчёт: `reports/TASKS_BLOCK/T1-2_REPORT.md`. В реальном браузере не просматривалось (headless-браузера на хосте нет).
- Блок «Задачи» (T1-3, frontend): `js/tasks_matrix.js` (иконка варианта B со счётчиком на первом дне открытой задачи + рамка всего срока в матрице отпусков, клик → `openTasksPanel({employeeId,date,view:'calendar'})`, один `GET api/tasks.php?from&to` на год с кешем, обновление по событию `tasks:changed` из `js/tasks.js`), 1 строка в `index.html` (стр. 2178), сьют `scripts/test_tasks_matrix.js` (70, сьют `tasksmx`). Отчёт: `reports/TASKS_BLOCK/T1-3_REPORT.md` (там же замеры 50×365 в реальном Chromium и список непроверенного: touch-скролл). Также исправлен `settle()` в харнессе tasksui (на HEAD падал под нагрузкой хоста).
- Test status на `c0ce47c` (прогон 2026-11-02, Hermes):

| Сьют | Команда | Результат |
|---|---|---|
| Backend smoke | `php api/smoke_test.php` | PASS 84/84, DB intact |
| Задачи (T1-1) | `php api/tasks_test.php` | PASS 33/33, DB intact (на копии БД) |
| Задачи UI (T1-2) | `node scripts/test_tasks_frontend.js` | PASS 63/63 (e2e по реальному API на копии БД) |
| Задачи матрица (T1-3) | `node scripts/test_tasks_matrix.js` | PASS 70/70 (шим + e2e по реальному API на копии БД) |
| e51 | `node scripts/test_e51_pick_geometry.js` | PASS 23/23 |
| e52 | `node scripts/test_e52_pick_semantics.js` | PASS 41/41 |
| hygiene | `node scripts/test_r4_hygiene.js` | PASS 19/19 |
| trips frontend | `bash scripts/test_trips_frontend.sh` | PASS (ALL TESTS PASSED) |
| Синтаксис inline-JS | `node scripts/check_syntax.js` | OK, failed 0 |
| ПДн | `bash scripts/check_no_pii.sh` | OK |
| E2E | `/tmp/e5_final.js`, `/tmp/e6_final.js` | **НЕ ЗАПУСКАЛСЯ: файлов нет на хосте** |

## In Progress

- Активных задач нет: `hermes kanban list` → no matching tasks (2026-11-02).
- В рабочем дереве есть незакоммиченные правки `reports/BACKLOG.md` и `reports/backlog/` (BL-01, BL-02: карточки Kanban сняты, вместо них файлы). Автор и судьба не зафиксированы — уточнить у владельца.

## Next Steps

1. Фаза H1 (P1) — `reports/AUDIT_2026-10/AUDIT_REPORT.md` §9; заводится в Kanban по команде «Старт».
2. Вернуть E2E-харнесс в репозиторий (`scripts/`): он жил в `/tmp` и потерян.
3. `scripts/test_trips_frontend.sh` при ручном запуске оставляет в корне `test_cookies.jar` (`verify_all.sh` удаляет его сам).

## Blockers / ждёт владельца

- Проверка прода под логином: вход, сохранение, reveal токена, фото (`DEPLOY_REPORT.md`, «Не проверено»).
- Смена токена робота HelpMe и SSH-пароля Hostland (`DEPLOY_REPORT.md`, строка 32) — статус неизвестен.
- Удаление бандлов с ПДн в `~/backups/` (`HANDOFF.md` §6).
