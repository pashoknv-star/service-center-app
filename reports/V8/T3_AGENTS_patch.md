# V8-T3 — правка AGENTS.md (применяет координатор; воркер AGENTS.md не редактировал)

Причина: добавлен сьют `emptasks` (`scripts/test_emp_tasks_btn.js`, 34 проверки), подключён в `scripts/verify_all.sh` (`BASELINE[emptasks]=34`, `ALL_SUITES` — после `director`).

## Раздел «Verification (Definition of Done)», строка «Эталон числа тестов» (`AGENTS.md:33`)

Было:
```
… taskscal 220, director 101, refs 28, tasklink 43). Тестов меньше эталона — FAIL.
```
Стало (при слиянии сохранить числа других сьютов актуальными на момент merge):
```
… taskscal 220, director 101, refs 28, tasklink 43, emptasks 34). Тестов меньше эталона — FAIL.
```

## Таблица сьютов (раздел Verification) — добавить строку

| Сьют | Команда | Критерий |
|---|---|---|
| emptasks (V8-T3) | `bash scripts/verify_all.sh emptasks` (или `node scripts/test_emp_tasks_btn.js`) | `RESULT: 34 passed, 0 failed`; кнопка «Задачи» в карточке сотрудника: admin → форма новой задачи на сотрудника, supervisor → список только для чтения; старый путь «Командировка из карточки» удалён |
