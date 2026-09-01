# R4: Клиентские зоны + monkey-patch restore + гигиена — отчёт

**Задача:** t_b71297c7 (R4, P2-доработки из ревью E9)
**Исполнитель:** sd_worker_02
**Дата:** 2026-09-01
**Файлы правок:**
- `/home/hermes/service-center-app/js/trips.js` (+94/−21)
- `/home/hermes/service-center-app/index.html` (+4: только зеркало `window.__serverEmployees` в двух точках загрузки)
- Новый тест-харнесс: `/home/hermes/service-center-app/scripts/test_r4_hygiene.js`
- Отчёт: `/home/hermes/service-center-app/reports/R4_p2_hygiene.md`

**Деплой:** не выполнялся (запрещён задачей).

---

## Fix A — клиентская проверка зон (D4, ТЗ §6)

### Проблема
`canDeleteTrip` (бывш. 1501-1511) возвращал `true` для ЛЮБОГО forecast-трипа у
supervisor (`// This is simplified - in real implementation would check zone`).
Сервер с E8 корректно отвечает `403 zone_forbidden`, но кнопка «Удалить»
рендерилась всем — UX-провал. Аналогично `canConfirm` в `showTripModal` (954)
проверял только роль, не зону.

### Решение (js/trips.js)
1. **`employeeZone(emp)`** — нормализует зону сотрудника из любого представления:
   - серверное `groupId: 'g1'` (load.php employees[].groupId)
   - legacy `dept: 1` (serverToLegacy → storage.js:178)
   Результат всегда `'g<n>'` (нижний регистр).
2. **`canDeleteTrip(trip, user)`** — теперь:
   - admin → true (любой трип);
   - supervisor → только forecast + `user.scopeGroupId` задан + **все** участники
     трипа в его зоне (`employeeZone(emp) === scopeGroupId`);
   - при неразрешимой зоне участника — **fail closed** (кнопки нет; сервер всё
     равно защищает `zone_forbidden` — это UX, не граница безопасности);
   - viewer/прочие → false.
3. **`canConfirmTrip(trip, user)`** — зеркальная проверка для кнопки
   «Подтвердить» (showTripModal:954 заменён на неё).
4. **Источник зон:** `load.php` отдаёт `employees[].groupId`; на клиенте данные
   проходят `serverToLegacy()` → `dept`. Так как массив `employees` — замыкание
   index.html, добавлено зеркало **`window.__serverEmployees`** в двух точках
   загрузки (showApp + initFromServer), а `resolveEmployeesList()` в trips.js
   теперь предпочитает его (fallback — прежний DOM-путь).
5. Экспорты: `canDeleteTrip`, `canConfirmTrip`, `employeeZone` добавлены в
   `window.Trips` (для тестов и возможного внешнего вызова).

### Проверка браузером (двумя ролями)
Координатором по плану задачи (ролевое браузерное E2E admin + supervisor двух
зон). Локально эквивалент проверен Node-харнессом:
- admin удаляет чужой-зонный трип → `true`;
- supervisor_zone1 + участник dept=1 → `true`;
- **supervisor_zone0 + участник dept=1 → `false`** (AC-1: кнопки нет);
- supervisor без `scopeGroupId` → `false`;
- confirmed-трип → `false`.

---

## Fix B — monkey-patch restore (D3)

### Проблема
`startCalendarPick` (1934-2003) перезаписывал `window.handleCellMouseUp`
навсегда («глобальный monkey-patch с утечкой», E9 D3). В текущей сборке
`handleCellMouseUp` — **замыкание index.html, не глобал** (`window.handleCellMouseUp`
нигде не присваивается), поэтому патч вообще никуда не «втыкался», но код
оставлял мусорный глобал при будущих изменениях хоста.

### Решение (js/trips.js)
- Оригинал захватывается в `origHandleCellMouseUp`.
- `restoreCellMouseUp()` восстанавливает оригинал (или удаляет слот, если его
  не было) **на каждом пути завершения**:
  - клик по валидной ячейке (после записи даты, до `switchTab`);
  - **ESC** — добавлен `keydown`-обработчик в capture-фазе, который отменяет пик
    и восстанавливает оригинал (`document.removeEventListener` — без утечки
    слушателя).
- Если оригинал не был глобалом — restore является no-op (слот удаляется), т.е.
  поведение не хуже прежнего и готово к хосту, где глобал существует.

### Проверка (Node-харнесс, Test 7)
- `startCalendarPick` заменяет `window.handleCellMouseUp`;
- ESC → контекст сброшен, `handleCellMouseUp === original` (AC-2);
- повторный старт + fallthrough → контекст жив, повторный ESC → оригинал
  восстановлен; дубликатов слушателей нет.

---

## Fix C — гигиена (D2, D5, D7)

### D2 — `getDayVacationType` недоступна (openDraft:1774)
`openDraft` вызывает хост-функцию `getDayVacationType` (inline-скрипт
index.html). Добавлен guard:
```js
if (typeof getDayVacationType !== 'function') {
  console.warn(LOG_PREFIX, 'getDayVacationType unavailable — skipping vacation-conflict check for', empId);
  return;
}
```
Недоступна → пропуск конфликт-чека (логирование), без TypeError. (AC-3.)

### D5 — валидация дат перед `formatDateStr` (openDraft:1777)
`new Date('2026-13-40')` / пустые строки → Invalid Date (`getTime()` = NaN),
цикл по дням мог крутиться бесконечно или засорять `conflictDays`. Добавлено
перед циклом:
```js
if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) { warn; return; }
if (startDate.getTime() > endDate.getTime()) { warn; return; }
```
Мусорные/инвертированные даты — skip (сервер перевалидирует на POST).

### D7 — null-guard `endEmployeePick` (vacationPanel)
`endEmployeePick` мог упасть на `null.classList` если `.vacation-panel` уже нет
в DOM (race с logout/закрытием панели). Все обращения к панели обёрнуты в
`if (vacationPanel) { ... }`.

---

## Верификация

### Автоматика (прогнано мной)
| Проверка | Результат |
|---|---|
| `node --check js/trips.js` | OK |
| `node --check js/storage.js` | OK |
| `node --check js/test_trips_overlay.js` | OK |
| inline-скрипты index.html (parse через `new Function`) | 3/3 OK |
| `node js/test_trips_overlay.js` | PASS (overlay unit) |
| `node scripts/test_r4_hygiene.js` (новый R4-харнесс) | **19/19 PASS** |
| `php api/smoke_test.php` | **76/76 PASS**, DB intact |
| `bash scripts/test_trips_frontend.sh` | **7/7 PASS** |

### R4-харнесс (scripts/test_r4_hygiene.js) — что покрывает
1. Экспорты `canDeleteTrip`/`canConfirmTrip`;
2. Зоны: admin любой; зона совпадает; **зона чужая → false**; нет scope → false;
   confirmed → false;
3. `canConfirmTrip` по зонам;
4. D2: `openDraft` не бросает при недоступном `getDayVacationType`;
5. D5: `openDraft` пропускает невалидные даты без throw/бесконечного цикла;
6. D7: `endEmployeePick` переживает отсутствие `.vacation-panel`;
7. D3: замена/восстановление `handleCellMouseUp` (пик + ESC; без дубликатов
   слушателей).

### Замечания по харнессу
Харнесс зеркалит хост-глобалы `formatDateStr` и `Trips` (как в браузере), т.к.
trips.js использует их в пре-существовавших путях (`openDraftModal`,
startCalendarPick, endEmployeePick). Это не маскирует баги — R1-пути
задействованы теми же глобалами в реальном браузере.

## Риски / замечания
- **Соседняя правка (R2, in-panel форма):** в рабочем дереве index.html уже была
  правка sibling-воркера (popup «Командировка» → `createTripFromSelection`).
  Мои изменения в index.html минимальны (+2 строки зеркала) и не конфликтуют.
- **`data/app.db`:** восстановлен в HEAD после smoke/тестов (0 employees).
- **Замечание R1 (не в скоупе):** `findEmployeeIdByName` полагается на
  `window.employees`, который не выставляется — ручной ввод ФИО в строке
  участника модалки не найдёт сотрудника; draft- и pick-потоки участников
  работают (R4 не трогает).
- **Браузерное E2E двумя ролями** (AC-1) — на координаторе по плану задачи;
  мой окружение не имеет браузерного драйвера (как и в R1).

## Артефакты
- Отчёт: `/home/hermes/service-center-app/reports/R4_p2_hygiene.md`
- Изменённые файлы: `js/trips.js`, `index.html`
- Тест-харнесс: `scripts/test_r4_hygiene.js`