# R1: P0 фиксы js/trips.js — отчёт

**Задача:** t_a400a42e (E9 wave 1, P0 из reports/E9_RELEASE_REVIEW.md)
**Исполнитель:** sd_worker_02
**Дата:** 2026-08-31
**Файл правок:** `/home/hermes/service-center-app/js/trips.js` (2168 → 2247 строк)
**index.html:** НЕ ТРОГАЛСЯ (в рабочем дереве была чужая правка sibling-воркера — panel-tabs styling, не моя).

## Список правок (file:line — до/после)

### Fix-1 — рекурсия confirmTrip/deleteTrip (фатально)
- **js/trips.js:1147** (до) `function confirmTrip(id)` (обёртка) → **(после)** `function handleConfirmTripClick(id)`; внутренний вызов `confirmTrip(id)` на 1152 теперь вызывает API-функцию (315), а не саму себя.
- **js/trips.js:1167** (до) `function deleteTrip(id)` (обёртка) → **(после)** `function handleDeleteTripClick(id)`; внутренний вызов `deleteTrip(id)` на 1172 теперь вызывает API-функцию (336), а не саму себя.
- **js/trips.js:989-990** — inline-onclick в showTripModal: `window.Trips.confirmTrip(...)`/`window.Trips.deleteTrip(...)` → `window.Trips.handleConfirmTripClick(...)`/`window.Trips.handleDeleteTripClick(...)`.
- **js/trips.js:1703-1704** — window.Trips: добавлены `handleConfirmTripClick`, `handleDeleteTripClick` (рядом с `confirmTrip`/`deleteTrip` API-функциями).

### Fix-2 — недостающие экспорты в window.Trips
- **js/trips.js:1701-1702** — добавлены `addParticipantRow`, `removeParticipantRow`.
- **js/trips.js:1746-1747** — добавлены `confirmEmployeePick`, `endEmployeePick`.
- Все inline-onclick теперь ссылаются только на экспортированное (проверено grep: `Trips.removeParticipantRow`, `Trips.confirmEmployeePick`, `Trips.endEmployeePick` и т.д.).

### Fix-3 — endDate всегда = startDate (querySelector берёт первый input)
- **js/trips.js:1132** (до) `var endDate = row.querySelector('.trip-participant-date').value;` → **(после)** `var endDate = row.querySelectorAll('.trip-participant-date')[1].value;`

### Fix-4 — undefined employees в createDraftFromSelection (TypeError)
- **js/trips.js:1470-1493** (новое) — добавлена `resolveEmployeesList()`: сначала `window.employees` (если глобал есть), иначе DOM-fallback по `.day-cell-data[data-emp]` (тот же паттерн, что `getEmployeeName`, строки 1437-1460).
- **js/trips.js:2213-2217** (до) `var employee = employees.find(function(e) { return e.id === parseInt(emp); });` → **(после)** `resolveEmployeesList().find` с нормализацией `normId(e.id) === normId(emp)`.

### Fix-5 — NaN при parseInt id вида 'emp_N'
- **js/trips.js:2087-2088** (до) `var empId = parseInt(item.getAttribute('data-id'));` → **(после)** `var empId = String(item.getAttribute('data-id') || '').replace(/^emp_/, '');`
- **js/trips.js:2144-2154** `confirmEmployeePick`: `selectedEmployees` (нормализованные строки) → `resolveEmployeesList().find(norm(e.id) === norm(empId))` — Set больше не хранит NaN'ы.
- **js/trips.js:2168-2179** `getEmployeesForPick`: `draftEmployees` и сравнение нормализованы; источник — `resolveEmployeesList()` вместо несуществующего `employees`.

### Fix-6 — индексы строк участников сдвигаются; innerHTML += ломает state
- **js/trips.js:1051-1099** (новое) — `collectParticipantRowData()` (читает значения из живого DOM ДО перерисовки) + `rerenderParticipantRows(rowData)` (перерисовка с актуальными индексами; `isViewer` сохраняется через `disabled`).
- **js/trips.js:1101-1110** `addParticipantRow`: вместо `innerHTML +=` (который пересоздавал все строки и терял значения) — collect → push пустой → re-render.
- **js/trips.js:1113-1124** `removeParticipantRow`: вместо `removeChild(children[index])` (после удаления индексы сдвигаются, кнопки «×» бьют мимо) — collect → splice → re-render с новыми индексами.

## Верификация

### Автоматика (прогнано мной)
| Проверка | Результат |
|---|---|
| `node --check js/trips.js` | OK (без ошибок) |
| `node scripts/check_syntax.js` (index.html inline) | 1 script OK, braces 0/0/0 |
| `php -l api/smoke_test.php` | OK |
| `php api/smoke_test.php` | **76/76 PASS**, DB intact |
| `bash scripts/test_trips_frontend.sh` | **7/7 PASS** (после восстановления fixture-сотрудников; первый прогон падал из-за пустой таблицы employees после smoke — не регрессия) |

### Поведение (Node-харнесс + HTTP)
- **Fix-1:** `T.handleConfirmTripClick(5)` → единственный fetch `PUT api/trips.php?id=5&action=confirm`; `T.handleDeleteTripClick(5)` → `DELETE api/trips.php?id=5`. Никакой рекурссии/переполнения стека. (Раньше обе обёртки вызывали сами себя и падали с RangeError.)
- **Fix-2:** все ключи в `window.Trips` — функции (проверено в харнесс: confirmTrip, deleteTrip, handleConfirmTripClick, handleDeleteTripClick, removeParticipantRow, addParticipantRow, confirmEmployeePick, endEmployeePick, startEmployeePick, saveTrip).
- **Fix-3:** saveTrip отправляет `participants[0] = {startDate:'2026-01-01', endDate:'2026-01-05'}` — endDate из ВТОРОГО инпута (в харнесс; HTTP-контракт сервера принимает разные даты — роверено тестом 2 frontend-скрипта и smoke T3).
- **Fix-4:** `confirmEmployeePick` с `pickedEmployees={'7'}` и DOM-fallback (data-emр='7') добавил участника `{employeeId:'7', name:'Смирнов'}` — без TypeError. `employees.find` (бывш. стр. 2140) больше не выполняется — используется `resolveEmployeesList()`.
- **Fix-5:** `emp_7` → `'7'` в Set; сравнение по нормализованным id.
- **Fix-6:** последовательное удаление idx=1, idx=1 удаляет Петрова затем Сидорова (не Иванова) — индексы пересчитываются после каждого удаления (в харнесс с shim-DOM; в браузере т от же код DOM).

Примечание: полный браузерный smoke (клики по реальному UI на 127.0.0.1:8096) выполняет координатор по плану задачи; браузерный драйвер в моём окружении не стартовал (timeout daemon), поэтomу я провёл эквивалентную проверку через Node-харнессы + HTTP + оба тест-скрипта.

## Риски / замечания
- **Не в скоупе (не трогал):** 1) `saveTrip` ищет employeeId по имени через `findEmployeeIdByName`, который полагается на `window.employees` — в текущей сборке глобал не выставляется, поэтomу ручной ввод ФИО в строке участника не найдёт сотрудника. Это отделный дефект (не из 6 P0); draft-поток (`openDraftModal`) и pick-поток добавляют participants напрямую и работают. 2) `endEmployeePick` ссылается на глобал `Trips` (без `window.`) — в браузере работает (глобал-алиас window.Trips), в строгом module-скоупе упал бы.
- **data/app.db:** восстановлен в состояние HEAD (0 employees, 0 trips) — тест-артефакты убраны.
- **index.html:** в рабочем дереве есть чужая правка (sibling-воркер, panel-tabs styling) — не моя, не трогал.
- **Деплой:** не выполнялся (запрещён задачей).

## Артефакты
- Отчёт: `/home/hermes/service-center-app/reports/R1_p0_fixes.md`
- Изменённый файл: `/home/hermes/service-center-app/js/trips.js` (git diff: +100/−21)