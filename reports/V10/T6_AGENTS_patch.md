# V10-T6 — патч к `AGENTS.md` («было / стало»), применяет координатор

## 1. Verification → абзац про эталон `BASELINE`

Было: перечень «…С V10-T1: transportdb 112. …» (в актуальном виде — `transportdb 117` после V10-T1b).

Стало: добавить «С V10-T6: transportboard 77».

## 2. Verification → таблица сьютов: новая строка после `transportdb`

```
| transportboard (V10-T6) | `bash scripts/verify_all.sh transportboard` (= `php api/transport_board_test.php`; временная копия БД через `SC_APP_DB`, `php -S` на ней, второе PDO-соединение со счётчиком SQL; `data/app.db` не трогается) | `RESULTS: 77 passed, 0 failed`, `DB intact: YES`; `api/transport_board.php` (доска: базы с ТС, назначения периода, очередь нераспределённых, отсутствия, `can_edit`/`can_move_vehicle`; период ≤ 31 дня включительно; число SQL не зависит от числа назначений) и `api/transport_journal.php` (только admin: фильтры, пагинация, CSV с защитой от формул; ничего не пишет) |
```

Сьют входит в `ALL_SUITES` (в общий gate), в отличие от `transport` (V10-T2, `OPT_SUITES`).

## 3. Pitfall (по желанию, в раздел решений V10)

Браузерные сьюты (`tripsform`, `tripsstatus`, `tasklinksui` …) плавающе падают при параллельном запуске `verify_all.sh` в нескольких worktree (нагрузка CPU; на чистой основе — зелёные). Перед приёмкой гнать gate в тихий момент или перезапускать красный браузерный сьют отдельно.
