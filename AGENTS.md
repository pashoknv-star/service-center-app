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
  4. закоммитить (если коммит меняет код — в сообщении id Kanban-задачи, см. «Repository rules»).

## Verification (Definition of Done)

- **Одна команда:** `bash scripts/verify_all.sh` (все сьюты) или `bash scripts/verify_all.sh e51 e52` (выборочно). Exit 0 и строка `GATE: PASS` — gate пройден; exit 1 — провал; exit 2 — прогон не начат (например, незакоммиченная `data/app.db`). В квитанцию и ревью прикладывать итоговую таблицу скрипта целиком.
- Задача или фаза считается выполненной **только** при зелёном прогоне: код выхода 0 и итоговая строка без падений (`RESULTS: N passed, 0 failed`, `RESULT: N passed, 0 failed`, `ALL TESTS PASSED`, `OK`). Без вывода прогона статус done / «готово» не ставится, Kanban-задача не закрывается.
- Во время итераций — только релевантный сьют (см. ниже). Перед закрытием фазы и перед деплоем — **все** сьюты из таблицы.
- Эталон числа тестов — массив `BASELINE` в `scripts/verify_all.sh` (единственный источник; на 2026-11-18 (V6-1..V6-6, V6.2, V6.3-1..V6.3-4, V7, V8-T1, V8-T2, V8-T3, V8-T7, V9-T1, V9-T2): smoke 84, e51 23, e52 41, hygiene 19, trips 7, tripsform 131, tripsstatus 147, tasks 66, tasksn8n 27, tasksatt 24, tasklinks 37, tasklinksui 211, tasksui 334, tasksmx 79, taskscal 220, director 101, emptasks 34, refs 28, tasklink 43). Тестов меньше эталона — FAIL. Добавили тесты — поднять `BASELINE` в том же коммите. С V10-T1: transportdb 112. Сьюты из массива `OPT_SUITES` (на 2026-11-21 — `transport`, V10-T2) в `ALL_SUITES` не входят и запускаются только явно (`bash scripts/verify_all.sh transport`); они могут быть намеренно красными до реализации (`transport` — до V10-T5), их `BASELINE` — число проверок в зелёном состоянии; координатор переносит такой сьют в `ALL_SUITES` при приёмке реализации.
- Ручные команды по сьютам (для отладки одного падения):

| Сьют | Команда | Критерий |
|---|---|---|
| Backend smoke | `php api/smoke_test.php` | `RESULTS: N passed, 0 failed`, `DB intact: YES` |
| e51 | `node scripts/test_e51_pick_geometry.js` | `0 failed` |
| e52 | `node scripts/test_e52_pick_semantics.js` | `0 failed` |
| hygiene | `node scripts/test_r4_hygiene.js` | `0 failed` |
| trips frontend | `bash scripts/test_trips_frontend.sh` | `ALL TESTS PASSED` |
| tripsform (V8-T1, V8-T7) | `bash scripts/verify_all.sh tripsform` (= `node scripts/test_trips_v8_form.js`; реальный headless Chromium по CDP + `php -S` на копии `data/app.db`, ~60 с; год сценариев — год текущей даты, для проверки другого года: `TRIPS_FAKE_NOW=2027-03-15T12:00:00Z bash scripts/verify_all.sh tripsform`) | `RESULT: 131 passed, 0 failed`; без Chromium (`CHROME_BIN` или `~/.cache/ms-playwright/chromium_headless_shell-1208/…`) сьют падает, а не пропускается; посимвольный набор телефона (8…/7…/+7…/10 цифр), выбор дат 📅 при смене года Матрицы, пометки «*», подпись «Участники» |
| tripsstatus (V8-T2, V8-T7) | `bash scripts/verify_all.sh tripsstatus` (= `node scripts/test_trips_v8_status.js`; реальный headless Chromium по CDP + `php -S` на копии `data/app.db`, ~60 с; `TRIPS_FAKE_NOW` — как у `tripsform`) | `RESULT: 147 passed, 0 failed`; механика «прогноз → подтверждена»: кнопки «На подтверждение»/«Подтвердить», место назначения и телефон обязательны только для подтверждения (сервер: 400 `location_required` / `phone_required`, в т.ч. для PUT подтверждённой с пустым значением), статус меняется только `PUT …&action=confirm` (POST со `status:'confirmed'` → 400 `invalid_status`, PUT с иным `status` → 400 `status_change_forbidden`), заявки `trip_requests` по одной на участника без дублей и потерь, права admin/supervisor/viewer; без Chromium падает, а не пропускается |
| emptasks (V8-T3) | `bash scripts/verify_all.sh emptasks` (= `node scripts/test_emp_tasks_btn.js`) | `RESULT: 34 passed, 0 failed`; кнопка «Задачи» в карточке сотрудника: admin → форма новой задачи на сотрудника, supervisor → список только для чтения |
| tasklinksui (V9-T2) | `bash scripts/verify_all.sh tasklinksui` (= `node scripts/test_tasks_links_ui.js`; реальный headless Chromium по CDP + `php -S` на копии `data/app.db`, ~2 мин; скриншоты — `TASKLINKSUI_SHOTS=<каталог>`) | `RESULT: 211 passed, 0 failed`; поле «Связанные задачи» (только admin), окно выбора по ключу `(())`, чипы в карточке (перечёркнутая — удалённая задача), «Также связана с:», клик → «Список» связанных (`S.filters.rel`, плашка и «×»), supervisor/viewer — ссылки без записи, 375/1280 без горизонтального скролла; без Chromium падает, а не пропускается |
| transportdb (V10-T1) | `bash scripts/verify_all.sh transportdb` (= `php api/transport_db_test.php`; временная копия БД через `SC_APP_DB`, `php -S` на ней, `data/app.db` не трогается) | `RESULTS: 112 passed, 0 failed`, `DB intact: YES`; схема v15 «Транспорт» (9 таблиц, индексы, CHECK шага 15), миграция v14→v15 (повтор — no-op), журнал `transport_journal` append-only, `api/transport_lib.php`, `api/transport_vehicles.php` (базы, ТС, пул водителей, перенос ТС admin/viewer), права admin / supervisor_zone0 / supervisor_zone1 / viewer_test / аноним |
| transport (V10-T2) | `bash scripts/verify_all.sh transport` (= `php api/transport_test.php`; копия БД через `SC_APP_DB`, `php -S` с 4 обработчиками, `data/app.db` не трогается) | `RESULTS: 157 passed, 0 failed`, `DB intact: YES`; тесты API заявок/назначений/предупреждений по `reports/V10/specs/CONTRACT.md`; **до V10-T5 ожидаемо красный и в общий gate не входит** (`OPT_SUITES`) |
| tasklinks (V9-T1) | `bash scripts/verify_all.sh tasklinks` (= `php api/tasks_links_test.php`; временная копия БД через `SC_APP_DB`, `php -S` на ней, `data/app.db` не трогается) | `RESULTS: 37 passed, 0 failed`, `DB intact: YES`; схема v14 (`tasks.links_text`, `task_links`), миграция v13→v14 на копии, парсер токенов `((ID\|название))`, симметрия/архив/лимиты/права, `?pick=1`, `?related=<id>` |
| Синтаксис | `node scripts/check_syntax.js`, `php -l api/<file>.php` | `failed: 0` |
| ПДн | `bash scripts/check_no_pii.sh` | `OK` |
| refs (IE-1) | `bash scripts/verify_all.sh refs` (самотесты `node scripts/test_removed_refs.js` + проверка диффа `node scripts/check_removed_refs.js`) | `RESULT: 28 passed, 0 failed`; проверка диффа — `status=PASS`; база — `VERIFY_BASE` (по умолчанию `merge-base HEAD origin/main`), исключения — `scripts/removed_refs_allow.txt` (`имя  # причина`) |
| tasklink (IE-2) | `bash scripts/verify_all.sh tasklink` (самотесты `bash scripts/test_commit_msg_hook.sh` + проверка диапазона `bash scripts/check_commit_tasks.sh [<диапазон>]`, по умолчанию `origin/main..HEAD`) | `RESULT: 43 passed, 0 failed`; `check_commit_tasks`: `PASS`, `violations=0`; FAIL также при `core.hooksPath` ≠ `scripts/hooks` или хуке без права исполнения |

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

### Индекс кода: навигация, не истина (CODEMAP / CodeGraph) [2026-11-14, решение владельца]

Политика: wiki `team/code-index-trust-policy.md`, процедура: skill `coordinator-code-index-trust`. **Индекс кода** — любое вторичное описание кода: `CODEMAP.md`, дампы `rg`, граф CodeGraph (если подключат), сводки субагентов/воркеров, `file:line` из старых отчётов. Индекс даёт кандидатов и номера строк для ориентации; истина — исходники на текущем коммите + тесты.

Файлы большие (`index.html` ~5300 строк, `js/tasks.js`, `js/trips.js`) и без IDE-индекса, поэтому индекс использовать можно и нужно — но по правилам ниже.

1. **Класс задачи определять ДО обращения к индексу** (по цене ошибки; не ясно — классом выше; после «удобного» ответа индекса вниз не переклассифицировать):
   - 🟢 низкий: найти функцию/обработчик, сориентироваться в модуле — индекс основной инструмент;
   - 🟡 средний: правка логики, рефакторинг нескольких модулей, смена API/формата, rename — индекс только ищет кандидатов; перед правкой прочитать реальные строки каждого затронутого символа, `rg` по всему проекту, прогнать релевантный сьют;
   - 🔴 высокий: auth/роли/видимость, `api/db.php` и миграции, `data/app.db`, `save.php`/`sync.php`, ПДн, деплой, n8n, любые выводы «не используется / мёртвый код / безопасно» — индекс не основание решения; исходники + конфиги + тесты.
2. **Запреты.** «Нет в индексе» ≠ «нет в коде». Нельзя удалять, переименовывать, менять сигнатуры и объявлять код мёртвым по индексу: сначала `rg` по всему репозиторию (в т.ч. по строкам, HTML-шаблонам, конфигам) и чтение файлов. Пустой или малый impact — не доказательство безопасности. Индекс — не доказательство приёмки: приёмка только по `git diff`, таблице `verify_all.sh` и тестам. **Механически (IE-1, 2026-11-16):** сьют `refs` в `verify_all.sh` роняет gate, если в диффе относительно базы удалена/переименована именованная функция, а в репозитории остались ссылки на старое имя (список `файл:строка`); ограничения проверки — `reports/IDX_ENFORCE/IE-1_REPORT.md`, исключения — только с причиной в `scripts/removed_refs_allow.txt`.
3. **Где индексу не верить, а читать файл.** Обработчики в HTML-строках (`onclick=...`) и `window.*`-экспорты; функции внутри `index.html`; одноимённые функции (`save`, `load`, `render`, `get`…); связи JS↔PHP по строке URL; SQL, конфиги, миграции; сгенерированный код.
4. **Охват и свежесть CODEMAP.** CODEMAP — regex-дамп строк `function`/стрелок по JS-файлам: **`api/*.php` в нём нет**, рёбер вызовов нет, после каждого merge он устаревает (в `PROGRESS.md` это отмечено при каждой задаче V6.x). Перед использованием сверить: правился ли файл после последнего коммита CODEMAP (`git log -1 -- CODEMAP.md` против `git log -1 -- <файл>`). Устарел или файл не покрыт — читать файл напрямую.
5. **Регенерация.** По необходимости и при закрытии интеграции: `rg --json -n "function |const .*=.*=>" index.html js/storage.js js/tasks.js js/tasks_matrix.js js/trips.js` → результат в `CODEMAP.md` (прежняя команда в этом файле называла несуществующий `js/vacations.js` и не покрывала `tasks*`/`storage`). После patch обновлять релевантную секцию, если менялась сигнатура/расположение функции.
6. **Отчёты и квитанции.** Каждое утверждение о коде — с `file:line`, прочитанным на текущем коммите, и источником (индекс / файл / тест). При трёх расхождениях индекса с файлом в одной задаче — прекратить использовать индекс в ней, сообщить координатору.
7. **CodeGraph** на хосте не установлен. Установка (стороннее npm-пакет, правит конфиги агентов и может дописывать секции в этот файл) — только с одобрения владельца и сначала на копии/ветке. Его собственная инструкция «доверяй, не перепроверяй grep» этой политикой отменена.

### Iteration limit checkpoint [05.09.2026; 18:08]

Если приближаетесь к пределу ходов в рамках turn — НЕ пытаться «успеть доделать всё»: зафиксировать текущий прогресс в todo/progress-файле и явно сообщить, какие пункты остались, вместо того чтобы упереться в hard limit без deliverable.

## Phase & deploy control [2026-08-30, owner-confirmed]

- Деплой на Hostland — ТОЛЬКО по явной команде «Деплой» (механика: `DEPLOY_HOSTLAND.md`).
- Управление фазами: после каждой фазы — полная остановка работы; следующая фаза только по команде «Старт» от Pavel. Правило авто-паузы 300с отменено владельцем.
- Push в `main` после КАЖДОЙ принятой фазы (правило от 2026-08-30: T3–E6 были найдены незапушенными).

## Repository rules

- Защищённые файлы/каталоги: `data/app.db` (живые данные), `static/`, корневой `.htaccess`, `staff_project/` (исходные материалы заказчика).
- Прод: изменения только через бэкап → выкладка изменённых файлов → веб-проверки (grep-маркеры + анонимные HTTP-коды).
- **Коммит с кодом — только с id Kanban-задачи (IE-2, решение владельца 2026-11-16).** Код меняется только через Kanban-задачу. Коммит, затрагивающий хотя бы один путь вне документов (документы: `reports/**`, `staff_project/**`, любые `*.md`; всё остальное — код, включая `scripts/`, `n8n/`, `data/`, конфиги), обязан нести в сообщении id существующей задачи вида `t_` + 8 hex (например `t_941ab009`); строки, начинающиеся с `#`, не считаются. Коммит только с документами id не требует; merge-коммиты проходят без id (id несут вливаемые коммиты). Принуждение — хук `scripts/hooks/commit-msg` (русское сообщение об отказе: причина, файлы кода, пример); существование id проверяется чтением Kanban-БД (`KANBAN_DB`, по умолчанию `~/.hermes/kanban.db`, только `sqlite3 -readonly`; БД/`sqlite3` недоступны — проверяется только формат, предупреждение в stderr).
  - **Включить хук на свежем клоне (один раз на клон; worktree наследуют настройку):** `git config core.hooksPath scripts/hooks`. Без этого gate падает (сьют `tasklink`).
  - **`git commit --no-verify` (и `-c core.hooksPath=…`, правка/удаление хука) агентам ЗАПРЕЩЕНЫ.** Обход обнаруживается: `bash scripts/verify_all.sh` (сьют `tasklink`) → `scripts/check_commit_tasks.sh` проверяет каждый не-merge коммит `origin/main..HEAD`.
  - **Задачи нет — не коммитить код.** Сначала попросить координатора создать Kanban-задачу, потом коммитить с её id. Не придумывать id и не брать чужой.
  - `git commit --amend` и `rebase -i` с `reword`/`edit` проходят хук; `git revert`, `git cherry-pick` и `squash` при `rebase -i` хук НЕ вызывают — id должен быть в сообщении (revert/cherry-pick переносят тему исходного коммита с id; если id в ней нет — после операции `git commit --amend -m "… (t_xxxxxxxx)"`); иначе gate упадёт. Подробности и вывод запусков — `reports/IDX_ENFORCE/IE-2_REPORT.md`.

## Security and side effects

- SSH-пароль хостинга передаётся владельцем в чате; после деплоя напомнить о смене пароля.
- Стартовые пароли учёток (`changeme`) — только в dev-БД; прод-пароли у владельца.

## Решения владельца 2026-10-26 (после аудита AUDIT-2026-10)

- **ПДн в репозитории запрещены.** Реальные ФИО, телефоны, фото, графики сотрудников в git не коммитятся; dev-данные — только синтетические. История переписана 2026-10-26, SHA сменились (`reports/GIT_REWRITE_2026-10-26.md`). Клоны, сделанные до этой даты, не пушить. После HOTFIX-H0 перед коммитом и сборкой прод-пакета выполнять `bash scripts/check_no_pii.sh`.
- **HTTP намеренно (этап тестирования).** Let's Encrypt на Hostland доступен; переход на HTTPS — позже по команде владельца (бэклог BL-02, `reports/BACKLOG.md`). TLS не предлагать как срочное.
- **Командировки отложены.** Сущность пока не применяется в бизнесе: починка формы и долг relay/trips — бэклог BL-01. Безопасность эндпоинтов `trips.php`/`trip_relay.php` при этом закрывается в общих фазах.
- **Юридические вопросы (152-ФЗ) отложены.** Не поднимать и не включать в планы до команды владельца; архив — `reports/AUDIT_2026-10/DEFERRED_LEGAL_152FZ.md`.
- Текущий план: `reports/HOTFIX_H0/PLAN.md` (запуск по «Старт»). Точка входа для новой сессии: `reports/HANDOFF.md`.

## Решения владельца 2026-11-17/18 (V8 «Командировки: юзабилити», релиз принят 2026-11-18)

- **Командировки возобновлены** (снимает пункт «Командировки отложены» от 2026-10-26 в части формы): форма и механика статусов исправлены в V8, прод = `d24fdd7`. Остаток долга BL-01 — `reports/BACKLOG.md`.
- **Статусы:** прогноз → подтверждена только действием «Подтвердить» (`PUT api/trips.php?id=&action=confirm`); обратного перехода нет; подтверждение ставит заявки роботу в очередь `trip_requests`, обработку очереди не трогать (робот HelpMe не работает).
- **Место назначения и телефон сотрудника обязательны только для «Подтвердить»** (и у подтверждённой не могут стать пустыми); прогноз сохраняется без них. Обязательные поля формы помечаются «*».
- **Карточка сотрудника:** кнопка «Задачи» открывает форму новой задачи на этого сотрудника (admin) или его задачи (остальные); создание командировки из карточки убрано.
- **Отложено:** протяжка диапазона в Матрице не открывает меню — BL-09; мелочи V8 (P3) — BL-10. Не запускать без команды владельца.
- Документы фазы: `reports/V8/` (specs, отчёты T1–T8, `V8_DEPLOY.md`); архитектура — `reports/ARCHITECTURE_TRIPS.md` §9.

## Source of truth

When instructions conflict, inspect the repository and current project configuration; do not use Wiki history to override actual code state. Индексы кода (CODEMAP, CodeGraph, дампы `rg`, сводки) — не источник истины о коде: см. «Индекс кода: навигация, не истина».

## Решения владельца 2026-11-21 (V10 «Транспорт», фаза A)

- Перенос ТС между базами доступен admin и viewer (исключение из «viewer только читает»); перенос постоянный. Справочник ТС и баз правит только admin.
- Заявки правят автор и admin; `supervisor_zone0` — ещё и заявки `supervisor_zone1` (карта `TRANSPORT_EDIT_DELEGATION` в `api/transport_lib.php`), обратного права нет; viewer заявки не правит.
- Журнал `transport_journal` — отдельная таблица, не чистится (7-дневная чистка трогает только `audit_log`), правка и удаление запрещены.
- Pitfall: `PDO::inTransaction()` не видит ручной `exec('BEGIN IMMEDIATE')` (PHP 8.3.6) — не защищать `COMMIT/ROLLBACK` этим условием, вести свой флаг транзакции. Записи «проверил пересечение → записал» — только в `BEGIN IMMEDIATE` (`reports/V10/ADR_DB.md` §2.2).
- Подробности и контракт: `reports/V10/`.
