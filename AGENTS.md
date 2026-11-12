# AGENTS.md — Project Runtime Instructions

## Scope

These instructions apply to this project. Keep them operational and concise; durable historical knowledge belongs in the Wiki.

## Роадмап доработок: фиксация выполнения

- ТРИГГЕР: явное одобрение владельцем (Pavel) исправлений/результатов работы — например, «исправления приняты».
- ДЕЙСТВИЕ: после одобрения обновить Роадмап доработок — файл `staff_project/Roadmap доработок (обновлён).xlsx` (openpyxl, `/home/hermes/.venv/bin/python3`): отметить статус этапа «выполнен», проставить дату и краткий результат.
- ЦЕЛЬ: фиксация выполнения задач проекта; роадмап — актуальный источник правды о прогрессе.
- БЕЗ одобрения владельца этап в роадмапе НЕ помечается выполненным — даже если деплой уже сделан.

## Build

- Локальный сервер: `php -S 127.0.0.1:8090 router.php` из корня проекта.
- Прод-пакет и порядок выкладки: см. `DEPLOY_HOSTLAND.md` (раздел 4 — обновление кода, никогда не перезаписывать `data/app.db`).

## Session lifecycle (clock-in / clock-out)

- **Clock-in, до правок кода:** прочитать `PROGRESS.md` (текущее состояние), при необходимости `reports/HANDOFF.md` (контекст). Прогнать релевантные сьюты из раздела Verification и убедиться, что базовое состояние зелёное. Если нет — сначала сообщить, а не чинить молча.
- **Clock-out, перед сообщением «готово»:**
  1. `bash scripts/verify_all.sh` → `GATE: PASS` (скрипт сам откатывает `data/app.db`, удаляет `test_cookies.jar` и падает, если после прогона в дереве появились новые изменения);
  2. `git status --porcelain` — только файлы задачи;
  3. обновить раздел Current State в `PROGRESS.md` (коммит и фактические результаты тестов);
  4. закоммитить.

## Verification (Definition of Done)

- **Одна команда:** `bash scripts/verify_all.sh` (все сьюты) или `bash scripts/verify_all.sh e51 e52` (выборочно). Exit 0 и строка `GATE: PASS` — gate пройден; exit 1 — провал; exit 2 — прогон не начат (например, незакоммиченная `data/app.db`). В квитанцию и ревью прикладывать итоговую таблицу скрипта целиком.
- Задача или фаза считается выполненной **только** при зелёном прогоне: код выхода 0 и итоговая строка без падений (`RESULTS: N passed, 0 failed`, `RESULT: N passed, 0 failed`, `ALL TESTS PASSED`, `OK`). Без вывода прогона статус done / «готово» не ставится, Kanban-задача не закрывается.
- Во время итераций — только релевантный сьют (см. ниже). Перед закрытием фазы и перед деплоем — **все** сьюты из таблицы.
- Эталон числа тестов — массив `BASELINE` в `scripts/verify_all.sh` (единственный источник; на 2026-11-13 (V6-1..V6-5): smoke 84, e51 23, e52 41, hygiene 19, trips 7, tasks 47, tasksn8n 25, tasksui 194, tasksmx 71, taskscal 112, director 70). Тестов меньше эталона — FAIL. Добавили тесты — поднять `BASELINE` в том же коммите.
- Ручные команды по сьютам (для отладки одного падения):

| Сьют | Команда | Критерий |
|---|---|---|
| Backend smoke | `php api/smoke_test.php` | `RESULTS: N passed, 0 failed`, `DB intact: YES` |
| e51 | `node scripts/test_e51_pick_geometry.js` | `0 failed` |
| e52 | `node scripts/test_e52_pick_semantics.js` | `0 failed` |
| hygiene | `node scripts/test_r4_hygiene.js` | `0 failed` |
| trips frontend | `bash scripts/test_trips_frontend.sh` | `ALL TESTS PASSED` |
| Синтаксис | `node scripts/check_syntax.js`, `php -l api/<file>.php` | `failed: 0` |
| ПДн | `bash scripts/check_no_pii.sh` | `OK` |

## Test

- Smoke-набор: `php api/smoke_test.php` из корня проекта (локально, PHP 8.3; на хостинге CLI PHP 5.3 — запускать нельзя). Критерий приёмки: 100% pass.
- Синтаксис: `php -l api/<file>.php`, `node --check js/storage.js`.

### JS-сьюты (frontend) [05.09.2026; 18:08]

Сьюты запускаются ЦЕЛИКОМ одной командой. НЕ разбивать прогон на отдельные вызовы по одному тесту.

- e51 (геометрия пик-панели): `node scripts/test_e51_pick_geometry.js`
- e52 (семантика выбора): `node scripts/test_e52_pick_semantics.js`
- hygiene: `node scripts/test_r4_hygiene.js`
- trips frontend: `bash scripts/test_trips_frontend.sh`
- E2E-харнесс: `/tmp/e5_final.js` (или актуальный `/tmp/e6_final.js`) через headless Chrome CDP. **На 2026-11-02 этих файлов на хосте нет** (`/tmp` очищен) — E2E в gate не входит до возврата харнесса в `scripts/`.
- Backend smoke: `php api/smoke_test.php`

После smoke обязательно возвращать dev-БД: `git checkout -- data/app.db`.

После patch — гонять только релевантный сьют, а не все пять, если изменения локальны (например, только e51 при правке геометрии пик-панели).

### Codebase navigation (CODEMAP) [05.09.2026; 18:08]

Файлы большие (index.html ~3000+ строк, js/trips.js, js/vacations.js) и без IDE-индекса:

1. В начале задачи, если CODEMAP.md устарел (правки после последнего обновления) — перегенерировать одним вызовом: `rg --json -n "function |const .*=.*=>" index.html js/trips.js js/vacations.js` (результат сохранить в CODEMAP.md).
2. CODEMAP.md — первичный источник номеров строк/функций; не грепать «вслепую» повторно.
3. После patch — обновлять релевантную секцию CODEMAP.md, если менялась сигнатура/расположение функции.

### Iteration limit checkpoint [05.09.2026; 18:08]

Если приближаетесь к пределу ходов в рамках turn — НЕ пытаться «успеть доделать всё»: зафиксировать текущий прогресс в todo/progress-файле и явно сообщить, какие пункты остались, вместо того чтобы упереться в hard limit без deliverable.

## Phase & deploy control [2026-08-30, owner-confirmed]

- Деплой на Hostland — ТОЛЬКО по явной команде «Деплой» (механика: `DEPLOY_HOSTLAND.md`).
- Управление фазами: после каждой фазы — полная остановка работы; следующая фаза только по команде «Старт» от Pavel. Правило авто-паузы 300с отменено владельцем.
- Push в `main` после КАЖДОЙ принятой фазы (правило от 2026-08-30: T3–E6 были найдены незапушенными).

## Repository rules

- Защищённые файлы/каталоги: `data/app.db` (живые данные), `static/`, корневой `.htaccess`, `staff_project/` (исходные материалы заказчика).
- Прод: изменения только через бэкап → выкладка изменённых файлов → веб-проверки (grep-маркеры + анонимные HTTP-коды).

## Security and side effects

- SSH-пароль хостинга передаётся владельцем в чате; после деплоя напомнить о смене пароля.
- Стартовые пароли учёток (`changeme`) — только в dev-БД; прод-пароли у владельца.

## Решения владельца 2026-10-26 (после аудита AUDIT-2026-10)

- **ПДн в репозитории запрещены.** Реальные ФИО, телефоны, фото, графики сотрудников в git не коммитятся; dev-данные — только синтетические. История переписана 2026-10-26, SHA сменились (`reports/GIT_REWRITE_2026-10-26.md`). Клоны, сделанные до этой даты, не пушить. После HOTFIX-H0 перед коммитом и сборкой прод-пакета выполнять `bash scripts/check_no_pii.sh`.
- **HTTP намеренно (этап тестирования).** Let's Encrypt на Hostland доступен; переход на HTTPS — позже по команде владельца (бэклог BL-02, `reports/BACKLOG.md`). TLS не предлагать как срочное.
- **Командировки отложены.** Сущность пока не применяется в бизнесе: починка формы и долг relay/trips — бэклог BL-01. Безопасность эндпоинтов `trips.php`/`trip_relay.php` при этом закрывается в общих фазах.
- **Юридические вопросы (152-ФЗ) отложены.** Не поднимать и не включать в планы до команды владельца; архив — `reports/AUDIT_2026-10/DEFERRED_LEGAL_152FZ.md`.
- Текущий план: `reports/HOTFIX_H0/PLAN.md` (запуск по «Старт»). Точка входа для новой сессии: `reports/HANDOFF.md`.

## Source of truth

When instructions conflict, inspect the repository and current project configuration; do not use Wiki history to override actual code state.
