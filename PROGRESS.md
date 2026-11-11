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
- Блок «Задачи» (T1-4, n8n): push-модель (n8n сам приложение не вызывает). Активны workflow `tasks-validate` и `tasks-recheck` (webhook + header-auth `X-Tasks-Secret`; экспорты `n8n/*.json`, исходники логики `n8n/code/*.js`, выкладка `scripts/n8n_deploy.py`). Приложение (`api/tasks_rules.php`: `tasks_check_period_checked`, `tasks_recheck_pending`; `api/tasks.php`) зовёт validate с таймаутом 3 с, при недоступности — PHP-fallback + `check_state='pending'`, перепроверка pending раз в 15 мин при чтении списка. Конфиг — окружение: `TASKS_VALIDATE_WEBHOOK_URL`, `TASKS_RECHECK_WEBHOOK_URL`, `TASKS_N8N_WEBHOOK_SECRET` (без них — чистый PHP). Сьют `tasksn8n` 20/20 на mock-webhook (в gate); сверка с реальным n8n — `scripts/n8n_compare.php` (расхождений 0), `scripts/n8n_e2e_live.php` (вне gate, нужна сеть). Отчёт: `reports/TASKS_BLOCK/T1-4_REPORT.md`. Gate T1-4, 2026-11-09: `GATE: PASS (12 suites)`.
- Блок «Задачи» (T1-6, независимая приёмка T1, 2026-11-10, sd_worker_01, на `361dffd`): AC-1..AC-8 PASS (AC-9 вне фазы, BL-04); `GATE: PASS (12 suites)`; e2e в реальном Chromium, RBAC curl, n8n vs PHP на независимых кейсах (0 расхождений), секретов в репо нет. Дефекты: P2 ×1 (каскадное удаление исполнителей при удалении сотрудника), P3 ×5 (AGENTS BASELINE, orphan `php -S` из `smoke_test.php:206`, латентность n8n, DEPLOY_HOSTLAND не обновлён, вес списка). Отчёт: `reports/TASKS_BLOCK/T1-6_ACCEPTANCE.md`. Роадмап не отмечался (нужно одобрение владельца).
- Блок «Задачи» (T1-9, D-4 + D-5, 2026-11-10, sd_worker_04): таймауты n8n — validate 3 с (`TASKS_N8N_TIMEOUT_MS`), recheck 10 с (`TASKS_N8N_RECHECK_TIMEOUT_MS`, параметр `$timeoutMs` у `tasks_recheck_pending`); длительность каждого вызова меряется, аномалия > 10 с → `error_log` `tasks n8n ANOMALY workflow=… ms=… reason=…`, таймаут validate → `tasks n8n timeout …` (штатно, без ANOMALY). Сьют `tasksn8n` 20 → 25 (BASELINE и AGENTS обновлены). `DEPLOY_HOSTLAND.md` (вариант A): тесты исключаются шаблоном `_test\.php$`, запрещённое в пакете +`_test\.php$`/`^n8n/`, `rm -f api/*_test.php`, список js (автоматический), веб-проверки tasks.php 401 / тесты 403|404, §12 «n8n на проде: TASKS_* не задаются». Сборка выполнена локально в scratch, `tar -tzf` в отчёте: `reports/TASKS_BLOCK/T1-9_REPORT.md`. Gate: `GATE: PASS (12 suites)` (smoke 84, tasks 33, tasksn8n 25, tasksui 63, tasksmx 70, e51 23, e52 41, hygiene 19, trips 7, phplint 33). Не деплоилось, не пушилось.
- Блок «Задачи» (T1-7, D-1 backend, 2026-11-11, sd_worker_02): задача остаётся при удалении сотрудника. Схема v10 (`task_assignees` без FK на `employees` + `full_name_snapshot`, миграция `rebuildTaskAssigneesV10` в `api/db.php`, идемпотентна), `api/tasks.php`: `assignees[].removed/removed_at`, `orphan`, `GET ?orphans=1`, `GET ?open_for=<id>`, правила PUT (переназначение = замена удалённого, `employee_not_found`, FR-10 422), snapshot при назначении/переименовании (`employees.php`, `save.php`), `import.php` освежает snapshot; `employee.delete` в аудите несёт `open_tasks` (оба пути). Сьюты: `tasks` 33 → 46, `tasksmx` 70 → 71 (BASELINE и AGENTS обновлены). Контракт для T1-8: `reports/TASKS_BLOCK/T1-7_REPORT.md`. Gate: `GATE: PASS (12 suites)` (smoke 84, tasks 46, tasksn8n 25, tasksui 63, tasksmx 71, e51 23, e52 41, hygiene 19, trips 7, phplint 33). Не деплоилось, не пушилось; миграция на прод — с бэкапом `data/app.db`.
- Блок «Задачи» (T1-8, D-1 UI, 2026-11-11, sd_worker_03): «Исполнитель удалён» в `js/tasks.js` — счётчик `⚠ N` на вкладке (`?orphans=1`), плашка и оранжевая полоса в Списке + пункт фильтра «Без исполнителя», секция Доски, пунктирная плитка Календаря, блок в карточке с «Назначить» (admin), зачёркнутый удалённый у задач с 2 исполнителями, закрытые без пометок; `removed_at`/ФИО = null без «null». Окно замены: `Tasks.openTasksFor` (до confirm, сбой не блокирует удаление) и `Tasks.offerReassign` (после `await save()`), PUT с `version`, 422 → «Принять предложенную дату», 409 → перечитать и повторить один раз, «Позже» → задачи остаются в ⚠; supervisor/viewer — без «Назначить» и окна. В `index.html` изменён только обработчик `#deleteEmp`. Форма правки не отправляет удалённых исполнителей. `tasksui` 63 → 117 (BASELINE и AGENTS обновлены); проверено в реальном Chromium (скриншоты `reports/TASKS_BLOCK/T1-8_screens/`). Отчёт: `reports/TASKS_BLOCK/T1-8_REPORT.md`. Gate: `GATE: PASS (12 suites)` (smoke 84, tasks 46, tasksn8n 25, tasksui 117, tasksmx 71, e51 23, e52 41, hygiene 19, trips 7, phplint 33). Не деплоилось, не пушилось.
- Блок «Задачи» (T1-10, независимая приёмка D-1/D-4/D-5, 2026-11-11, sd_worker_01, на `1a52432`): FAIL нет; P0/P1/P2 — 0, P3 — 4 (окно замены не обновляет строку после accept/409, тост при частичном успехе, Доска без зачёркивания co-исполнителя, счётчик/список не обновляются синком), 3 наблюдения вне T1 (E10-6 молча отбрасывает удаление в первые ~20 с после загрузки; viewer 403 на save.php — как на `eb2bcbc`). Миграция v10 проверена на БД v9 с задачами (данные/snapshot, идемпотентность), D-1 backend 51/51, реальный Chromium (нативный confirm, окно, 375px, Esc/«Позже», 422/409, роли), D-4 на mock (3 с pending, 10 с + ANOMALY), D-5 сборка по DEPLOY_HOSTLAND в scratch. Отчёт: `reports/TASKS_BLOCK/T1-10_ACCEPTANCE.md`, скриншоты `reports/TASKS_BLOCK/T1-10_screens/`. Gate `GATE: PASS (12 suites)`.
- Блок «Задачи» (T1-11, исправление P3-1…P3-4 из T1-10, 2026-11-11, sd_worker_03): `js/tasks.js` — строка окна замены берётся из ответа сервера (P3-1), тост «Переназначено N из M; остальные — см. окно» при частичном успехе (P3-2), зачёркивание удалённого исполнителя в карточке Доски (P3-3), новый `window.Tasks.onRemoteChange()` — счётчик ⚠ + тихое обновление открытого списка без сброса фильтра/выбора/окна/формы (P3-4); `index.html` — одна вставка в `poll()` (условие `changed или employeesDeleted`: отклонение от ТЗ, см. отчёт — удаление сотрудника без записей матрицы не даёт `changed`). tasksui 135, реальный браузер (2 окна, ≤12 с до обновления). N-1 (BL-06) не тронут. Отчёт: `reports/TASKS_BLOCK/T1-11_REPORT.md`, скрины `T1-11_screens/`. Gate: `GATE: PASS (12 suites)` (smoke 84, tasks 46, tasksn8n 25, tasksui 135, tasksmx 71, e51 23, e52 41, hygiene 19, trips 7, syntax, phplint 33, pii, clean).
- Test status на `c0ce47c` (прогон 2026-11-02, Hermes):

| Сьют | Команда | Результат |
|---|---|---|
| Backend smoke | `php api/smoke_test.php` | PASS 84/84, DB intact |
| Задачи (T1-1, T1-7) | `php api/tasks_test.php` | PASS 46/46, DB intact (на копии БД) |
| Задачи UI (T1-2, T1-8, T1-11) | `node scripts/test_tasks_frontend.js` | PASS 135/135 (e2e по реальному API на копии БД) |
| Задачи матрица (T1-3) | `node scripts/test_tasks_matrix.js` | PASS 71/71 (шим + e2e по реальному API на копии БД) |
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
