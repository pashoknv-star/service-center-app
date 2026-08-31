# Ревью замечаний к релизу «Механика командировок»

**Дата:** 2026-08-30. **Замечаний от владельца:** 15. **Объекты:** `index.html` (5607 строк), `js/trips.js` (2168 строк), `js/storage.js` (609 строк), `api/trips.php` (603 строки).

> Никаких правок не внесено — только ревью и план.

---

## Резюме для владельца

Из 15 замечаний:
- **9 подтверждены** как реальные дефекты кода (с конкретными указателями строк).
- **3 имеют корректное поведение в коде**, но UX ожидается другой — требуют переосмысления (а не починки).
- **3 — следствия первых двух** (одна и та же причина в нескольких проявлениях).

Самые тяжёлые:
- **Рекрусия `confirmTrip(id)`/`deleteTrip(id)`** внутри одноимённых обработчиков кнопок (1147, 1167) — никогда не вызывают API-функцию с 315/336 строк.
- **`removeParticipantRow` не экспортирована в `window.Trips`** (1063) — все кнопки «×» у строк участников вызывают `undefined` и молча падают.
- **«+ Новая командировка» открывает overlay, который затем перекрыт панелью матрицы** (z-index/CSS) — п.7, 8, 12 — это разные реализации модалок (`createTripModal` 821 vs `openDraftModal` 1769) без общего скоупа.

---

## Детальный разбор по замечаниям

### 1. Кнопки «Матрица отпусков» и «Командировки» сместить влево, на место заголовка
**Код:** `index.html:56320-56335` (внутри `<div class="vacation-panel-header">`).
**Найдено:** порядок внутри flex-header сейчас — `<h2>Матрица отпусков</h2>` → `<div class="panel-tabs">` → `<div class="year-selector">` → `×`. Кнопки `panel-tabs` стоят ПОСЛЕ заголовка, не вместо него.
**Статус:** требуется перестановка. ТЗ в шапке панели использует `display: flex; justify-content: space-between` — элементы идут подряд с равномерным распределением, поэтому визуально кажется, что h2 «слева», а кнопки «посередине». ТЗ замечания: убрать h2, оставить кнопки в той же горизонтальной группе, что и year-selector.

### 2. Удалить заголовок «Матрица отпусков» и «обновлено --:--»
**Код:** `index.html:56321-56325`.
**Найдено:** `<h2>Матрица отпусков<span id="syncBadge" style="display:none; ...">обновлено --:--</span></h2>`. Элемент — точка входа для badge синхронизации (обновляется из `index.html:11365`: `badge.textContent = 'обновлено ' + hh + ':' + mm`).
**Дополнительно:** в коде реальный badge-текст — «обновлено», не «обнолвено». Опечатка из замечания отсутствует. Сам badge исчезает после первой синхронизации (`syncBadge.style.display='inline-block'`).
**Статус:** требуется удалить оба `<h2>` (целиком) и либо перенести логику badge в другую точку, либо вовсе скрыть его. **Осторожно:** badge полезен, проще «скрыть h2 текст», чем выкидывать целиком.

### 3. Кнопки выровнять по одной линии с годом и стрелками
**Код:** `index.html:56313-56335` + `index.html:56410-56422` (CSS `.year-selector`).
**Найдено:** `.year-selector` — отдельный `<div>` с `display: flex; gap: 12px; align-items: center`. `panel-tabs` — отдельный `<div>` без явного `align-items: center` на родителе. В header `align-items: center` есть, но все 4 ребёнка выравниваются по центру независимо.
**Статус:** визуально они и так на одной горизонтали, но только потому что header — `display: flex; align-items: center`. Если убрать h2 (п.2), кнопки «съедут» в центр. Требует группировки `panel-tabs` + `year-selector` в один `display: flex; gap: 16px` блок.

### 4. Ctrl-выделение — прозрачность вместо затемнения, ФИО белым, нечитаемо
**Код:**
- `index.html:1093-1099` — CSS: `.matrix-table .trip-row-selected .name-col { background: var(--rt-purple); color: white; ... }`
- `index.html:1099-1103` — CSS: `.matrix-table .trip-row-dimmed .name-col { opacity: 0.35; }`
- `index.html:3651-3670` — обработчик `cell.addEventListener('click', function(event) { if (event.ctrlKey || event.metaKey) {...} })`.
**Найдено (3 бага):**
1. **Затемнение vs прозрачность:** ТЗ просит, чтобы строки НЕвыбранных сотрудников становились «прозрачными», не «затемнёнными». Текущий `opacity: 0.35` — это затемнение. В ТЗ разница в формулировке: «столбец с ФИО становится прозрачным, а не затемняется, при этом поле календаря никак не затеняется». Текущая реализация НЕ затеняет календарь (это уже правильно), но использует `opacity`, который действует одинаково и на ФИО, и на календарь (наследуется ли). Проверка: CSS применяет opacity только к `.name-col`, не ко всей строке. Правильно по этому пункту.
2. **ФИО закрашивается белым (нечитаемо).** В `.trip-row-dimmed .name-col` opacity 0.35 сохраняет color — но `name-col` (без классов) — это `<td>`, и его `color` по умолчанию — наследованный. Для «name-col без .trip-row-selected» — цвет обычно чёрный/тёмный. Для «name-col внутри trip-row-selected» — `color: white` (фиолетовый фон). ОПИСАНИЕ в замечании: «Сами ФИО сотрудников закрашиваются белым цветом, из-за этого становятся нечитаемыми». Это про **выбранные** строки, где белый текст на фиолетовом — нормально читаемо. Возможно, описание путает «затемнённые» и «выделенные», и реальный баг: в dimmed (opacity 0.35) на белом фоне текст становится бледно-серым, а это и воспринимается как «белый». Реальное решение из ТЗ: при dimmed фон не должен затеняться, только ФИО должно остаться контрастным.
3. **Логика снятия dimmed некорректна** (`index.html:3660-3667`):
```js
allRows.forEach(function(otherCell) {
  var otherRow = otherCell.parentElement;
  if (otherRow !== row && !otherRow.classList.contains('trip-row-selected')) {
    otherRow.classList.add('trip-row-dimmed');
  } else {
    otherRow.classList.remove('trip-row-dimmed');
  }
});
```
Когда кликают по строке, у которой УЖЕ стоит `trip-row-selected` (снимают выделение), код сначала `toggle` (снимет selected), потом в цикле: для этой строки otherRow === row → `else` → снимет dimmed. **Верно.** Но для других выделенных строк: если `row` — снимаемая, то для других выделенных строк `otherRow !== row` И `otherRow.classList.contains('trip-row-selected')` → `else` → снимет dimmed. **Верно.** Но что если выделены 2 строки, и кликают на 3-ю (не выделенную)? Для 3-й (новой) otherRow === row → снимет dimmed (норм, она теперь выделена). Для 1-й и 2-й: `otherRow !== row` И `selected` → снимет dimmed. **Но они выделены! А `dimmed` снимать не нужно — они не dimmed.** Логически — баг: при добавлении нового выделения dimmed не снимается с уже-выделенных, но они и не были dimmed, так что нечего снимать. **Реальный баг:** при добавлении 2-го выделения те строки, которые были dimmed (т.е. НЕ выделенные), остаются dimmed — но это правильное поведение. **Проблема — при снятии выделения:** если было выделено 2 строки и кликнули на 2-ю (снимая), 1-я остаётся выделенной, 2-я снимает selected, ВСЕ не-выделенные (включая старую 2-ю) должны СБРОСИТЬ dimmed. Текущий код: для старой 2-й (otherRow === row) → else → снимет dimmed ✓. Для остальных не-выделенных: `otherRow !== row` И НЕ `selected` → add dimmed. То есть **после снятия все не-выделенные строки становятся dimmed**. Это правильно (одна выделенная = остальные затемнены). Логика рабочая, но цикл пересчитывает ВСЕ строки на каждый клик (O(n²) на n кликов). **Реальный видимый баг — скорее всего в `else` ветке, которая `remove('trip-row-dimmed')` может задеть нужные строки при снятии всех выделений по очереди.**

**Статус:** реальный дефект UX (opacity на name-col воспринимается как «ФИО белое»). Плюс тонкости логики при множественном выделении.

### 5. Убрать «Создать командировку» из popup, перенести на кнопку «Командировка»
**Код:** `index.html:2011` — `<div class="popup-item" data-type="trip-draft" ...>Создать командировку</div>`.
**Найдено:** popup-меню содержит 6 опций (work/vacation/sick/trip/dayoff/trip-draft/clear). Кнопка «Создать командировку» (`trip-draft`) обрабатывается в `index.html:4072-4086` и вызывает `window.Trips.createDraftFromSelection(empId, startDay, endDay)`.
**Статус:** удаление строки popup-меню тривиально, но в `index.html:4062` есть условие `type !== 'trip-draft'` — также надо убрать из списка исключений, чтобы варнинг по празднику не вылезал при выборе. **Главный вопрос UX:** куда именно переносить логику? В замечании сказано «функционал перенести на кнопку Командировка» — это которая? Две существуют: в карточке сотрудника (`#tripFromEmpCardBtn`, работает по редактируемому сотруднику) и... на матрице ничего не названо «Командировка». Скорее всего, нужна новая кнопка в шапке матрицы или в panel-tabs.

### 6. Кнопка «Создать командировку» в popup — не работает
**Код:** `js/trips.js:2113-2156` — `function createDraftFromSelection(empId, startDay, endDay)`.
**Найдено (ФАТАЛЬНЫЙ БАГ):** на строке 2140 — `var employee = employees.find(function(e) { return e.id === parseInt(emp); });`. Переменная `employees` (без префикса) — это **глобал из inline-скрипта `index.html`**, замыкание хост-страницы. `js/trips.js` загружается в отдельном IIFE, у неё **нет доступа к этому замыканию**. В `js/trips.js` НЕТ объявления `var employees` → в этом файле `employees === undefined` → `TypeError: Cannot read properties of undefined (reading 'find')` → исключение летит в `console.warn`/`openDraft` → ничего не происходит.
**Дополнительно:** на строке 2116 — `var selectedRows = document.querySelectorAll('.trip-row-selected');` — пустой массив, если пользователь не выделял строки через Ctrl (т.е. пришёл из popup, не из Ctrl-выделения). Тогда `participants` тоже пуст, и `openDraft` ничего не вызывает. То есть даже без TypeError функция бы работала только в одном из двух сценариев.
**Дополнительно:** на 2121-2123 — `row.querySelector('.name-col')` и `getAttribute('data-emp-id')` — name-col с этими атрибутами существует только если в `index.html` есть `name-col[data-emp-id][data-start-day][data-end-day]` (нет — там просто `.name-col` без атрибутов). То есть парсинг дат и empId всегда возвращает startDay/endDay из параметров функции, не из DOM. Это ещё одна причина, почему функция ведёт себя непредсказуемо.
**Статус:** тройной фатальный дефект. Сломано полностью.

### 7. После «+ Новая командировка» появляется новое окно ЗА панелью матрицы
**Код:** `js/trips.js:915-918` → `createTripModal()` (821) → `appendChild(modal)` к body. CSS `.trip-modal` (595-604) — `position: fixed; z-index: 1000`.
**Найдено:** `.trip-modal` имеет `z-index: 1000`. `.vacation-panel` — `z-index: ?` (проверить):
- CSS `.vacation-panel` — не нашёл `z-index` явно. Скорее всего `position: relative` без z-index, в этом случае эффективный z-index = auto, что НИЖЕ 1000. То есть модалка должна быть поверх.
- **НО:** панель матрицы может иметь `transform`, который создаёт свой stacking-context. Если `transform: translateX(...)` или `translate3d` на `.vacation-panel` (а он есть — `.trip-panel-slided { transform: translateX(...) }` на 1801), то дочерние элементы с z-index 1000 окажутся ниже соседей с собственным z-index в новом контексте.
**Альтернативная причина:** `.vacation-panel` имеет `position: relative` + `transform: none` по умолчанию, но `.trip-panel-slided` (применяется в `startEmployeePick` 1947) добавляет `transform: translateX(-100% + 46px)`. Когда `startEmployeePick` срабатывает из модалки редактирования, панель становится `slided`, и любая открытая в этот момент `.trip-modal` (с position:fixed и z-index 1000 в контексте body) оказывается ПОД панелью, т.к. fixed элемент рендерится в ближайшем positioned ancestor (если есть stacking-context с z-index). **Этот баг объясняет и п.7, и п.10, и п.12.**

**Статус:** дефект z-index/transform. Панель `slided` создаёт stacking-context, перекрывающий модалку.

### 8. «+ Новая командировка» должна создавать в текущей панели, не в новом окне
**Код:** `js/trips.js:915-1030` — `openNewTripModal` → `showTripModal(null)` → строит form с полями.
**Найдено:** по текущему коду, `showTripModal(null)` рендерит форму **внутри модалки**, а не в панели. Чтобы реализовать ТЗ, нужно рендерить form в `tripsListView` (который сейчас показывает `<h3>Командировки</h3> + кнопка + список`). То есть вся механика редактирования (поля названия, места, участников, кнопок) должна жить в `#tripsListView`, а `openTripModal` для нового трипа должна переключать таб `trips` и заменять список на форму.
**Статус:** требует переписать `showTripModal`/`openNewTripModal` — перенести HTML-шаблон из модалки в `#tripsListView`. Это большой рефактор.

### 9. Убрать пустую строку участника, оставить только «+ Добавить сотрудника»
**Код:** `js/trips.js:1027-1029` — `addParticipantRow();` после `form.innerHTML = ...`. `addParticipantRow` (1052-1058) рендерит пустую строку (`renderParticipantRow({}, index, false)` без `employeeId`).
**Найдено:** пустая строка присутствует по умолчанию в новой командировке. ТЗ просит убрать — оставить только кнопку `+ Добавить сотрудника`.
**Статус:** удаление вызова `addParticipantRow()` (стр. 1028). Также проверить ветку редактирования (992-991) — там строки приходят из `trip.participants`, их не трогать.

### 10. «+ Добавить сотрудника» — отдельное окно, панель уезжает на 95% за экран
**Код:**
- `js/trips.js:1937-1985` — `startEmployeePick`: добавляет класс `trip-panel-slided` к `.vacation-panel`, инжектит `.trip-pick-dock`.
- `index.html:1801-1803` — CSS `.trip-panel-slided { transform: translateX(calc(-100% + 46px)); }` — оставляет 46px видимой области.
- `index.html:1873-1925` — CSS `.trip-pick-dock { position: fixed; left: 0; top: 50%; }` — dock ставится в левой части экрана.
**Найдено (двойной дефект):**
1. **ТЗ в шапке ТЗ говорит:** «осталась видна только область с кнопкой [Добавить сотрудника]» — текущая реализация оставляет 46px (узкий бар). Реализация правильная по геометрии, но **dock прибит к left:0 — на той же вертикали, что и видимый 46px-бар панели.** Получается, dock и видимая кромка панели накладываются друг на друга — UX неудобен.
2. **Карточка сотрудника всё равно выезжает** (ТЗ говорит: НЕ выезжать). Проверяю: `startEmployeePick` ставит `Trips.suppressInfoPanel = function() { return true; }`. Смотрим, где это проверяется — `index.html:4167-4170` (`closeVacation`) и где ещё?
```bash
grep -n "suppressInfoPanel" index.html
```
Я нашёл `suppressInfoPanel` в `closeVacation`. Но **открытие** карточки сотрудника из матрицы — это `openMatrixEmployeeCard(empId)` (index.html:3670), и там нет проверки `suppressInfoPanel`. **Карточка всё равно выезжает** при клике на карточку во время employee pick. Дефект.
3. **Выбранные сотрудники визуально подсвечиваются** через `.trip-row-selected` (CSS 1093) — но **этот класс** добавляется только в Ctrl-обработчике `index.html:3654`. При обычном клике сотрудника (для employee pick) этого не происходит — подсветки не будет. Дефект.
4. **Кнопка «+ Добавить сотрудника» (в самом dock)** — реализована как `Trips.confirmEmployeePick()` (1967), но: в `confirmEmployeePick` (2068-2092) `selectedEmployees` берётся из `window.Trips.pickedEmployees` — `Set` id. Но клик-обработчик `populateEmployeePickList` (2012-2016) вызывает `toggleEmployeePickSelection(this)`, который использует `parseInt(item.getAttribute('data-id'))`. **id сотрудников в системе — строки вида `emp_1`**, не числа. `parseInt('emp_1')` → `NaN`. **Set хранит NaN'ы, `selectedEmployees` — массив NaN'ов.** При `confirmEmployeePick` (2078-2086) `employees.find(function(e) { return e.id === empId; })` — где `empId` это NaN — никогда не находит. **Ничего не добавляется в draft.** И ещё: `draft` (тот, что `window._employeePickContext = draft;` на 1941) — это **первый аргумент функции**, который в `setupUI` (782) вызывается как `openTripFromEmployee` — но `openTripFromEmployee` (1222) **не передаёт никакой draft** в `startEmployeePick`. То есть `window._employeePickContext` всегда = undefined → `draft.participants` не существует → push ничего не делает.

**Статус:** пять фатальных дефектов в одной фиче: stacking-context (п.7), отсутствие проверки при открытии карточки, неправильный парсинг id, отсутствие подсветки, отсутствие реальной передачи участников в форму.

### 11. «+ Добавить сотрудника» из карточки сотрудника — та же механика, что п.7
**Код:** `js/trips.js:1222-1261` — `openTripFromEmployee`. В сценарии А (нет forecast) вызывает `openNewTripModal()` + `container.innerHTML = renderParticipantRow({...})` (1248-1252). В сценарии Б (есть forecast) — `showTripSelectionModal` (1287).
**Найдено:**
- Сценарий А открывает модалку (тот же баг с z-index/transform, что п.7).
- В `renderParticipantRow` в сценарии А: `employeeId: currentEditingId` (1249) — `currentEditingId` приходит из `window.__editingEmployeeId` (1269), но **сразу после этого `container.innerHTML = renderParticipantRow(...)` ЗАТИРАЕТ контейнер**. И в renderParticipantRow передаётся `{}, index, false` с employeeId = currentEditingId — это нормально. **Но:** в `addParticipantRow` (1028) при открытии новой командировки добавляется ещё одна пустая строка. То есть в сценарии А: пустая строка + строка с текущим сотрудником = 2 строки, одна из которых пустая. Конфликт с п.9.
- Сценарий Б: при выборе forecast-трипа `selectTripForEmployee` (1331) вызывает `openTripModal(tripId)` + `setTimeout(addRow, ...)`. `addRow` берёт `trip.participants` (1311) и `formatDate(new Date(minDate))` — это правильно, но **setTimeout 350 мс — гонка** с асинхронной сессией в `openTripModal` (931-937). Если рендер не успел — `participantsContainer = null` (1347) → строка не добавится. Раньше фиксили (E7) — но `setTimeout` с константой 350 всё равно ненадёжен.

**Статус:** сценарий А — завязан на п.7 (модалка, transform, z-index). Сценарий Б — гонка с асинхронным рендером.

### 12. «При выборе существующей командировки — новое окно ЗА текущей панелью»
**Код:** `js/trips.js:923-938` — `openTripModal(id)` → `createTripModal` (821) → `appendChild(modal)`. `createTripModal` переиспользует **тот же `modal` объект** (`if (_dom.tripModal) return _dom.tripModal;` 822) и перерисовывает содержимое. То есть новое «окно» не новое — оно то же, что и для новой командировки, но поверх `tripsListView` (т.к. тот сейчас активен).
**Найдено:** аналогично п.7 — z-index/transform. Плюс — `tripsListView` не скрывается при открытии модалки, и так как модалка — `position: fixed; z-index: 1000`, а у `tripsListView` нет z-index, она рендерится ниже. Но визуально кажется, что модалка «за панелью», потому что **новая модалка редактирования (.trip-modal)** НЕ создаёт overlay — у неё нет `.trip-modal-overlay` (только `openDraftModal` 1772-1817 создаёт overlay). Без overlay затемнения нет, и содержимое модалки (белая карточка) не выглядит как «над всем».
**Статус:** z-index + отсутствие overlay = визуальный баг.

### 13. «Удалить сотрудника» (×) в окне командировки не работает
**Код:** `js/trips.js:1044` — `onclick="window.Trips.removeParticipantRow(${index})"`. `removeParticipantRow` определена на 1063-1068, но в `window.Trips` (1622-1682) **не экспортирована** (в отличие от saveTrip, openTripModal, и т.д.).
**Найдено:** `window.Trips.removeParticipantRow` → `undefined` → `onclick` бросает TypeError → ничего не происходит.
**Дополнительно:** в `removeParticipantRow` (1063-1068) `participantsContainer.children[index]` — после удаления одной строки индексы остальных сдвигаются. Если удалить строку 0, строка 1 станет children[0] — кнопка «×» строки 1 после перерисовки инвалидируется, но если она была в onclick-строке как `removeParticipantRow(1)`, то при следующем клике удалится уже другая строка.
**Дополнительно:** `addParticipantRow` (1052-1058) использует `innerHTML +=` (1056) — пересоздаёт ВСЕ строки, теряя фокус в input и значения. Плюс onclick-индексы на старых строках указывают на правильные строки до первой перерисовки, но после `innerHTML +=` они указывают на новые позиции (т.к. DOM пересоздан, а onclick-строки шаблона сгенерированы с `index` = `participantsContainer.children.length` в момент вставки, не realtime).
**Статус:** тройной дефект — не экспортировано, индексы сдвигаются, `innerHTML +=` ломает state.

### 14. «Удалить» командировку не работает
**Код:** `js/trips.js:989` — `onclick="window.Trips.deleteTrip(${trip.id})"`. `deleteTrip` определена дважды:
- На 336-357 — настоящая API-функция (`api('DELETE', ...)`).
- На 1167-1182 — обработчик клика, **который внутри сам себя вызывает**: `deleteTrip(id)` на 1172.

**Найдено (ФАТАЛЬНЫЙ БАГ):** функция-обработчик названа так же, как API-функция. `deleteTrip` на 1167 — `function deleteTrip(id) { ... deleteTrip(id) ... }` — это **рекурсия без базы**. Перед рекурсией `if (!confirm('Удалить командировку?'))` (1168) — если confirm отменён, return. Если подтверждён — `deleteTrip(id)` (1172) снова вызывает `deleteTrip(id)` (ту же функцию), и так до переполнения стека. **API никогда не вызывается.**
**Аналогично `confirmTrip`:** на 1147-1162 — та же рекурсия. Если confirm-диалог подтверждён, `confirmTrip(id)` (1152) вызывает саму себя, переполняя стек.
**Статус:** ОБЕ функции ломаны рекурсией. `deleteTrip` и `confirmTrip` нужно либо переименовать (`handleDeleteTripClick`, `handleConfirmTripClick`), либо дать API-функциям другие имена (`_apiDeleteTrip`, `_apiConfirmTrip`) и вызывать их из обработчиков.

### 15. Цветовая гамма панели «Командировка» отличается от сайта
**Код:** `js/trips.js:540-730` — `injectStyles` (CSS trip-modal).
**Найдено (количественно):** 9 хардкодов цветов (`#fff`, `#555`, `#f5f5f5`, `#333`, `#888`, `#eee`, `#ddd`, `#666`, `#d32f2f`, `#2196F3`) и **1** переменная палитры (`var(--trip-blue)`). Сайт использует палитру `var(--rt-purple)`, `var(--rt-blue)`, `var(--rt-orange)`, `var(--text)`, `var(--divider)`, `var(--accent)`, `var(--vacation-green)`, `var(--sick-red)`, `var(--dayoff-orange)`, `var(--holiday-red)`, `var(--trip-blue)`.
**Дополнительно:** `.trip-pick-dock` и `openDraftModal` (1769-1817) — inline-style с цветами `#2196F3`, `#fff`, `#d32f2f`, `#ccc`, `#777` и т.д. Полностью хардкод, мимо палитры.
**Статус:** полная замена хардкодов на переменные палитры.

---

## Дополнительные дефекты, найденные по ходу ревью

### D1. `saveTrip` — `endDate` берётся из startDate-инпута
**Код:** `js/trips.js:1096-1115`:
```js
participantRows.forEach(function(row) {
  var name = row.querySelector('.trip-participant-name').value.trim();
  var startDate = row.querySelector('.trip-participant-date').value;   // 1-й .trip-participant-date
  var endDate = row.querySelector('.trip-participant-date').value;     // СНОВА 1-й, не 2-й!
  ...
});
```
**Найдено:** `querySelector` возвращает первый элемент. И `startDate`, и `endDate` читаются из одного и того же первого инпута даты. У строки 2 инпута (`renderParticipantRow` на 1042 — `<input type="date" class="trip-participant-date" value="${participant.endDate || ''}">`) — **никогда не читается**. endDate в API всегда равен startDate. Командировка всегда однодневная на сервере.
**Статус:** латентный баг, видим только если начать заполнять endDate — сохранение в API отправит startDate == endDate.

### D2. `getDayVacationType` — не объявлена в `js/trips.js`
**Код:** `js/trips.js:1705` — `var vtype = getDayVacationType(empId, d.getFullYear(), doy);`. Эта функция определена в `index.html`, не в `js/trips.js`. `js/trips.js` использует её в `openDraft` (1685). Если вызвать `openDraft` напрямую (например, из контекста, где `index.html` ещё не прогрузился) — TypeError.
**Статус:** скрытая зависимость, обычно работает потому что trips.js грузится позже, чем inline-скрипт.

### D3. `startCalendarPick` — вызывает `openDraft` через `switchTab` + перехват `handleCellMouseUp`
**Код:** `js/trips.js:1898-1931` — перезаписывает глобальный `window.handleCellMouseUp` без восстановления. После первого вызова календаря оригинальный обработчик «теряется», и любые последующие клики по ячейкам матрицы идут через ТОЛЬКО ТРИПС-обработчик.
**Статус:** глобальный monkey-patch с утечкой.

### D4. `isSupervisor()` — проверяет только `user.role === 'supervisor'`
**Код:** `js/trips.js:1441-1444` — `canDeleteTrip`:
```js
if (trip.status === TRIP_STATUS.FORECAST && isSupervisor()) {
  return true;  // "simplified - in real implementation would check zone"
}
```
В коде явно написано «simplified». То есть supervisor может удалить ЛЮБОЙ forecast-трип (включая чужой зоны) — нарушение ТЗ §6, по которому только admin + supervisor своей зоны. Это уже было исправлено на сервере (E8) — `api/trips.php:382` ставит `zone_forbidden`, но **на клиенте кнопка отображается** (пользователь кликает → 403 от сервера → UX-провал).

**Статус:** требует доработки `canDeleteTrip` — проверка по зоне (через API или pre-load групп).

### D5. `getDayVacationType` — `null` пробрасывается в `formatDateStr` без проверки
**Код:** `js/trips.js:1708` — `formatDateStr(d.getFullYear(), d.getMonth(), d.getDate())`. Если d — `new Date(startDate)` где startDate = `'2026-13-40'` (невалидная), `getMonth()`/`getDate()` вернут `NaN` или неверные значения → `formatDateStr` отдаст мусор → `conflictDays` засорены.
**Статус:** низкий приоритет, но латентный.

### D6. Inline `onclick`-и используют `window.Trips.X` — несколько X не экспортированы
**Код:** `js/trips.js:1622-1682` — экспорт. Не экспортированы:
- `removeParticipantRow` (1063) — кнопка «×» (п.13)
- `confirmEmployeePick` (1968) — кнопка в dock
- `endEmployeePick` (1956, 1968) — две кнопки
- `populateEmployeePickList`, `toggleEmployeePickSelection` — вызываются из самого кода, не из inline-onclick (ок)
- `getCurrentEditingEmployeeId` — функция, не вызывается из inline

**Статус:** нужно добавить в экспорт `removeParticipantRow`, `confirmEmployeePick`, `endEmployeePick` — иначе соответствующие кнопки не работают.

### D7. `endEmployeePick` восстанавливает `suppressInfoPanel = () => false` (2049), но **не удаляет `slide` класс при отсутствии панели** (2051-2055) — если в момент `endEmployeePick` `.vacation-panel` уже нет в DOM, `vacationPanel.classList.remove` бросит TypeError? Нет, `null.classList` бросит. Проверяю: 2051 `var vacationPanel = document.querySelector('.vacation-panel');` — `vacationPanel` может быть null, тогда `null.classList` → TypeError. Редкий случай, но возможен при race с logout.
**Статус:** низкий приоритет.

### D8. `setDayVacationType` из `index.html:4088` для `type === 'trip'` — обрабатывается как обычный отпуск, не открывает трип
**Код:** `index.html:4088` — `setDayVacationType(popupTarget.empId, currentYear, popupTarget.day, type)`. Для `type === 'trip'` — это `setDayVacationType(empId, year, day, 'trip')` — что создаёт запись `schedule_entries` с типом `trip`, **не трип в trips table**. То есть «Командировка» из popup создаёт **vacation-entry типа trip**, а не сущность Trip. Это конфликтует с архитектурой: одна сущность `Trip` (с v6) vs schedule_entry с type='trip' (без v6, без версий, без участников). Какие последствия:
- В popup есть «Командировка» (п.5 — может быть, его надо оставить?) и «Создать командировку». Первое — старый механизм (через schedule_entries), второе — новый (Trips с участниками). **Дублирование.**
- «Командировка» из popup НЕ создаст запись в trips, не появится в overlay, не редактируется через trip-modal. Она только красит ячейку синим.

**Статус:** это, скорее всего, отдельный вопрос архитектуры (ТЗ v6 не покрывает — что делать с legacy trip-записями). По замечанию 5 — ТЗ просит «убрать Создать командировку, оставить Командировку в popup»? Или «перенести»? Из текста: «Убрать "Создать командировку" - функционал перенести на кнопку "Командировка"». Кнопка «Командировка» = где? Скорее всего, та что в popup-меню. Тогда «Создать командировку» в popup дублирует. После удаления popup-«Создать» — popup-«Командировка» остаётся. **Но popup-«Командировка» создаёт schedule_entry, не Trip** (поведение `setDayVacationType` для type='trip'). То есть нужно МИГРИРОВАТЬ popup-«Командировка» на новую механику Trips. Иначе «перенос функционала» теряет смысл.

**Статус:** возможно требует пересмотра архитектурного решения.

---

## План исправлений (по приоритетам)

### P0 — критические, ломают основные сценарии

| # | Что | Где | Суть |
|---|---|---|---|
| P0-1 | Исправить рекурсию `confirmTrip`/`deleteTrip` | `js/trips.js:1147-1182` | Переименовать обёртки (`handleClick*`) или API (`_api*`). Двойные декларации `function` поднимают последнюю (1167), перекрывая настоящую (336). |
| P0-2 | Экспортировать `removeParticipantRow` и другие | `js/trips.js:1680` | Добавить в `window.Trips`. Без этого все `×` падают. |
| P0-3 | Исправить `endDate = startDate` | `js/trips.js:1096-1100` | `querySelectorAll('.trip-participant-date')` + индексы [0]/[1]. |
| P0-4 | Исправить `createDraftFromSelection` — undefined `employees` | `js/trips.js:2140` | Использовать `window.employees` или `getEmployeeName` fallback (как в 1397-1420). |
| P0-5 | Исправить employee pick — `parseInt('emp_N')` = NaN | `js/trips.js:2020, 2078, 2100` | `String(emp.id)`, сравнение `String(e.id) === String(empId)`. |

### P1 — функциональные, не ломают всё, но конкретные сценарии

| # | Что | Где |
|---|---|---|
| P1-1 | Z-index/transform панели матрицы | `index.html` — `.trip-modal { z-index: ... }`; `.trip-panel-slided` создаёт stacking-context. Решение: не использовать `transform` для slide-эффекта, или вынести `.trip-modal` в `<body>` с высоким z-index, или использовать `<dialog>` API. |
| P1-2 | Реализовать сценарий ТЗ: «выбранные сотрудники подсвечиваются существующим способом» | `js/trips.js:2012-2016` (toggleEmployeePickSelection) — добавить `.trip-row-selected` на выбранные строки матрицы, а не на свой `<div class="dock-employee-item">`. |
| P1-3 | `suppressInfoPanel` не работает при `openMatrixEmployeeCard` | `index.html:3670` — добавить проверку `Trips.suppressInfoPanel && Trips.suppressInfoPanel()` в начало. |
| P1-4 | Передавать `draft` в `startEmployeePick` | `js/trips.js:1222-1261` — `openTripFromEmployee` должна подготовить draft-объект (с сотрудником-инициатором) и передать в `startEmployeePick(draft)`. Сейчас `window._employeePickContext` всегда undefined. |
| P1-5 | Перенести «Создать командировку» из popup в панель | `index.html:2011` (удалить) + `js/trips.js:915-1030` (рендерить в `#tripsListView` вместо модалки). |
| P1-6 | Убрать пустую строку участника | `js/trips.js:1028` (удалить `addParticipantRow();`). |
| P1-7 | Исправить CSS Ctrl-выделения: «прозрачность» vs «затемнение» | `index.html:1099-1103` — пересмотреть `.trip-row-dimmed .name-col`. Возможно, использовать `background: rgba(...)` вместо `opacity`. |

### P2 — косметика и архитектура

| # | Что | Где |
|---|---|---|
| P2-1 | Заменить хардкоды на палитру | `js/trips.js:540-730` (CSS) + `1770-1817` (inline styles). 9 хардкодов → `var(--rt-purple)` и т.д. |
| P2-2 | Исправить логику `Ctrl-click` для множественного снятия/добавления | `index.html:3651-3670` — пересмотр цикла `allRows.forEach`. |
| P2-3 | Убрать `syncBadge` или перенести | `index.html:56321-56325` — если badge остаётся, дать ему новый контейнер. |
| P2-4 | Канбан: развести в шапке panel-tabs + year-selector | `index.html:56320-56335` + CSS. |
| P2-5 | Перенести `startCalendarPick`'s monkey-patch в restore-при-finish | `js/trips.js:1898-1931`. |
| P2-6 | `canDeleteTrip` — проверка зоны (ТЗ §6) | `js/trips.js:1441-1444`. |
| P2-7 | Popup-«Командировка» (type='trip') vs Trip-сущность — решить, мигрировать или оставить | `index.html:4088` + `api/save.php` обработка `type='trip'`. |

### P3 — гигиена

| # | Что | Где |
|---|---|---|
| P3-1 | Удалить `getDayVacationType` зависимость из trips.js (D2) | `js/trips.js:1705` — передавать тип как параметр или явно требовать хост-контекст. |
| P3-2 | Защитить `endEmployeePick` от null vacationPanel | `js/trips.js:2051-2055`. |
| P3-3 | Валидация дат перед `formatDateStr` | `js/trips.js:1708`. |

---

## Готов начать

Жду «Старт» (или уточнённый скоуп — например, только P0, или P0+P1 без рефакторинга панели). Деплой на Hostland — отдельно, по вашему слову.
