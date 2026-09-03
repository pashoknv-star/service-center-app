# E6-T3 — Ярлык пик-режима: текст 90° снизу вверх, кнопки равные

- **Task:** t_91b8eace (worker: sd_worker_03)
- **Дата:** 2026-09-03
- **Файл:** `js/trips.js`, CSS-блок `.trip-pick-edge-btn` (~865-876)
- **Примечание:** отчёт скомпилирован координатором из лога сессии воркера
  (20260903_220024_66e7b8) + независимой E2E-верификации — воркер не оформил
  файл отчёта сам (зафиксировано в kanban-комментарии).

## Изменение (по логу воркера)

```diff
 .trip-pick-edge-btn {
-  display: block;
-  width: 100%;
-  padding: 8px 4px;
-  white-space: normal;
-  word-wrap: break-word;
+  width: 40px;
+  height: 120px;
+  white-space: nowrap;
+  writing-mode: vertical-rl;
+  transform: rotate(180deg);
+  display: flex; align-items: center; justify-content: center;
 }
```

`writing-mode: vertical-rl` + `rotate(180deg)` = вертикальный текст с чтением
СНИЗУ ВВЕРХ (замена требования E5 «текст 0°», отменённого владельцем в «Ошибках 6»).

## Независимая верификация координатора (E2E, реальные клики, CDP :9222)

| Проверка | Результат |
|---|---|
| Кнопки [Подтвердить, Отменить] в столбик | PASS |
| Равные размеры обеих кнопок | **40×120 / 40×120** PASS (±1px) |
| Одна строка текста (range rects) | [1,1] PASS — переноса нет |
| Поворот 90° | `writing-mode: vertical-rl` + `transform: matrix(-1,0,0,-1,…)` (=rotate 180°) PASS |
| Чтение снизу вверх (h > w) | PASS |
| Клик «Отменить» возвращает панель / «Подтвердить» с 0 выбранных — alert | PASS (S2/G-сценарии харнесса) |

`node --check js/trips.js` — OK. Полный фазовый прогон E6: 16/16, TOTAL_FAIL=0.

## Смежное (координатор)

`scripts/test_e51_pick_geometry.js`: ассерт E5 «no text rotation» заменён на
обратный («vertical-rl + rotate(180deg)») — требование 0° отменено владельцем.
