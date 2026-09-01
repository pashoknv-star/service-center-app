# R3: Механика «Добавить сотрудника» через Ctrl+карточки (замечания 10-11)

Статус: реализовано, все наборы проверок PASS.
Файлы: `js/trips.js` (основной), `index.html` (2 микро-вставки: guard в openMatrixEmployeeCard, guard в click-обработчике карточки сотрудника).
Деплой: НЕ выполнялся (запрещён).

## Что сделано

### Задача A — замечание 10: «+ Добавить сотрудника» через Ctrl+карточки

1. **`startEmployeePick(draft)`** (js/trips.js) переписан:
   - Панель уезжает за левую границу: `vacation-panel` получает класс `trip-panel-slided`
     (`translateX(calc(-100% + 46px))`) — видима только кромка с кнопкой.
   - **Dock-список с чекбоксами УДАЛЁН полностью** (dock HTML, populate, position, search, checkbox-рендер). Dock не появляется ни при старте, ни при подтверждении.
   - Добавлена **edge-кнопка** `.trip-pick-edge` (CSS в injected styles js/trips.js): `position:fixed; left:46px` — на видимой кромке уехавшей панели, НЕ на `left:0` экрана (как было у dock). Текст: «✓ Добавить сотрудников». Повторное нажатие = `confirmEmployeePick()`.
   - Устанавливается флаг `window._employeePickActive` и `Trips.suppressInfoPanel = true` (клики по карточкам НЕ открывают «Карточку сотрудника»).

2. **Ctrl+click по карточкам на странице** (ТЗ: «пользователь удерживает CTRL и кликает карточки на СТРАНИЦЕ, не в dock-списке»):
   - На `document` вешается capture-обработчик `click` (только пока pick активен и зажат Ctrl/Cmd).
   - Перехватывает клик по `.employee`, вызывает `event.preventDefault()/stopPropagation()`, чтобы host-обработчик карточки НЕ открыл редактор.
   - Переключает **штатный** класс `.employee.selected` (как при обычном мультивыборе на странице) и ведёт `window.Trips.pickedEmployees` (Set с нормализацией `emp_` → голый id, cм. R1 Fix-5).
   - Новых подсветок/стилей НЕ создаётся — только существующий `.employee.selected` glow.

3. **guard в `openMatrixEmployeeCard`** (index.html, микро-вставка 1): если `Trips.suppressInfoPanel()` истинно (pick активен) — карточка-панель сотрудника НЕ открывается.
   **guard в click-обработчике карточки `.employee`** (index.html, микро-вставка 2): при активном pick (suppress) клик по карточке не открывает редактор.

4. **`confirmEmployeePick()`**: выбранные сотрудники (из `pickedEmployees`) добавляются в `draft.participants`, синхронизируются в строки формы `#tripParticipants` (`syncPickedEmployeesToForm`), затем `endEmployeePick()` восстанавливает панель (снимает `trip-panel-slided`), убирает edge-кнопку и capture-листенер.

5. **`endEmployeePick()`**: полная очистка — suppress=false, панель возвращается, edge удаляется, capture-листенер снимается (`removeEventListener`), `_employeePickContext`/`pickedEmployees`/`_employeePickActive` сбрасываются. Сохранён null-guard D7 (панели может не быть).

### Задача B — замечание 11: вход из карточки сотрудника

- **Сценарий А (нет forecast):** «Командировка» в карточке сотрудника → открывается форма командировки, инициатор уже участник (с именем). Проверено в браузере.
- **Сценарий Б (есть forecast):** выбор из списка → клик по трипу → `selectTripForEmployee(tripId, empId)` открывает форму через `openTripModal(tripId, onRendered)`, **строка инициатора добавляется детерминированно в колбэке onRendered ПОСЛЕ resolve сессии и рендера формы** — setTimeout-гонка (строка ~1365/1403) убрана.
- `openTripModal(id, onRendered)` — опциональный колбэк вызывается после `showTripModal()` (синхронно, если `_currentUser` уже известен, либо после `api('GET','api/session.php')`).

## Точная схема изменений (файл:строка)

| Файл | Зона | Что |
|------|------|-----|
| js/trips.js | injected CSS ~734-760 | `.trip-pick-edge` (edge-кнопка на кромке 46px) |
| js/trips.js | `startEmployeePick` | slide + edge + capture-листенер Ctrl+click, dock удалён |
| js/trips.js | `populateEmployeePickList` | no-op (dock удалён) |
| js/trips.js | `toggleEmployeePickSelection(card, empId)` | штатный `.employee.selected` + Set (нормализация emp_) |
| js/trips.js | `positionEmployeePickDock` | no-op |
| js/trips.js | `endEmployeePick` | полный cleanup (D7 сохранён) |
| js/trips.js | `confirmEmployeePick` | push в draft.participants + `syncPickedEmployeesToForm` |
| js/trips.js | `syncPickedEmployeesToForm` | новые строки участников в `#tripParticipants` с employeeId (имя резолвится) |
| js/trips.js | `getEmployeesForPick` | без изменений (оставлен для совместимости) |
| js/trips.js | `openTripModal(id, onRendered)` | детерминированный колбэк после рендера |
| js/trips.js | `selectTripForEmployee` | setTimeout-гонка → onRendered |
| index.html | `openMatrixEmployeeCard` (~3721) | guard suppressInfoPanel — карточка не открывается при pick |
| index.html | click-обработчик `.employee` (~4572) | guard suppressInfoPanel — не открывать редактор при pick |

## Проверки

| Набор | Результат |
|-------|-----------|
| `node --check js/trips.js` | OK |
| R4 harness (`node scripts/test_r4_hygiene.js`) | 19/19 PASS |
| `php api/smoke_test.php` | 76/76 PASS, DB intact |
| e2e (`bash scripts/test_trips_frontend.sh`) | 7/7 PASS |
| Браузерное E2E (admin, реальный сервер 8096) | см. ниже |

### Браузерная проверка (скрипт-сценарии в консоли)

1. `Trips.startEmployeePick(...)` → панель `trip-panel-slided=true`, edge-кнопка «✓ Добавить сотрудников», **dock=false**, `_employeePickActive=true`, suppress=true. ✅
2. Ctrl+click по карточке `.employee` → `nowSelected=true`, `picked=["1"]`, **editor НЕ открылся** (`editorOpen=false`), карточка-панель НЕ открылась (`cardPanelOpen=false`). ✅
3. Повторный Ctrl+click — снятие выбора (Set.delete + снятие `.selected`). ✅ (логика, покрыта проверкой toggling)
4. Клик по edge-кнопке → панель вернулась (`slideAfter=false`), edge удалён, `activeAfter=false`, **строка участника добавлена в форму** (`rows 1→2`, name = «Smoke Fixture Employee»). ✅
5. Задача B Сценарий А: клик по карточке (без Ctrl, pick не активен) → editor open, `editingId` установлен; клик «Командировка» → форма, строка с именем инициатора. ✅
6. Задача B Сценарий Б: второй сотрудник не в forecast-трипе → «Командировка» → **модалка выбора** → клик по трипу → форма с **обеими строками** (существующий + инициатор, даты 2026-09-10…09-12), row добавлена детерминированно. ✅

## Ограничение / известный долг

- **R2 in-panel форма — только отчёт (report-only)**: фактическая форма командировки в коде осталась **модалкой** `#tripForm` (`.trip-modal`), а НЕ панельной (как описано в R2). R3 реализован против этой реальной формы: `syncPickedEmployeesToForm`/`selectTripForEmployee` пишут в `#tripParticipants` (реальный DOM формы). Это согласовано с подходом RP (тот тоже фиксировал PARTIAL и работал против существующей формы). Если координатор примет R2-код отдельной задачей — R3-механика ляжет на неё, т.к. она оперирует на `#tripParticipants` внутри формы.
- `showTripModal(null)` по-прежнему добавляет 1 пустую строку участника (замечание 9/наблюдение 8 — R2 gap, не R3).
- В index.html осталась **неиспользуемая CSS док-стилей** (`.trip-pick-dock`, `.dock-*`) — мёртвый код, не влияет на работу (в R3 dock не создаётся). Удаление вне скоупа R3 (микро-вставки оговорены).
- Деплой не выполнялся.

## Итог

Замечания 10 и 11 выполнены: панель уезжает/возвращается, выбор — Ctrl+кликом по карточкам с штатной подсветкой `.employee.selected`, dock-список отсутствует, вход из карточки сотрудника работает в обоих сценариях через детерминированный рендер (гонка setTimeout убрана). Все тесты: smoke 76/76, e2e 7/7, R4 harness 19/19, unit PASS.