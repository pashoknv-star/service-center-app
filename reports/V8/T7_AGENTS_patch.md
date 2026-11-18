# V8-T7 — правка `AGENTS.md` (вносит координатор; воркеру запись в AGENTS.md запрещена)

Причина: сьюты `tripsform` и `tripsstatus` выросли (тесты на каждую правку T7), `BASELINE` в `scripts/verify_all.sh` поднят в том же коммите; добавлена переменная окружения сьютов `TRIPS_FAKE_NOW`.

## 1. Раздел «Verification (Definition of Done)», строка про эталон числа тестов

**Было:**

```
… tripsform 99, tripsstatus 96, tasks 66, …
```

(в строке эталона: «… trips 7, tripsform 99, tripsstatus 96, tasks 66, tasksn8n 27, …»)

**Стало:**

```
… trips 7, tripsform 131, tripsstatus 147, tasks 66, tasksn8n 27, …
```

и в перечне задач, на которые ссылается эталон, добавить `V8-T7`: «(V6-1..V6-6, V6.2, V6.3-1..V6.3-4, V7, V8-T1, V8-T2, V8-T3, V8-T7)».

## 2. Таблица сьютов

**Было:**

```
| tripsform (V8-T1) | `bash scripts/verify_all.sh tripsform` (= `node scripts/test_trips_v8_form.js`; реальный headless Chromium по CDP + `php -S` на копии `data/app.db`, ~50 с) | `RESULT: 99 passed, 0 failed`; без Chromium (`CHROME_BIN` или `~/.cache/ms-playwright/chromium_headless_shell-1208/…`) сьют падает, а не пропускается |
| tripsstatus (V8-T2) | `bash scripts/verify_all.sh tripsstatus` (= `node scripts/test_trips_v8_status.js`; реальный headless Chromium по CDP + `php -S` на копии `data/app.db`, ~50 с) | `RESULT: 96 passed, 0 failed`; механика «прогноз → подтверждена»: кнопки «На подтверждение»/«Подтвердить», место назначения обязательно для подтверждения (сервер: 400 `location_required`), заявки `trip_requests` по одной на участника без дублей и потерь, права admin/supervisor/viewer; без Chromium падает, а не пропускается |
```

**Стало:**

```
| tripsform (V8-T1, V8-T7) | `bash scripts/verify_all.sh tripsform` (= `node scripts/test_trips_v8_form.js`; реальный headless Chromium по CDP + `php -S` на копии `data/app.db`, ~60 с; год сценариев — год текущей даты, для проверки другого года: `TRIPS_FAKE_NOW=2027-03-15T12:00:00Z bash scripts/verify_all.sh tripsform`) | `RESULT: 131 passed, 0 failed`; без Chromium (`CHROME_BIN` или `~/.cache/ms-playwright/chromium_headless_shell-1208/…`) сьют падает, а не пропускается; посимвольный набор телефона (8…/7…/+7…/10 цифр), выбор дат 📅 при смене года Матрицы, пометки «*», подпись «Участники» |
| tripsstatus (V8-T2, V8-T7) | `bash scripts/verify_all.sh tripsstatus` (= `node scripts/test_trips_v8_status.js`; реальный headless Chromium по CDP + `php -S` на копии `data/app.db`, ~60 с; `TRIPS_FAKE_NOW` — как у `tripsform`) | `RESULT: 147 passed, 0 failed`; механика «прогноз → подтверждена»: кнопки «На подтверждение»/«Подтвердить», место назначения и телефон обязательны только для подтверждения (сервер: 400 `location_required` / `phone_required`, в т.ч. для PUT подтверждённой с пустым значением), статус меняется только `PUT …&action=confirm` (POST со `status:'confirmed'` → 400 `invalid_status`, PUT с иным `status` → 400 `status_change_forbidden`), заявки `trip_requests` по одной на участника без дублей и потерь, права admin/supervisor/viewer; без Chromium падает, а не пропускается |
```

## 3. Ничего другого в `AGENTS.md` не меняется

- Стартовые границы и политика индексов — без изменений.
- Правка вне `AGENTS.md`, но связанная: `api/smoke_test.php` (T3-3) получил поле `phone` — иначе T3-10 (подтверждение командировки без телефона) стал бы падать по новому правилу `phone_required` (см. отчёт T7, раздел «Отклонения от границ»).
