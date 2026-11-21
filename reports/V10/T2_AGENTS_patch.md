# V10-T2 — патч для `AGENTS.md` (применяет координатор)

`AGENTS.md` воркер не правит. Предлагаемые изменения — «было / стало».

## 1. Раздел «Verification (Definition of Done)» — абзац про эталон

**Было** (фрагмент): «Эталон числа тестов — массив `BASELINE` в `scripts/verify_all.sh` (единственный источник; … tasklink 43). Тестов меньше эталона — FAIL.»

**Стало** (добавить в конец абзаца): «Сьюты из массива `OPT_SUITES` (на 2026-11-21 — `transport`, V10-T2) в `ALL_SUITES` не входят и запускаются только явно (`bash scripts/verify_all.sh transport`); они могут быть намеренно красными до реализации (`transport` — до V10-T5), их `BASELINE` — число проверок в зелёном состоянии. Координатор переносит такой сьют в `ALL_SUITES` при приёмке реализации.»

## 2. Таблица сьютов — новая строка (после `tasklinks (V9-T1)`)

```
| transport (V10-T2) | `bash scripts/verify_all.sh transport` (= `php api/transport_test.php`; временная копия БД через `SC_APP_DB`, `php -S` с 4 обработчиками `PHP_CLI_SERVER_WORKERS`, `data/app.db` не трогается; ~20 с на зелёной реализации) | `RESULTS: 157 passed, 0 failed`, `DB intact: YES`; тесты API заявок/назначений/предупреждений по `reports/V10/specs/CONTRACT.md` (права admin/supervisor_zone0/supervisor_zone1/viewer, статусы, назначения, водители, шаг 15 мин, `dry_run`/`confirm_token`, журнал, атомарность); **до V10-T5 ожидаемо красный и в общий gate не входит** (`OPT_SUITES`) |
```

## 3. Строка «на 2026-11-18 (…)» с перечнем эталонов

Когда `transport` перейдёт в `ALL_SUITES` (приёмка T5), добавить в перечень эталонов `transport 157` (число может измениться, если T5/приёмка потребуют addendum к тестам — тогда поднять `BASELINE` в том же коммите).

## 4. Раздел «Test» (pitfall, по желанию)

Добавить строку: «`PDO::inTransaction()` не видит ручной `exec('BEGIN IMMEDIATE')` (PHP 8.3.6): не защищать `COMMIT/ROLLBACK` этим условием — вести собственный флаг транзакции (`api/transport_*.php`, V10-T5).»

`PROGRESS.md` в T2 не менялся (в границах задачи его нет; параллельные задачи T1/T3/T4 тоже правят «Current State» — координатору свести при слиянии): строка для Current State — «V10-T2: сьют `transport` написан (157 проверок), красный до V10-T5; коммит — см. отчёт».
