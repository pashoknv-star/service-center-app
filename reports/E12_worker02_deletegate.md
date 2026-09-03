# E6-T2 — Гейт «Удалить» только при trip.id (новая КМ из матрицы)

- **Task:** t_20a063e7 (worker: sd_worker_02)
- **Дата:** 2026-09-03
- **Файл:** `js/trips.js`, строка 1167 (функция `renderTripFormInPanel`)
- **Статус:** ВЫПОЛНЕНО — все проверки PASS

## Изменение

Единственная правка по объёму задачи — тернарник кнопки «Удалить» в
`.trip-panel-actions` дополнен проверкой `trip.id` + краткий комментарий
(внутри `${/* */}` интерполяции, чтобы не попадать в результирующий HTML):

```diff
--- a/js/trips.js
+++ b/js/trips.js
@@ -1164,7 +1164,7 @@
         <div class="trip-panel-actions">
             <button type="button" class="trip-btn trip-btn-secondary" onclick="window.Trips.closeTripForm()">Отменить</button>
             <button type="button" class="trip-btn trip-btn-primary" onclick="window.Trips.saveTrip('${trip && trip.id ? trip.id : 'null'}')" ${isViewer ? 'disabled' : ''}>Сохранить</button>
-            ${trip && user && canDeleteTrip(trip, user) ? `<button type="button" class="trip-btn trip-btn-danger" onclick="window.Trips.handleDeleteTripClick('${trip.id}')">Удалить</button>` : ''}
+            ${/* Err6 fix: "Удалить" только при редактировании (trip.id); из матрицы приходит псевдо-trip без id */ trip && trip.id && user && canDeleteTrip(trip, user) ? `<button type="button" class="trip-btn trip-btn-danger" onclick="window.Trips.handleDeleteTripClick('${trip.id}')">Удалить</button>` : ''}
           </div>
```

Смежные изменения в дифе файла (строка 1166 `saveTrip(...)`, блок `saveTrip`,
`findEmployeeIdByName`) — это принятая задача E6-T1 другого воркера, в объём
T2 не входят и не менялись.

Запрещённые зоны не тронуты: `showTripModal` (~1293, вторая кнопка «Удалить»),
CSS, пик-режим, index.html.

## Верификация (E2E, реальные клики/события через CDP :9222, dev http://127.0.0.1:8096, admin-сессия)

### AC1 — Матрица → новая командировка: ровно «Отменить» + «Сохранить»

Сценарий реальными кликами: выбор строки сотрудника (`.name-col` click,
`getSelectedEmployeeIds() == [1]`) → клик ячейки (`.day-cell-data`, popup
`.show == true`) → клик пункта попапа `[data-type="trip"]` → форма в панели.

DOM-проверка `.trip-panel-actions`:

```json
{
  "panelFormVisible": true,
  "panelTitleValue": "Командировка",
  "panelActions": ["Отменить", "Сохранить"],
  "exactlyCancelSave": true,
  "deleteButtonsInPanel": 0,
  "deleteButtonsInWholePanelForm": 0,
  "participantRows": 1,
  "PASS": true
}
```

Кнопок с текстом «Удалить» во всей форме панели — 0. **AC1 PASS.**

### AC2 — Редактирование существующей КМ: «Удалить» присутствует (admin)

`openTripModal(trip_id)` (тот же путь `renderTripFormInPanel`, что и из
списка — trip с реальным id). Создана тестовая КМ «E6T2 temp trip» через
реальный матричный флоу + `saveTrip(null)`:

```json
{
  "targetId": "trip_6a99a5bad303a0.50764495",
  "panelFormVisible": true,
  "panelActions": ["Отменить", "Сохранить", "Удалить"],
  "deletePresent": true,
  "PASS": true
}
```

Реальный клик по кнопке «Удалить» (confirm застаблен на true, зафиксирован
вызов `confirm('Удалить командировку?')`):

```json
{
  "confirmLog": ["Удалить командировку?"],
  "panelClosedAfterDelete": true,
  "targetStillInApi": false,
  "PASS": true
}
```

После клика: панель закрылась, `GET api/trips.php` больше не содержит
удалённый id. Тестовая КМ полностью удалена с сервера (данных за собой не
оставляет). **AC2 PASS.**

### AC3 — Синтаксис

```
$ node --check js/trips.js
NODE_CHECK_OK   (exit code 0)
```

### Консоль браузера

0 ошибок (перехват `error` / `unhandledrejection` на весь прогон):
`consoleErrors: []`.

## Гигиена

- Тесты создавали/удаляли данные через API → `data/app.db` изменился.
  Выполнено `git checkout -- data/app.db` — восстановлена.
- Итоговый `git status`: `M js/trips.js` (гейт T2 + принятые правки T1),
  `?? reports/E12_worker01_savefix.md` (отчёт T1), DB чистая.
- Отчёт: `reports/E12_worker02_deletegate.md`.

## Вывод

Все три критерия приёмки выполнены. В НОВОЙ командировке из Матрицы отпусков
кнопка «Удалить» не рендерится (ровно «Отменить» + «Сохранить»), в
редактировании существующей КМ для admin «Удалить» на месте и работает.
