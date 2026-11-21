# V10-T1b — закрыт обход неизменяемости журнала `transport_journal` через `REPLACE`

Карточка `t_b66bd648` (исправление к V10-T1 `t_6dec04ad`). Ветка `v10-t1b-journal-fix`, основа `624aa0b`. Без push и деплоя. `SCHEMA_VERSION` = 15 (не менялась). Источник утверждений о коде — файлы на текущем коммите и прогоны тестов.

## 1. Что изменено

| Файл:строка | Изменение |
|---|---|
| `api/schema.sql:470-474` | `CREATE TRIGGER IF NOT EXISTS trg_transport_journal_no_replace BEFORE INSERT ON transport_journal WHEN NEW.id > 0 AND EXISTS (SELECT 1 FROM transport_journal WHERE id = NEW.id) BEGIN SELECT RAISE(ABORT, 'transport_journal is append-only'); END;` (+ комментарий-обоснование, `schema.sql:464-469`) |
| `api/db.php:44-49` | константа `TRANSPORT_JOURNAL_NO_REPLACE_SQL` — тот же DDL (сверяется тестом M3 по `sqlite_master`) |
| `api/db.php:560` | `createTransportSchemaV15()` выполняет её после блока таблиц/триггеров — путь миграции 14→15 |
| `api/db.php:122`, `api/db.php:570-584` | **БД, уже стоящие на v15** (dev-копии): `migrate()` при `current >= SCHEMA_VERSION` вызывает `ensureTransportJournalNoReplaceTrigger()` — один `SELECT` по `sqlite_master`; если таблица журнала есть, а триггера нет — создаёт его. Иначе фикс до таких БД не доходил бы: блок `if ($current < 15)` для них не выполняется, а версию поднимать нельзя. Ошибки (read-only БД, блокировка) логируются и запрос не роняют. Повтор — no-op |
| `api/transport_db_test.php` | M4 (`:286`) — три триггера поимённо; J3 — ожидаемая ошибка теперь `append-only` (раньше `UNIQUE`); M2 — порог числа объектов 16→17; новые сьютовые кейсы JR1 `:520`, JR2 `:548`, JR3 `:570`, JR4 `:590`, M5 `:610` (+5 проверок) |
| `scripts/verify_all.sh:19` | `BASELINE[transportdb]` 112 → 117 |

### Отличие от варианта ADR_DB §5 — условие `NEW.id > 0` вместо `NEW.id IS NOT NULL`
Проверено на SQLite 3.45.1: в `BEFORE INSERT` у вставки **без** `id` значение `NEW.id` равно `-1`. С условием из ADR строка с `id = -1` (её можно добавить обычным `INSERT`) навсегда блокирует все штатные вставки в журнал (`transport_journal_write` начал бы падать) — пробой воспроизведено: «`INSERT … (id,actor) VALUES (-1,'neg')` → затем `INSERT … (actor) VALUES ('after neg')` → ERR append-only». Журнальные `id` (AUTOINCREMENT) всегда > 0, поэтому `NEW.id > 0` защищает все легитимные записи и не создаёт этой блокировки (покрыто JR4). Побочное следствие: запись с `id ≤ 0` — это подделка-добавление, а не перезапись легитимной записи; перезаписать можно только её саму. `NULL > 0` → NULL → условие ложно, так что отдельная проверка `IS NOT NULL` не нужна.

## 2. Проверка обхода по четырём вариантам вставки (существующий `id`, реальная схема из `schema.sql`/`db.php`; кейсы JR1/JR2)

| Вариант | До фикса (красный прогон) | После фикса |
|---|---|---|
| `INSERT OR REPLACE INTO transport_journal(id,…)` | **ПРОШЁЛ**, `actor` стал `HACK_or_replace` — обход | ошибка `SQLSTATE[23000] … transport_journal is append-only`, запись не изменилась (все колонки) |
| `REPLACE INTO transport_journal(id,…)` | **ПРОШЁЛ** (в красном прогоне JR1 перечисляет оба варианта) — обход | то же: ошибка append-only, запись цела |
| `INSERT OR IGNORE …` | молчаливый пропуск, запись не изменена | ошибка append-only (RAISE(ABORT) в триггере не гасится `OR IGNORE`) — строже допустимого «пропуска», запись не изменена |
| `INSERT … ON CONFLICT(id) DO UPDATE SET …` (upsert) | уже закрыт триггером `BEFORE UPDATE` (ADR §5) | ошибка append-only, запись цела; `ON CONFLICT DO NOTHING` — тоже ошибка append-only |

Вывод: предложенный в ADR третий триггер (с поправкой `NEW.id > 0`) закрывает все четыре варианта; поиск другого варианта не потребовался. `recursive_triggers` не включался (глобальную настройку соединения не меняли).

## 3. Красный → зелёный

- Красный прогон до правок `schema.sql`/`db.php` (тесты уже добавлены): `reports/V10/T1b_RED_run_before_fix.txt` — `RESULTS: 112 passed, 5 failed out of 117`. Падают: M4 (триггеров 2, ожидалось 3), J3 (ошибка `UNIQUE`, а не `append-only` — вставка с существующим id шла мимо журнала-триггера), **JR1** (`INSERT OR REPLACE`/`REPLACE` прошли, запись перезаписана), JR4 (`INSERT OR REPLACE` с id=1 прошёл), M5 (на v15-БД нет триггера). Позитивные JR3 и JR2 до фикса зелёные — так и должно быть.
- Зелёный `bash scripts/verify_all.sh transportdb` → `transportdb PASS 117 117`, `GATE: PASS (1 suites)`; прямой вывод `php api/transport_db_test.php` — `reports/V10/T1b_GREEN_transportdb.txt`: `RESULTS: 117 passed, 0 failed out of 117`, `DB intact: YES`.
- Полный `bash scripts/verify_all.sh` — `reports/V10/T1b_GATE_full.txt`: **`GATE: PASS (23 suites)`**, все сьюты на эталоне (в т.ч. `tripsform 131/131`, `tripsstatus 147/147`; перезапуск браузерных сьютов не потребовался), `transportdb 117/117`, `tasklink` — «коммитов 12, с кодом 5, нарушений 0».
- Идемпотентность: M5 — `migrate()` на v15-БД без триггера создаёт его, данные журнала не тронуты, повторный `migrate()` — объекты и данные те же; M2/M3 — миграция 14→15 и повторы дают те же объекты, DDL `db.php` ≡ `schema.sql`.

## 4. `rg -n "PRAGMA recursive_triggers|REPLACE INTO|INSERT OR REPLACE" api -g '*.php'`

Совпадения (сам `transport_journal` в них не фигурирует):
- `api/save.php:12,13,409`, `api/entries.php:15` — комментарии/код про `INSERT OR REPLACE` для `employees`, `schedule_entries`;
- `api/tasks_n8n_test.php:222,632`, `api/tasks_test.php:198,448,468,469,1013` — тесты (`schedule_entries`, `meta`, `holidays`, `employees`);
- `api/transport_db_test.php` — новые кейсы этой задачи (намеренно).
`PRAGMA recursive_triggers` в PHP-коде не встречается. Единственное место записи в `transport_journal` из кода — `api/transport_lib.php:318` (`INSERT INTO transport_journal (ts, actor, …)`, **без `id`**), вызывается из `api/transport_vehicles.php` (`:242,288,328,434,475,502,524`). Вывод: конструкции `REPLACE` в `transport_journal` не пишут (ожидание подтверждено).

## 5. Остаточные риски / замечания
- Триггеры не защищают от `DROP TRIGGER`, `writable_schema`, правки файла БД — как в ADR_DB §5 (требует произвольного SQL или доступа к файлу).
- Дополнительная нагрузка: один `SELECT` по `sqlite_master` на каждый вызов `migrate()` (на каждый запрос API). Если владелец не хочет этого, альтернатива — поднять `SCHEMA_VERSION` до 16 (запрещено карточкой; не делалось).
- `PROGRESS.md` не обновлялся (вне списка файлов карточки) — координатору при приёмке.
