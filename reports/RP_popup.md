# RP: popup «Командировка» → Trip-сущность, убрать «Создать командировку» (замечания 5-6)

**Задача:** t_ff8f28c4
**Исполнитель:** sd_worker_02
**Дата:** 2026-09-01
**Файл правок:** `/home/hermes/service-center-app/index.html` (единственный файл; js/trips.js НЕ ТРОГАЛСЯ — R4 (sd_worker_02, параллельная задача) правит его)
**Деплой:** НЕ выполнялся (запрещён)

## Что сделано

### 1. Удалён popup-пункт «Создать командировку» (замечание 5)
- **index.html:2004** — удалён элемент:
  ```html
  <div class="popup-item" data-type="trip-draft" ...>Создать командировку</div>
  ```
- В popup осталось: Рабочий день / Отпуск / Больничный / Командировка / Отгул / Очистить.

### 2. Обработчик popup-item: убрана ветка trip-draft, «Командировка» → Trip-сущность (замечание 6)
- **index.html:4050-4093** — переписан обработчик клика `.popup-item`:
  - Удалена ветка `type === 'trip-draft'` (вызывала `window.Trips.createDraftFromSelection` с undefined employees — P0 из R1, и создавала legacy-конфликт D8).
  - Удалено исключение `type !== 'trip-draft'` в holiday-warning guard (теперь `type !== 'work' && type !== 'clear'`), чтобы варнинг не чинился.
  - **`type === 'trip'`** теперь открывает создание Trip-сущности через `window.Trips.createTripFromSelection(empId, startDay, endDay)`, где:
    - `empId` = сотрудник строки/ячейки (`popupTarget.empId`),
    - `startDay`/`endDay` = выделенный диапазон (`isRange`) или один день.
    - Код **НЕ** вызывает `setDayVacationType(..., 'trip')` — legacy schedule_entry БОЛЬШЕ не создаётся через popup.

### 3. Новая функция `createTripFromSelection()` (index.html ~5037-5095)
- Определена в inline-скрипте после `window.showToast`, доступна и как `window.createTripFromSelection`, и как `window.Trips.createTripFromSelection`.
- Логика:
  1. `dayOfYearToDate(year, day)` + `formatDateStr(...)` → `YYYY-MM-DD` для start/end (closure-хелперы матрицы).
  2. Резолв сотрудника: `window.employees` (глобал, в этой сборке нет) → DOM-fallback по `.day-cell-data[data-emp="N"]` (тот же паттерн `resolveEmployeesList()` из R1).
  3. **Нормализация id**: `'emp_' + employeeId` если нет префикса — ровно как `selectTripForEmployee` (js/trips.js:1379). API требует `emp_1`, DOM отдаёт `1`.
  4. Вызов `window.Trips.createTrip({ title, location:'', comment:'', status:'forecast', participants:[{employeeId, startDate, endDate}] })` — POST `api/trips.php` (см. AC #3).
  5. Успех → toast + `switchTab('trips')` (обновляет список и overlay матрицы). Ошибка → toast.

### Legacy-механизм НЕ тронут
- `setDayVacationType()` (index.html:3379) и `TYPE_TO_STATUS` (`trip: 'trip'`) остались без изменений — прочие типы ячеек (отпуск/больничный/отгул) продолжают работать как раньше. Изменён ТОЛЬКО вход через popup для «Командировка».

## Архитектурное решение (по ТЗ: предложить в отчёте)

- **Проблема:** R2 (t_cb9ffe78) — отчёт-спецификация, in-panel форма командировки в коде НЕ существует (только в reports/R2_inpanel_stacking.md). Другие R-задачи форму не строят.
- **Выбор:** popup «Командировка» создаёт Trip **напрямую** через существующий API-слой `window.Trips.createTrip` (POST api/trips.php), с предзаполненным участником (сотрудник строки) и датами (выделенный диапазон/один день). Это:
  - полностью соответствует функциональному ядру замечаний 5-6 (убрать «Создать командировку», «Командировка» → Trip-сущность);
  - не зависит от нереализованной in-panel формы R2 (AC #2 в его дословном виде «открывает in-panel форму R2» не может быть выполнен, т.к. этой формы в коде нет — это отдельный скоуп R2, отслеживается RV t_66c55956);
  - не создаёт legacy `schedule_entry`;
  - не трогает js/trips.js (избегаем коллизии с параллельной R4, правящей тот же файл).
- **Альтернативы, отклонённые:**
  - (a) Вызывать `window.Trips.openTripModal(null)`/`openNewTripModal()` — не экспортированы, и `saveTrip` не находит сотрудника по имени (`findEmployeeIdByName` полагается на несуществующий `window.employees`) — создание через форму всё равно упало бы.
  - (b) Строить in-panel форму в рамках RP — это дублирование скоупа R2 (отдельная задача) и риск коллизии с R4.

## Verification

| Проверка | Результат |
|---|---|
| `php -l index.html` | PASS (no syntax errors) |
| `node --check` (полный inline-скрипт) | PASS |
| `php api/smoke_test.php` | **76/76 PASS**, DB intact |
| `bash scripts/test_trips_frontend.sh` | **7/7 PASS** |
| Static: `data-type="trip-draft"` в index.html | 0 вхождений |
| Static: ветка `type === 'trip-draft'` в inline-скрипте | 0 вхождений |
| Static: `window.Trips.createTripFromSelection` определён и вызван в popup | PASS (4 ссылки: определение + attach + popup) |
| HTTP: POST api/trips.php с payload `{employeeId:'emp_1', startDate:'2026-01-15', endDate:'2026-01-20'}` (ровно как шлёт createTripFromSelection) | `success:true`, создан Trip (status forecast), затем удалён (DB чиста: 0 trips) |
| HTTP: проверка что API НЕ создаёт schedule_entry | trips.php пишет только в `trips`/`trip_participants` (smoke 76/76 подтверждает) |

## Приёмка по AC

1. **AC #1** — В popup НЕТ «Создать командировку»: ✅ (удалён index.html:2004).
2. **AC #2** — «Командировка» в popup открывает форму с предзаполненным участником и датами: ⚠️ **Частично.** Функционально: «Командировка» создаёт Trip с участником=сотрудник строки и датами=выделенный диапазон (проверено HTTP-контрактом). Дословно «in-panel форму R2» открыть нельзя — R2 остался отчётом, форма не реализована (скоуп R2, отслеживается RV). Если координатор требует редактируемую форму до сохранения — нужна реализация R2 (отдельная задача); текущее решение — прямое создание через api/trips.php.
3. **AC #3** — Сохранение создаёт Trip через api/trips.php (не schedule_entry): ✅ (проверено реальным POST + DELETE).
4. **AC #4** — smoke 76/76, e2e 7/7: ✅.

## Риски / заметки

- **hotspot: index.html inline-скрипт** — R4 (sd_worker_02, параллельная задача на том же профиле) правит тот же inline-скрипт (добавил `window.__serverEmployees` ~5175). Мой diff не пересекается с её зоной, но при merge возможны конфликты строк — флагаю для координатора.
- **Зависимость от R2:** если будет реализована in-panel форме R2, popup «Командировка» логично переключить на неё (заменить вызов `createTripFromSelection` на открытие формы с prefill). Сейчас форма отсутствует.
- **Браузерное E2E** (клик ячейки → popup → «Командировка» → Trip в списке) — не выполнено: локальный browser-демон недоступен (agent-browser/Chromium не установлен). Верификация заменена на: синтаксис, статик-анализ, HTTP-контракт, smoke+e2e.

## Артефакт
- Отчёт: `/home/hermes/service-center-app/reports/RP_popup.md` (этот файл)