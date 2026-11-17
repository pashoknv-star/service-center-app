# V8-T3 — Карточка сотрудника: кнопка «Командировка» → «Задачи» (п.5 владельца, закрывает п.2)

Kanban: `t_571e7820`. Исполнитель: sd_worker_02. Ветка `v8-t3-emp-tasks`, worktree `/home/hermes/wt/v8-t3` (от main `80577c5`). Не мержилось, не пушилось, не деплоилось; main-checkout не тронут. Класс задачи 🟡: все `file:line` ниже прочитаны на текущем коммите (источник — файл), CODEMAP не использовался.

## Итог

| Пункт | Результат |
|---|---|
| 1. Подпись и id | `index.html:2249` — `<button class="btn editor-only" id="tasksFromEmpCardBtn">Задачи</button>`; старый id (`tripFromEmpCardBtn`) нигде в коде нет |
| 2. Admin | клик → карточка закрывается → панель «Задачи», «Список» отфильтрован по сотруднику + открыта форма **новой задачи** с ним в «Исполнители»; сохранение — штатный `saveForm` → `POST api/tasks.php` |
| 3. Supervisor | кнопка видна, клик → панель «Задачи», «Список» по сотруднику, **только просмотр** (нет формы, «+ Новая задача», ✎, «Сохранить»; плашка «только просмотр»); сервер по-прежнему отвечает 403 на запись |
| 4. Старый путь | обработчик и его мёртвый код удалены из `js/trips.js` и `index.html` (строки ниже); создание командировки из Матрицы / вкладки «Командировки» не затронуто |

## Причина / что изменено (по пунктам)

### 1. Кнопка (`index.html`)
- Было: `index.html:2249` `id="tripFromEmpCardBtn"` «Командировка» с обработчиком в `js/trips.js`. Стало: `index.html:2249` `id="tasksFromEmpCardBtn"` «Задачи» (класс `editor-only` сохранён; комментарий-указатель на V8-T3 вместо «Phase 7»).
- Видимость: `index.html:2358` `const showEditor = user.canEdit === true;` + `:2359` скрывает `.editor-only` только при `canEdit !== true`. `api/auth.php:9,114`: admin и supervisor → `canEdit=true`, viewer → `false`. Проверено по реальной сессии (тест V1): admin/supervisor — видна, viewer — скрыта, **как и раньше**. Правка видимости не потребовалась (supervisor кнопку уже видел).

### 2–3. Точка входа `Tasks.openForEmployee(empId)` (`js/tasks.js`)
- `js/tasks.js:2754` `function openForEmployee(empId)`, экспорт `js/tasks.js:3411` (`window.Tasks.openForEmployee`).
- Логика: `normEmpId` (число из карточки → `emp_N`), `ensurePanelOpen()` (как `openTasksPanel`), `S.view='list'`, `S.filters = {emp, остальные пустые}`, `S.form=null`, `activate()` (перечитывает справочник и задачи). Дальше: `if (canWrite()) openForm(null)` — для admin открывается форма новой задачи.
- **Поле сотрудника в модели задачи:** исполнители — `draft.assignees` (массив `employee_id`, роль `assignee`; `js/tasks.js:1912` `emptyDraft`: `assignees: S.filters.emp ? [S.filters.emp] : []`, форма `js/tasks.js:2015` «Исполнители (1..N)»). Поэтому достаточно выставить `S.filters.emp` перед штатным `openForm(null)` (`js/tasks.js:2298`) — отдельного кода предвыбора не нужно, форма и сохранение штатные. Наблюдатель (`watchers`) в MVP неактивен (`js/tasks.js` форма, поле disabled), не используется.
- `canWrite()` = `isAdmin()` (`js/tasks.js:168`): supervisor/viewer — форма и кнопки записи не рендерятся (`renderBar` `js/tasks.js:532`, `renderList`, `render` `:2059` — `showForm = S.form && canWrite()`), поэтому UI не предлагает запрещённого.
- Сотрудник, которого ещё нет на сервере (только что добавлен на клиенте и не сохранён): функция не открывает форму, показывает штатную ошибку `employee_not_found` («Выбранный сотрудник не найден…»), возвращает `false`.
- «Карточка сотрудника закрывается/уступает место так же, как при обычном создании»: при обычном «+ Новая задача» на экране форма, список под ней не рисуется (`js/tasks.js:2059` render) — так же и здесь; список сотрудника виден после «Сохранить»/«Отмена».

### Обработчик кнопки (`index.html`)
- `index.html:4606` — `document.getElementById('tasksFromEmpCardBtn').addEventListener('click', …)`: если `currentId == null` или `window.Tasks.openForEmployee` нет → тост «Панель задач недоступна», ничего не сбрасывается; иначе `resetMatrixEmployeeCard()` (`index.html:3190` — закрывает карточку, снимает выделение, возвращает прокрутку матрицы; та же функция, что у крестика карточки в режиме матрицы) → `window.Tasks.openForEmployee(currentId)`.

### 4. Удалённый старый путь (множественный выбор → «Подтвердить» → ничего)
Номера строк — **в исходном состоянии (`80577c5`)**, координатору для сведения с T1 на main:

`js/trips.js` (удалено только перечисленное, ничего вокруг):
- `:41–42` поля `_dom.tripFromEmpBtn`, `_dom.tripFromEmpCardBtn`;
- `:926–929` `getElementById('tripFromEmpBtn')` + комментарий + `getElementById('tripFromEmpCardBtn')`;
- `:942–949` блоки `addEventListener('click', openTripFromEmployee)` для обеих кнопок (с комментариями);
- `:1815–1872` секция «EMPLOYEE TRIP BUTTON»: функция-обработчик (создавала draft и звала `startEmployeePick(draft)` + тост «Выберите участников командировки…») и её вспомогательная `getCurrentEditingEmployeeId` (читала `window.__editingEmployeeId`/legacy-переменные). Заголовок секции оставлен — под ним `showTripSelectionModal`;
- `:2310` экспорт `openTripFromEmployee` в `window.Trips`.

`index.html`:
- `window.__editingEmployeeId = id` (+ комментарий) в `openEditor` (`~4236`) и `= null` в обработчике `#closeEditor` (`~4605`) — единственный потребитель был удалённая вспомогательная функция.

**Доказательство «нигде не вызывается» (rg по всему репо, не по индексу):**
- `rg -n "tripFromEmpCardBtn|tripFromEmpBtn|openTripFromEmployee|getCurrentEditingEmployeeId|__editingEmployeeId" --glob '!reports' --glob '!CODEMAP.md' --glob '!PROGRESS.md'` на исходном коммите: только `js/trips.js` (определения/привязки/экспорт), `index.html:2249` (кнопка) и `:4238/:4605` (`__editingEmployeeId`); **вызовов из `index.html`, `js/tasks*.js`, `scripts/*` (тестов), `api/*` нет**; элемента `#tripFromEmpBtn` в `index.html` не существовало вовсе (мёртвая привязка). Динамические вызовы (`onclick="window.Trips.openTripFromEmployee"`/`Trips['…']`) — rg по `openTripFromEmployee` их показал бы: не найдено.
- После правки тот же rg → 0 совпадений (тест S3 повторяет проверку по всем отслеживаемым файлам вне `reports/`, `CODEMAP.md`). Остатки старых имён только в исторических документах `reports/**` (E9 review, спеки V8) и в `CODEMAP.md` (регенерируется по необходимости; `CODEMAP.md:44` — устаревшая запись про `openTripFromEmployee`).
- Сьют `refs` (IE-1): «удалено 2 (getCurrentEditingEmployeeId, openTripFromEmployee), со ссылками 0, исключений 0».
- **Не тронуто (границы):** `startEmployeePick`/`confirmEmployeePick`/пик-режим (нужны «+ Добавить сотрудника» в форме командировки, `js/trips.js:1204/1332/1366` и тесты e51/e52), `createTripFromSelection`, выбор дат в Матрице, форма командировки, `api/trips.php`.
- **Замечание (вне объёма, не менял):** `showTripSelectionModal` и экспорт `selectTripForEmployee` (`js/trips.js`, ниже удалённого блока) и до моей правки не имели вызывающих (rg: единственное упоминание `showTripSelectionModal` — его определение). Кандидат на отдельную чистку.

## Проверка

### Тесты
Новый сьют `emptasks` — `scripts/test_emp_tasks_btn.js` (34 проверки, `RESULT: 34 passed, 0 failed`, подключён в `scripts/verify_all.sh`: `BASELINE[emptasks]=34`, `ALL_SUITES`, ветка запуска). Без исправления (`git stash` кода) сьют падает (`RESULT: 1 passed, 6 failed` — прерывается на отсутствии `Tasks.openForEmployee`). Состав:
- статика S1–S11: подпись «Задачи» и `editor-only`, кнопка внутри `aside#editor`, нет «Командировка» в карточке; старых id/функции нет в отслеживаемых файлах; удалены обработчик и `getCurrentEditingEmployeeId`; экспорты `Trips.*` для Матрицы/вкладки целы (`startEmployeePick`, `confirmEmployeePick`, `openTripModal`, `saveTrip`, привязка `newTripBtn`); обработчик кнопки из `index.html` исполняется в vm: порядок `reset → open(id)`, без модуля задач — тост без сброса, без карточки — ничего; inline-`<script>` проходят синтаксис; `node --check` двух файлов;
- видимость V1–V2: `canEdit` из реальной сессии php: admin/supervisor `true`, viewer `false`; код `applyRoleGating`;
- admin A1–A10 (js/tasks.js в vm против **настоящего** `api/tasks.php`, `php -S` на копии БД, `SC_APP_DB`): панель открыта, «Список», фильтр на сотруднике (числовой id нормализуется), форма «Новая задача», в «Исполнители» один чип с ФИО, нет дубля в селекторе; пустое название → штатная ошибка без запроса; сохранение → ровно один `POST api/tasks.php` с `assignees:[emp]`, форма закрыта, тост «Задача создана»; на сервере задача с этим исполнителем; повторное открытие — фильтры сброшены, форма пустая; «Отмена» возвращает список;
- supervisor B1–B5: список только этого сотрудника (чужая задача отсутствует); нет формы / «+ Новая задача» / «Сохранить» / ✎ / колонки правки / формы в разметке, есть «только просмотр»; карточка задачи без «Править/Закрыть/Удалить»; сервер отвечает 403 на запись;
- несохранённый сотрудник N1–N2: `false`, формы нет, ошибка «Выбранный сотрудник не найден»; пустой id — ничего;
- Z1: `data/app.db` не изменена (sha1).

### Браузер (реальный Chromium, `php -S 127.0.0.1:8193 router.php`, **копия** БД через `SC_APP_DB`; сессии admin и `supervisor_zone0` получены через `api/login.php` curl'ом и подставлены куки — пароль в браузере не вводился; dev-сид, прод не затрагивался)
Данные: сотрудник «Ivanov Ivan», 3 демонстрационные задачи у него и 1 у «E9 Test Employee».

| Скриншот | Что показывает |
|---|---|
| `reports/V8/screens/T3_01_admin_employee_card.png` | admin: карточка сотрудника, кнопка «Задачи» вместо «Командировка» |
| `reports/V8/screens/T3_02_admin_new_task_form.png` | admin, после клика: карточка закрыта, панель «Задачи», «Новая задача», в «Исполнители» — Ivanov Ivan |
| `reports/V8/screens/T3_03_admin_after_save_list.png` | admin: после «Сохранить» (название введено, исполнитель не менялся) — задача создана, список отфильтрован по сотруднику |
| `reports/V8/screens/T3_04_supervisor_employee_card.png` | supervisor (бейдж «ГКС»): кнопка «Задачи» видна |
| `reports/V8/screens/T3_05_supervisor_employee_task_list.png` | supervisor, после клика: «Список», фильтр «Ivanov Ivan», 3 строки, «только просмотр», нет «+ Новая задача», нет ✎ |
| `reports/V8/screens/T3_06_trips_new_trip_still_works.png` | вкладка «Командировки» и «Новая командировка» открываются как раньше (supervisor-сессия) |

Из DOM в браузере: admin — `h4="Новая задача"`, чип «Ivanov Ivan ×», `saveForm` есть, после сохранения список из 3 строк у Ivanov Ivan; supervisor — `form=false, newBtn=false, editBtns=0`, действия только `setView/resetFilters/sortBy/openTask/filterEmp`.

### GATE (`bash scripts/verify_all.sh`, worktree, HEAD `9591435`)

```
verify_all: 9591435 2026-11-17 20:56:40 suites: smoke tasks tasksn8n tasksatt tasksui tasksmx taskscal director emptasks e51 e52 hygiene trips syntax phplint pii refs tasklink

SUITE    RES  PASSED EXPECT   TIME  NOTE
smoke    PASS     84     84     3s
tasks    PASS     66     66     6s
tasksn8n PASS     27     27    26s
tasksatt PASS     24     24     6s
tasksui  PASS    334    334    25s
tasksmx  PASS     79     79     6s
taskscal PASS    220    220     6s
director PASS    101    101    14s
emptasks PASS     34     34     2s
e51      PASS     23     23     0s
e52      PASS     41     41     1s
hygiene  PASS     19     19     0s
trips    PASS      7      7     3s
syntax   PASS      -      -     0s
phplint  PASS     36      -     3s
pii      PASS      -      -     0s
refs     PASS     28     28    20s  удалено 2, со ссылками 0, исключений 0
tasklink PASS     43     43     6s  коммитов 2, с кодом 1, нарушений 0
clean    PASS

GATE: PASS (18 suites)
```
Сьюты `tasks*` не уменьшились (tasks 66, tasksn8n 27, tasksatt 24, tasksui 334, tasksmx 79, taskscal 220 — как до правки). `data/app.db` не менялась, `git status` чистый.

## Риски / замечания для слияния

- **hotspot: `scripts/verify_all.sh`** — строка `BASELINE` (`[emptasks]=34`), `ALL_SUITES` (после `director`) и список сьютов/ветка `case` затрагиваются каждой задачей V8 (T1/T2/T4 тоже добавляют свои сьюты) — при merge ожидаем конфликт в этих трёх строках, сводить вручную (поднять `BASELINE` каждого сьюта на фактические числа).
- `js/trips.js`: удалены перечисленные выше фрагменты; T1 на main правит форму командировки в том же файле — конфликт возможен в районе `:926–949` (init) и `:1815–1872`; строки приведены к исходному `80577c5`.
- `index.html`: правки — кнопка (`:2249`), обработчик (`:4606`, рядом с `#closeEditor`), убран `__editingEmployeeId` (2 места); форма командировки/`createTripFromSelection`/Матрица не тронуты.
- Документальная правка `AGENTS.md` (список сьютов/эталон) — файлом `reports/V8/T3_AGENTS_patch.md` (AGENTS.md не редактировался).
- supervisor видит кнопку и список задач для любого сотрудника, открытого в карточке (чтение задач на сервере и раньше открыто всем ролям, `api/tasks.php` GET); ограничение зоны на карточку сотрудника — вне объёма T3.
- Сотрудник, добавленный кнопкой «+ Добавить сотрудника» и ещё не сохранённый на сервере, даёт ошибку «Выбранный сотрудник не найден» вместо формы (осознанно: сервер всё равно отклонил бы задачу).
- Реальный Telegram/HelpMe/n8n/прод не вызывались; деплоя и push нет.
