# V10-T8 — патч к `AGENTS.md` («было / стало»), применяет координатор

## 1. Verification → абзац про эталон `BASELINE`

Добавить «С V10-T8: transportboardui 134».

## 2. Verification → таблица сьютов: новая строка после `tasklinksui`

```
| transportboardui (V10-T8) | `bash scripts/verify_all.sh transportboardui` (= `node scripts/test_transport_board_ui.js`; реальный headless Chromium по CDP + `php -S` на копии `data/app.db`, ~75 с; скриншоты — `TRANSPORTBOARDUI_SHOTS=<каталог>`) | `RESULT: 134 passed, 0 failed`; вкладка «Транспорт» (`#tabTransport`, `#transportView`, `js/transport.js`, `window.Transport`), доска «День / Неделя» (группы баз, полосы назначений, очередь нераспределённых, отсутствия, чужие заявки), перенос ТС между базами (admin и viewer: перетаскивание и меню «Переместить в базу…», подтверждение, `VERSION_CONFLICT`; supervisor — без управления), точка расширения `Transport.openForm(ctx)` для T9, поллинг, экранирование (`<img onerror>`), 375/1280 без горизонтального скролла; без Chromium падает, а не пропускается |
```

## 3. Раздел «Решения владельца 2026-11-21 (V10 «Транспорт»…)» — одной строкой

Было: нет.
Стало: «UI «Транспорт» (V10-T8): вкладка в панели рядом с «Задачи»; клики в окнах переноса ТС (они в `body`) гасят всплытие `click`, иначе глобальный «клик вне панели» в `index.html` закрывает панель. Подмена формы заявки — присвоением `window.Transport.openForm` (T9).»
