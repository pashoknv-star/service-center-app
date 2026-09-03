# E11 / E5-1 — Геометрия пик-панели «Добавить сотрудника» (worker_01)

Задача: t_ce8dc6f4. Дата: 2026-09-02.
Репозиторий: /home/hermes/service-center-app (workspace dir-типа).

## Что изменено

### 1. js/trips.js — startEmployeePick: убран sticky (~2460-2467)
- УДАЛЕНА строка `vacationPanel.style.position = 'sticky';` (была 2464).
- Панель остаётся `position:fixed`; слайд делается ТОЛЬКО классом `trip-panel-slided`
  → панель не выпадает из fixed-слоя, layout страницы не пересчитывается,
  основное поле с зонами не сдвигается и не режется.

### 2. js/trips.js — startEmployeePick: контейнер с двумя кнопками (~2470-2495)
- Вместо одиночной кнопки «✓ Добавить сотрудников» создаётся КОНТЕЙНЕР
  `div.trip-pick-edge`, append в `document.body` (НЕ внутрь панели — панель
  уезжает полностью).
- Внутри две кнопки столбиком, текст горизонтальный (0°, rotate нет):
  - «Подтвердить» (`trip-pick-edge-btn trip-pick-edge-btn-primary`) → `confirmEmployeePick()`;
  - «Отменить» (`trip-pick-edge-btn trip-pick-edge-btn-secondary`) → `endEmployeePick()`.
- Обе функции экспортированы: js/trips.js:2137-2138 (проверено).

### 3. js/trips.js — injectStyles: CSS .trip-pick-edge (~844-890)
- `.trip-pick-edge`: `position:fixed; left:0; top:50%; transform:translateY(-50%);
  width:56px; z-index:1150; display:flex; flex-direction:column; gap:8px;`
  белый фон, рамка `var(--divider)`, скругление справа, тень.
- `.trip-pick-edge-btn-primary`: фон `var(--rt-purple)`, hover — `color-mix(... 85%, black)`.
- `.trip-pick-edge-btn-secondary`: `rgba(119,0,255,0.06)` / `var(--text)` (как .trip-btn-secondary).
- Имя класса `.trip-pick-edge` СОХРАНЕНО — guard вне-кликов index.html:4239
  (`.btn, .trip-btn, .trip-pick-edge`) продолжает исключать ярлык из закрытия панелей.

### 4. index.html — правило слайда (~1811-1820)
- `aside.vacation-panel.trip-panel-slided`: было `transform: translateX(calc(-100% + 46px)) !important`,
  стало:
  ```css
  left: 0;
  transform: translateX(-100%) !important;
  transition: transform 0.25s ease;
  ```
- `left: 0` добавлен осознанно: базовый `.vacation-panel` имеет `left: 3px`
  (index.html:667). Без обнуления после `translateX(-100%)` осталась бы щель
  3px (rect.right = 3 > 0) — рамка торчала бы из-за края.

### 5. endEmployeePick (~2584-2601) — поведение сохранено
- По-прежнему снимает `trip-panel-slided` и удаляет `.trip-pick-edge` через
  `querySelector('.trip-pick-edge') → .remove()` — работает и для нового контейнера.
- Null-guard D7 (панель может отсутствовать) сохранён.
- `vacationPanel.style.position = ''` оставлено: безвредная очистка inline-остатков
  старых сессий (sticky больше никогда не ставится).

Не тронуто (по условию): ctrl-клик обработчик (~2507+), confirmEmployeePick (~2600+),
шаблоны форм, guard index.html (~4239).

## Геометрия (расчёт)
- Панель: `width:88vw`. В slided: `left:0` + `translateX(-100%)`. Процент translate
  считается от border-box панели → `rect.right = 0` при ЛЮБОМ вьюпорте (критерий
  `right <= 0` выполнен строго), панель невидима целиком, включая рамку.
- Ярлык: fixed, `left:0`, ширина 56px (в допустимом коридоре 50-64px),
  z-index 1150 — выше основного контента (слои: matrix header 20, trip-modal 1000,
  панель 2100, но панель полностью за краем), вертикально центрирован.
- Layout: панель `fixed` — из потока не выпадает; header/основное поле не сдвигаются
  (дельта top до/после слайда = 0 по построению, подтверждено отсутствием
  inline-position-манипуляций в коде).

## Проверки (выполнены, реальный вывод)

| Проверка | Результат |
|---|---|
| `node --check js/trips.js` | OK |
| `grep style.position js/trips.js` | только очистка `style.position = ''` (endEmployeePick); `= 'sticky'` отсутствует |
| Правило в index.html | `left: 0; transform: translateX(-100%) !important;` — `calc(-100% + 46px)` удалён |
| `node scripts/test_e51_pick_geometry.js` (новый harness, DOM-shim) | 23 passed, 0 failed — статика index.html + прогон startEmployeePick (fixed сохранён, класс, контейнер из 2 кнопок, текста, CSS-геометрия), «Отменить» → end, «Подтвердить» (пусто) → alert + pick живёт, «Подтвердить» (выбор) → участник добавлен + end + контейнер снят |
| `node scripts/test_r4_hygiene.js` (регрессия) | 19 passed, 0 failed |
| `php api/smoke_test.php` | 76/76 PASS, DB intact: YES |

Примечание: прогон smoke изменяет dev-`data/app.db`; после тестов файл откачен к
HEAD (`git checkout -- data/app.db`), рабочее дерево — только целевые файлы.

## Ограничения / передача
- Полноценный реальный-клик E2E (CDP, живой браузер) — за координатором, как
  указано в задаче. Harness покрывает структуру/логику, но не реальный рендер.
- Новый harness: `scripts/test_e51_pick_geometry.js` (pure Node, без зависимостей,
  по образцу `scripts/test_r4_hygiene.js`) — можно запускать в CI/регресс.

## Изменённые файлы
- `js/trips.js` (injectStyles CSS-блок; startEmployeePick)
- `index.html` (правило `aside.vacation-panel.trip-panel-slided`)
- `scripts/test_e51_pick_geometry.js` (новый, верификационный)
- `reports/E11_worker01_geometry.md` (этот отчёт)
