# V8-T2 — правки `AGENTS.md` (вносит координатор; воркеру запись в `AGENTS.md` запрещена)

Задача: `t_02fec59e`. Причина: новый сьют `tripsstatus` (`scripts/test_trips_v8_status.js`, 96 проверок) и запись в `BASELINE` (`scripts/verify_all.sh`).

## 1. Раздел «Verification (Definition of Done)», строка про эталон

**Было** (`... (V6-1..V6-6, V6.2, V6.3-1..V6.3-4, V7, V8-T1, V8-T3): smoke 84, ..., tripsform 99, ..., tasklink 43)`):

в списке сьютов есть `tripsform 99` и `emptasks 34`, `tripsstatus` отсутствует.

**Стало:** дописать `V8-T2` в перечень задач и `tripsstatus 96` в список — например `... trips 7, tripsform 99, tripsstatus 96, tasks 66, ...`.

## 2. Таблица сьютов — новая строка (после строки `tripsform (V8-T1)`)

```
| tripsstatus (V8-T2) | `bash scripts/verify_all.sh tripsstatus` (= `node scripts/test_trips_v8_status.js`; реальный headless Chromium по CDP + `php -S` на копии `data/app.db`, ~50 с) | `RESULT: 96 passed, 0 failed`; механика «прогноз → подтверждена»: кнопки «На подтверждение»/«Подтвердить», место назначения обязательно для подтверждения (сервер: 400 `location_required`), заявки `trip_requests` по одной на участника без дублей и потерь, права admin/supervisor/viewer; без Chromium падает, а не пропускается |
```
