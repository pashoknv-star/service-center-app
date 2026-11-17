# V8-T1 — правки `AGENTS.md` (вносит координатор; воркеру запись в `AGENTS.md` запрещена)

Задача: `t_99b4f917`. Причина: новый сьют `tripsform` (`scripts/test_trips_v8_form.js`, 99 проверок) и запись в `BASELINE` (`scripts/verify_all.sh`).

## 1. Раздел «Verification (Definition of Done)», строка про эталон (`AGENTS.md:33`)

**Было:**

```
- Эталон числа тестов — массив `BASELINE` в `scripts/verify_all.sh` (единственный источник; на 2026-11-16 (V6-1..V6-6, V6.2, V6.3-1..V6.3-4, V7): smoke 84, e51 23, e52 41, hygiene 19, trips 7, tasks 66, tasksn8n 27, tasksatt 24, tasksui 334, tasksmx 79, taskscal 220, director 101, refs 28, tasklink 43). Тестов меньше эталона — FAIL. Добавили тесты — поднять `BASELINE` в том же коммите.
```

**Стало:**

```
- Эталон числа тестов — массив `BASELINE` в `scripts/verify_all.sh` (единственный источник; на 2026-11-17 (V6-1..V6-6, V6.2, V6.3-1..V6.3-4, V7, V8-T1): smoke 84, e51 23, e52 41, hygiene 19, trips 7, tripsform 99, tasks 66, tasksn8n 27, tasksatt 24, tasksui 334, tasksmx 79, taskscal 220, director 101, refs 28, tasklink 43). Тестов меньше эталона — FAIL. Добавили тесты — поднять `BASELINE` в том же коммите.
```

## 2. Таблица сьютов — новая строка (после строки `trips frontend`)

```
| tripsform (V8-T1) | `bash scripts/verify_all.sh tripsform` (= `node scripts/test_trips_v8_form.js`; реальный headless Chromium по CDP + `php -S` на копии `data/app.db`, ~50 с) | `RESULT: 99 passed, 0 failed`; без Chromium (`CHROME_BIN` или `~/.cache/ms-playwright/chromium_headless_shell-1208/…`) сьют падает, а не пропускается |
```

## 3. Раздел «Test» → «JS-сьюты (frontend)» (необязательно)

Добавить строку: `- tripsform (форма командировки, V8-T1): node scripts/test_trips_v8_form.js` — сьют запускается целиком одной командой, как остальные.
