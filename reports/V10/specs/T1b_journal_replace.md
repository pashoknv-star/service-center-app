# V10-T1b — Транспорт: закрыть обход неизменяемости журнала через `INSERT OR REPLACE`

Сначала прочитай `reports/V10/specs/00_COMMON.md`, `reports/V10/specs/CONTRACT.md` (раздел про журнал) и `reports/V10/ADR_DB.md` §5. Это короткий корректирующий фикс к принятой V10-T1 (карточка `t_6dec04ad`).

Workspace: worktree `/home/hermes/wt/v10-t1b` (ветка `v10-t1b-journal-fix`, от main). Работай и коммить только там; main и чужие worktree не трогай. Исполнитель: sd_worker_01. Не пушить, не деплоить, `AGENTS.md` не править.

## Проблема (доказана координатором на `:memory:`-копии схемы, `api/schema.sql:457,461`)

Триггеры `trg_transport_journal_no_update` (BEFORE UPDATE) и `trg_transport_journal_no_delete` (BEFORE DELETE) не ловят `INSERT OR REPLACE INTO transport_journal(id, …)` / `REPLACE INTO` с уже существующим `id`: запись `1|a|orig` была заменена на `1|HACK|forged` без ошибки. Требование владельца «журнал не правится и не удаляется» выполнено не полностью. Вариант фикса из ADR_DB §5: третий триггер `BEFORE INSERT ON transport_journal WHEN NEW.id IS NOT NULL AND EXISTS (SELECT 1 FROM transport_journal WHERE id = NEW.id)` → `RAISE(ABORT, 'transport_journal is append-only')`. Проверь, закрывает ли он обход для `INSERT OR REPLACE`, `REPLACE INTO`, `INSERT OR IGNORE` (молчаливый пропуск допустим, но не перезапись), `INSERT … ON CONFLICT DO UPDATE` (upsert) — если нет, найди работающий вариант и докажи тестом.

## Объём

1. Добавить защиту в `api/schema.sql` (`CREATE TRIGGER IF NOT EXISTS …`) и в путь миграции `api/db.php`, чтобы она появилась и в свежей БД, и в уже мигрированной до v15 (dev-копии), идемпотентно. `SCHEMA_VERSION` **не** поднимать (v15 не выкатывалась на прод), если не найдёшь причину — тогда блок в отчёте и стоп.
2. Тесты в `api/transport_db_test.php`: красные до фикса (REPLACE меняет запись, `INSERT OR REPLACE` и `REPLACE INTO` проходят), зелёные после; позитив — обычный `INSERT` без `id` и с новым `id` работает; UPDATE/DELETE по-прежнему падают; повторная миграция — no-op. Поднять `BASELINE[transportdb]` на число добавленных проверок.
3. Красный прогон — в `reports/V10/T1b_RED_run_before_fix.txt`.
4. Попутно, без расширения объёма: прогони `rg -n "PRAGMA recursive_triggers|REPLACE INTO|INSERT OR REPLACE" api -g '*.php'` и перечисли в отчёте места, где такая конструкция может писать в `transport_journal` (ожидается: нет).

## Границы

Твои файлы: `api/schema.sql`, `api/db.php`, `api/transport_db_test.php`, `scripts/verify_all.sh` (только `BASELINE[transportdb]`), `reports/V10/T1b_*`. Не трогать: остальной код `api/`, `js/`, `index.html`, `AGENTS.md`, `data/app.db`.

## Приёмка

- `bash scripts/verify_all.sh transportdb` зелёный, затем полный `bash scripts/verify_all.sh` → `GATE: PASS` (если браузерный `tripsform` красный под нагрузкой — перезапусти его отдельно и приведи оба прогона в отчёте; другие красные сьюты — стоп и блок).
- Отчёт `reports/V10/T1b_REPORT.md`: что изменено, `file:line`, результаты красного/зелёного прогонов, вывод проверки обхода для каждого из четырёх вариантов вставки.
- Коммит с Kanban-id карточки в сообщении.

## Индекс кода

```
Индекс кода (CodeGraph/CODEMAP/rg) — навигация, не истина. Класс задачи: 🟡.
- Перед правкой читай реальный файл (локальный контекст) и сверяй с rg по проекту.
- «Нет вызовов/не используется/impact пуст» ≠ доказательство; для delete/rename/сигнатур — rg по всему репо.
- Триггеры ручной проверки: динамика, DI/события, HTML-строки/window.*, одноимённые символы, JS↔PHP по URL, конфиги/SQL/миграции.
- Индекс устарел после merge/rebase/смены ветки — не доверяй; CODEMAP не покрывает api/*.php.
- Утверждения в квитанции — с file:line и источником (индекс / файл / тест). При 3 расхождениях индекса с файлом — прекрати его использовать и сообщи.
- Приёмка только по git diff, verify_all.sh (GATE таблица целиком), тестам.
```
