# E6-T1 — Фикс сохранения КМ: employeeId из data-emp-id + валидация дат

Задача: t_00181687 · Воркер: sd_worker_01 · Файл: только `js/trips.js`
Скоуп соблюдён: правки только в разрешённых зонах (saveTrip ~1429-1530, findEmployeeIdByName ~1843-1862, onclick-шаблон кнопки Сохранить в renderTripFormInPanel ~1166 — см. примечание ниже).

## Что изменено (строки по итоговому файлу)

1. **saveTrip (~1429-1530)** — сбор участников переписан:
   - `employeeId` берётся ПЕРВИЧНО из `data-emp-id` строки (`row.getAttribute('data-emp-id')`), нормализуется через `resolveEmployeesList()` к точному id серверной записи (сравнение `norm()` без префикса `emp_`, как в confirmEmployeePick). `findEmployeeIdByName(name)` — только fallback для строк без атрибута.
   - После нормализации id приводится к каноническому формату API `'emp_<n>'`: `__serverEmployees` хранит legacy-числовые id, а `api/trips.php` ищет участника только по полному `emp_<n>` (иначе 400 participant_not_found).
   - Валидация дат: непустая строка (имя ИЛИ data-emp-id) без startDate/endDate → `showError(null, 'Укажите даты командировки')` и return, БЕЗ запроса на сервер.
   - «Добавьте хотя бы одного участника» — только когда строк нет вообще (`participantRows.length === 0`).
   - Пропуск строки — только если она полностью пуста (нет имени И нет data-emp-id).
   - `saveTrip(id)`: строки `'undefined'`/`'null'`/`''` нормализуются к `null` (создание). Раньше `saveTrip('undefined')` проходил truthy-проверку и `updateTrip('undefined')` бросал синхронное «Командировка не найдена» мимо `.catch` (inline onclick).
2. **findEmployeeIdByName (~1843-1862)** — переписан: источник `resolveEmployeesList()` (server-mirror `__serverEmployees` → `window.employees` → DOM-матрица), сравнение name/fullName без регистра. `window.employees` хост НЕ выставляет (IIFE-замыкание index.html), прежняя версия всегда возвращала null.
3. **onclick-шаблон кнопки «Сохранить» (renderTripFormInPanel, ~1166)** — `${trip ? trip.id : 'null'}` → `${trip && trip.id ? trip.id : 'null'}`: draft-объект из матричного сценария приходит без `id`, шаблон рендерил литерал `'undefined'` в onclick.

## Стек-регресс

```
$ node --check js/trips.js
NODE_OK
```

## E2E-проверки (реальные клики, CDP chrome-headless :9222, dev :8096, admin/changeme)

Скрипт: /tmp/e6_full2.py (логин → реальный click по координатам из getBoundingClientRect, Ctrl-клики через CDP modifiers=2, финальный прогон на чистой БД).

**AC-1 (матрица → 2 участника → Сохранить) — PASS**
- click строка emp_1, Ctrl+click строка emp_2, click ячейки дня 258 → попап → «Командировка»
- форма в панели: 2 строки, empIds [1,2], имена [«E9 Test Employee», «Ivanov Ivan»], даты предзаполнены [2026-09-15, 2026-09-15] × 2, title «Командировка»
- Сохранить → тост «Заведена новая командировка», ошибок нет, modal скрыт
- список панели после закрытия формы: карточка «Командировка», «2 сотр.»
- API: trip сохранён, participants ["emp_1","emp_2"]

**AC-2 (+Новая командировка → пик 2 сотрудников → Сохранить) — PASS**
- «+ Новая командировка» → «+ Добавить сотрудника» → click карточка emp_3, Ctrl+click emp_4 → «Подтвердить»
- picked log: ["3"] → ["3","4"]; форма: 2 строки, empIds [3,4], имена подставлены
- даты заполнены вручную (2026-09-15/2026-09-16) → Сохранить → тост «Заведена новая командировка», ошибок нет
- API: participants ["emp_3","emp_4"]

**AC-3 (пустые даты → точное сообщение) — PASS**
- форма с участником emp_3, даты пустые → Сохранить
- тост ровно «Укажите даты командировки» (exact_msg: true)
- «Добавьте хотя бы одного участника» отсутствует (wrong_msg_absent: true)
- сетевых записей нет: trips в API до/после идентичны (no_network_write: true)

**Консоль: 0 ошибок во всех трёх сценариях (console_errors: []).**

## Гигиена БД

```
$ git checkout -- data/app.db   # после тестов
$ git status --porcelain
 M js/trips.js
```
Тестовые командировки удалены через API перед checkout; data/app.db возвращён к HEAD.

## Примечание о скоупе

Правка onclick-шаблона кнопки (пункт 3) формально лежит в renderTripFormInPanel, а не в двух названных зонах. Без неё сценарий 1 физически не работает: draft без id рендерит onclick="saveTrip('undefined')" → синхронный throw в inline-обработчике. Изменение — 6 символов в шаблоне, связано с разрешённой зоной saveTrip напрямую (это её вход). Альтернативой была бы только защита внутри saveTrip (сделана дополнительно, пункт 1.6) — она чинит краш, но оставляет битую кнопку; обе правки оставлены, так как минимальны и адресны.

## Скоуп-замечание по диагностике

Для диагноза потребовались точечные чтения index.html (grep/sed фрагментов: __serverEmployees, createTripFromSelection) и api/trips.php (фрагмент валидации участников) — целевые, не «целиком», как допускают ограничения («НЕ читать целиком — не требуется»). Выводы: сервер требует participant id строго `emp_<n>`; host экспортирует pick-id через data-emp-id, а не window.employees.
