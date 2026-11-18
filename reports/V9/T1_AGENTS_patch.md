# V9-T1 — патч для `AGENTS.md` (применяет координатор; воркер `AGENTS.md` не правит)

## 1. Раздел «Verification (Definition of Done)» — эталон числа тестов

**Было** (фрагмент строки «Эталон числа тестов…»):

```
… smoke 84, e51 23, e52 41, hygiene 19, trips 7, tripsform 131, tripsstatus 147, tasks 66, tasksn8n 27, tasksatt 24, tasksui 334, tasksmx 79, taskscal 220, director 101, emptasks 34, refs 28, tasklink 43).
```

**Стало:** добавить `tasklinks 37` (после `tasksatt 24`) и в скобке с датой — `V9-T1`:

```
… smoke 84, e51 23, e52 41, hygiene 19, trips 7, tripsform 131, tripsstatus 147, tasks 66, tasksn8n 27, tasksatt 24, tasklinks 37, tasksui 334, tasksmx 79, taskscal 220, director 101, emptasks 34, refs 28, tasklink 43).
```
(и `V9-T1` в перечне фаз в начале скобки: «…V8-T7, V9-T1»).

## 2. Таблица сьютов — новая строка (после строки `emptasks`)

```
| tasklinks (V9-T1) | `bash scripts/verify_all.sh tasklinks` (= `php api/tasks_links_test.php`; временная копия БД через `SC_APP_DB`, `php -S` на ней, `data/app.db` не трогается) | `RESULTS: 37 passed, 0 failed`, `DB intact: YES`; схема v14 (`tasks.links_text`, `task_links`), миграция v13→v14 на копии, парсер токенов `((ID\|название))`, симметрия/архив/лимиты/права, `?pick=1`, `?related=<id>` |
```

## 3. Раздел «Решения владельца 2026-11-17/18…» → добавить после принятия V9 владельцем (не сейчас)

Только после явного одобрения владельца результатов V9 (правило «Роадмап доработок: фиксация выполнения» — без одобрения не отмечать):

```
## Решения владельца 2026-11-18 (V9 «Задачи: связанные задачи»)
- Связь между задачами одна, симметричная; создаётся вручную из карточки (поле «Связанные задачи» под «Вложениями», ключ `(())`), закрытие/переоткрытие связей не создаёт и не меняет; удалённая (`archived=1`) задача перечёркивается у обеих сторон; клик по ссылке → «Список» со всей цепочкой, текущая задача первой. Подробности и API — `reports/V9/specs/00_COMMON.md`, `reports/V9/T1_REPORT.md`.
```

## 4. «Схема БД»

В любом месте AGENTS/PROGRESS, где указана «Схема БД 13» — **14** (v14 = `tasks.links_text` + `task_links`, V9-T1). В `PROGRESS.md` (Current State) эта правка внесена в коммите V9-T1.
