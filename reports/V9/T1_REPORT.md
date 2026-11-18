# V9-T1 — Связанные задачи: схема v14, API, сьют `tasklinks`

Kanban `t_f1a7ff61`, исполнитель sd_worker_01, `main`, 2026-11-18. Не пушилось, не деплоилось, `AGENTS.md` не правился (патч — `reports/V9/T1_AGENTS_patch.md`). Все `file:line` — на рабочем дереве перед коммитом (источник: файл; индекс кода не использовался).

## 0. Итог

| Пункт ТЗ | Статус | Где |
|---|---|---|
| 1. Схема v14 | сделано, миграция проверена на копиях БД | `api/db.php:35`, `:376–393`; `api/schema.sql:247`, `:301–315` |
| 2. Запись `links_text` (POST/PUT) | сделано | `api/tasks.php:1150–1152`, `:1190–1192` (POST), `:1538–1548`, `:1575`, `:1615–1618` (PUT); логика — `api/tasks_links.php` |
| 3. Чтение `links_text`/`links[]`/`links_n` | сделано, `links[]` — и в списке (решение §3) | `api/tasks.php:347–350`, `:360–372` (`tasks_build_many`) |
| 4. `?pick=1` | сделано | `api/tasks.php:949–964` |
| 5. `?related=<id>` | сделано | `api/tasks.php:968–999`; BFS — `api/tasks_links.php:283–` |
| 6. Sync клиентов | разобран (§4): `updated_at` второй стороны обновляется, `version` — нет | `api/tasks_links.php:171–` |
| 7. Не сломать | close/reopen/DELETE не трогают `task_links`; повторы/FR-10 — как раньше; пути копирования задач в `api/` нет | тесты C1–C3 |

Красный прогон: `reports/V9/T1_RED_run_before_fix.txt` — тот же файл теста на коде `HEAD` `f354a15` (до моих правок; `git archive` в scratch): **1 passed, 36 failed** (тест C3 — «в `tasks.php` нет copy/duplicate» — истинен и до реализации). Зелёный: `tasklinks` **37 passed, 0 failed, DB intact: YES**. Полный gate — `GATE: PASS (21 suites)` (§7).

## 1. Схема v14

- `tasks.links_text TEXT` — `ALTER … ADD COLUMN` под проверкой `PRAGMA table_info` (`addColumnIfNotExists`, `api/db.php:378`); в `schema.sql` колонка — последняя в `CREATE TABLE tasks` (порядок колонок на свежей и мигрированной БД совпадает, тест M1/M2).
- `task_links(task_a, task_b, created_at, created_by)`, `PRIMARY KEY (task_a, task_b)`, `CHECK (task_a < task_b)` (каноническая пара), FK обеих сторон на `tasks(id) ON DELETE CASCADE`, индекс `idx_task_links_b (task_b)` (по `task_a` покрывает PK). Только `IF NOT EXISTS`.
- `SCHEMA_VERSION` 13 → 14 (`api/db.php:35`), блок `if ($current < 14)` в `applyIncrementalMigrations`.
- SQL без возможностей новее SQLite 3.8 (`CHECK`, `PRIMARY KEY`, `CREATE INDEX IF NOT EXISTS`, `ALTER TABLE ADD COLUMN`).

### Что проверено на копиях БД

1. **Тест M1** (в сьюте): копия `data/app.db` (dev-БД, v6) → `migrate()` → v14; колонки `tasks`, `task_links`, индекс; `CHECK` (обратная пара, самосвязь), PK-дубль, FK-нарушение — отклоняются; `CASCADE` по `tasks`; повторный `migrate()` — снимок всех таблиц (кроме `meta`/`audit_log`) идентичен, `integrity_check = ok`.
2. **Тест M2** (в сьюте, отдельный процесс `php`, как на проде): копия dev-БД → v14 → откат до состояния v13 (`DROP INDEX/TABLE task_links`, `DROP COLUMN links_text`, `meta=13`) + данные (сотрудник, задача v=4 с описанием, архивная задача, исполнитель, чек-лист, повтор) → миграция `13>14`; прежние 15 колонок `tasks` и все прочие таблицы — побайтово те же; `links_text` у старых задач `NULL`; повтор `14>14` и «ложная 13» при существующих колонке/таблице (`13>14`) — без ошибок, снимок не меняется; `integrity_check ok`, `foreign_key_check` пуст; `CASCADE` на мигрированной копии.
3. **Ручной прогон на настоящей v13** (не имитации): копия `data/app.db` → мигрирована кодом `HEAD` (`git archive`) `6>13` (настоящие v13-таблицы, `task_attachments`, `task_occurrences`), добавлены 2 задачи (v=3 и v=1), исполнитель, чек-лист, повтор → мигрирована новым кодом `13>14`: колонка добавлена, прежние 15 колонок задач **IDENTICAL**, число строк `employees/schedule_entries/trips/users` **IDENTICAL**, `integrity_check ok`, `foreign_key_check` 0, повтор `14>14` — 2/1/1/1 строки на месте.
4. **Откат кода**: старый код (`HEAD`, v13) на БД v14 — `GET` списка 200, `POST` создания 201, `PUT` 200 (лишняя колонка/таблица ему не мешают; `migrate()` у старого кода — `14 >= 13`, ничего не делает). Данные связей при этом остаются.
5. `data/app.db` не тронут: «DB intact: YES» в каждом прогоне сьюта; `git status` — без `data/app.db`.

## 2. API: контракт

Общее: чтение — все авторизованные роли (admin/supervisor/viewer), запись — только admin (`require_admin`, как всё в модуле: аноним 401, supervisor/viewer 403). Поля ответов **аддитивны**.

### 2.1 Поля задачи (карточка `GET ?id=`, строки списка `GET ?from&to…`, `?orphans=1`, `?related=`, ответы POST/PUT/close/…)

```json
"links_text": "См. ((task_6afde6f09f5414.82325169|Заказ клиента)).",
"links": [
  { "id": "task_6afde6f09f5414.82325169", "title": "Заказ клиента", "status": "open", "archived": 0, "direction": "out" }
],
"links_n": 1
```

- `links_text` — строка или `null`. `links[]` — вычисляемый: `title`/`status`/`archived` **актуальные** (из `tasks`), `archived` — `0|1` (как у `task.archived`), `direction`: `out` — в `links_text` ЭТОЙ задачи есть токен на неё; `in` — связь держит только другая сторона. Порядок: сначала `out` (в порядке токенов), затем `in` (по названию, затем id). `links_n = count(links)`.
- У задачи без связей: `"links_text": null, "links": [], "links_n": 0`.
- Входящая связь (у задачи B, на которую сослались): `{"id": A, "title": "Закрытие заказа", "status": "open", "archived": 0, "direction": "in"}`; `links_text` у B не меняется.
- **Направление в таблице не хранится** (каноническая пара его теряет) — вычисляется по токенам `links_text`. Если токены есть у обеих сторон — у обеих `out`.

### 2.2 Запись

`POST api/tasks.php` и `PUT api/tasks.php?id=…` — необязательное поле `links_text`:
- `null` или `""` (после trim) → очистить (в БД `NULL`, связи этой задачи по токенам удаляются);
- строка → trim, длина ≤ `TASKS_LINKS_TEXT_MAX = 5000` (как `TASKS_DESC_MAX`, `api/tasks.php:62`); не строка/длиннее → **400 `invalid_links_text`** (как `invalid_description`);
- ключ отсутствует в PUT → связи не трогаются; значение равно текущему → ничего не изменено (`unchanged: true`, версия не растёт, если нет других изменений).

Токен `((ID|название))` — только ID значим; сервер не читает название. Допустимые символы ID — `[A-Za-z0-9_.-]{1,64}` (реальный генератор: `genId('task_')` = `uniqid('task_', true)` → `task_<13 hex>.<8 цифр>`, `api/helpers.php:101`; в тестах встречаются `tt_*`, `nn_*` — подходят). Всё, что не подходит (пробелы, кириллица, `;`, `/`, >64, перевод строки внутри названия, `(())`, `(( ))`, `((|x))`), — **не токен**, остаётся обычным текстом и не вызывает ошибок. Название — любые символы до первых `))`, включая `|` и одиночные скобки.

Правила (порядок проверок — до транзакции, ничего не записано при отказе; задача при отказе не сохраняется):

| Условие | Ответ |
|---|---|
| токен на саму задачу (PUT) | **422** `{"error":"link_self","link_id":…,"message":…}` |
| >50 различных ID | **422** `{"error":"links_too_many","max":50,"message":…}` |
| ID не найден в `tasks` | **422** `{"error":"link_unknown","link_id":…,"message":…}` |
| НОВАЯ связь на архивную (`archived=1`) | **409** `{"error":"link_target_archived","link_id":…,"message":…}` |
| устаревшая `version` | **409** `VERSION_CONFLICT` (как у остальных полей; проверка раньше разбора ссылок) |
| дубли токенов | схлопываются (одна строка, одна запись `links[]`, один аудит) |

«Новая» = пары нет в `task_links`. Уже существующая связь с позже архивированной задачей: PUT с тем же токеном проходит (200), связь сохраняется и в `links[]` с `archived:1` у обеих сторон; токен на архивную можно удалить.

Сохранение: `UPDATE tasks … links_text` + пересборка строк `task_links` + аудит — **в одной транзакции** (PUT: `api/tasks.php:1575`, `:1615–1618`; POST: `:1190–1192`). Диф: добавляются пары, которых нет; пара удаляется, если токен пропал из `links_text` этой задачи **и** встречный токен другой стороны не держит связь. Аудит `tasks_audit`: `task.link_add` / `task.link_remove` — по записи на каждую фактически созданную/удалённую связь, `entity_id` = исходящая задача, `details = {title, target}`; `task.update` содержит `changed: ["links_text"]`.

### 2.3 `GET api/tasks.php?pick=1`

```json
{ "success": true, "tasks": [ { "id": "task_…", "title": "Закрытие заказа", "status": "open", "start_at": "2031-06-05" } ] }
```
Все **неархивные** (открытые и закрытые), `ORDER BY start_at DESC, id`, `LIMIT 2000` (`TASKS_PICK_LIMIT`). Все роли.

### 2.4 `GET api/tasks.php?related=<id>`

```json
{ "success": true,
  "ids":   ["<исходная>", "<остальные по start_at ASC, затем id>"],
  "tasks": [ { …полная карточка как строка списка, с links[]… } ],
  "truncated": true }          // ключ присутствует только при усечении до 200
```
Компонент связности: BFS по `task_links` в обе стороны (PHP, без рекурсивных CTE), **не проходит через архивные** и не включает их, лимит 200 задач (`TASKS_RELATED_LIMIT`; при >200 — ближайшие по BFS, `truncated: true`). Исходная задача первая; `tasks[]` в том же порядке, что `ids`. Ошибки: неизвестный/пустой id → **404 `not_found`**, архивный → **409 `task_archived`**.

> Коды: в ТЗ `task_not_found`; в модуле «не найдено» — это `not_found` (`api/tasks.php`, `GET ?id=` и все ветки записи), поэтому `?related` отвечает `not_found` («по правилам модуля»). T2 — ориентироваться на **статус 404**.

Примеры ответов ошибок (реальный прогон): `{"error":"link_self","link_id":"task_…","message":"Задачу нельзя связать саму с собой."}`, `{"error":"link_unknown","link_id":"task_nope.1",…}`, `{"error":"VERSION_CONFLICT","current_version":1,…}`, `{"error":"link_target_archived","link_id":"task_…",…}`, `?related=<архивная>` → `409 {"error":"task_archived"}`.

## 3. Решение по `links[]` в списке

**`links[]` отдаётся и в строках списка** (+ `links_n`, `links_text`), без отдельного режима. Причина: карточка/панель деталей `js/tasks.js` строится из строки списка (`S.tasks`), без `GET ?id=`; ссылки и их перечёркивание должны быть в ней сразу и актуальными. Стоимость: связи грузятся **пачкой** (1–2 запроса на весь список: `task_links` по `IN (…)` чанками по 400 + `tasks` для соседей; быстрый выход, если связей нет).

Замеры (временная БД, 300 задач на диапазон, pretty-print как у `sendJson`):
- без связей: 476 912 байт; добавка к строке `links_text/links/links_n` — **≈ 62 байта (≈ 3,9 %)**;
- патологический худший случай, **у каждой** из 300 задач по 6 связей: 994 874 байт (×2,1), 0,08 с; ≈ 277 байт на элемент `links[]`;
- реалистичная оценка (≈ 1000 задач/год, ~20 % со связью по 2): ≈ +11 % к ~1,5 МБ (BL-05).

Если BL-05 (лёгкий список для матрицы) будет делаться — `links[]` из строк убирается первым делом, остаётся `links_n`; контракт `?related` (полные карточки) и `GET ?id=` от этого не зависит.

## 4. Разбор sync клиентов (п. 6)

- Клиентский sync (`index.html` `poll()`, `api/sync.php`) отслеживает **только матрицу** (`schedule_entries`, `sync_log`); `tasks` в `api/sync.php` не присутствуют (поиск по файлу — 0 совпадений). Поле `dirty` (`js/tasks.js:92`) — флаг «sync принёс изменения матрицы/удаление сотрудника, пока панель/форма закрыта — перечитать при возврате»; `window.Tasks.onRemoteChange` (`js/tasks.js:2164`, `index.html:5151`) срабатывает по дельте sync матрицы, затем `load(true)` перечитывает **весь список** (`GET api/tasks.php`).
- Ни `updated_at`, ни `version` задач клиент для детекции изменений **не использует**: `rg updated_at js/tasks.js js/tasks_matrix.js` — 0; `version` нужен только для оптимистичной блокировки при записи (`js/tasks.js:2270`, `:2292`, …).
- Вывод для связей: **чтобы связь появилась в карточке задачи 1 без перезагрузки страницы, нужно перечитать список после сохранения** (`load(true)` в обработчике успешного POST/PUT у T2). Другие вкладки/клиенты не получают правок задач вообще (то же самое для смены названия/статуса задачи сейчас) — это существующее ограничение, не новое.
- Что сделано на бэкенде по ТЗ: при добавлении/удалении связи **`updated_at` второй стороны обновляется, `version` — нет** (`api/tasks_links.php`, `tasks_links_apply`: `UPDATE tasks SET updated_at = :ts`). Причина «не version»: у второй стороны может быть открыта форма с её `version` — ложного 409 быть не должно (тест W2: PUT второй стороны после добавления связи со старой `version` проходит; W16: `version` не менялся, `updated_at` обновлён). Сейчас `updated_at` ни клиент, ни `tasks_recheck_pending` (сортирует pending по `updated_at`, `api/tasks_rules.php:946` — влияние на порядок перепроверки пренебрежимо) не читают как маркер изменения; он обновляется для будущей дельты по `updated_at` и для аудита. Если координатор против — это одна строка в `tasks_links_apply`.

## 5. Не сломано

- `close`/`reopen`/`DELETE` (архив): код не менялся; тест **C1** — `task_links` и `links_text` до/после идентичны, `version` второй стороны не менялся; закрытая задача видна как `status:"closed"` у второй стороны; архив задачи — `archived:1` у обеих сторон, строки остаются.
- FR-10/n8n и повторы (**C2**): PUT только `links_text` не вызывает FR-10 (проверка идёт только при смене срока/исполнителей), `check_state` и `occurrences` прежние; PUT с `occurrences` + `links_text` работает. Сьюты `tasksn8n` 27/27, `tasks` 66/66, `tasksatt` 24/24 — зелёные.
- Копирование (**C3**): в `api/` пути дублирования задачи нет (`copy/duplicate/clone` в `api/tasks.php` отсутствуют — проверяется тестом по тексту); копирование в календаре — клиентское (`js/tasks.js`, V6.2-2: `POST` create с явными полями), `links_text` не передаёт → связи не копируются (проверять в T2).

## 6. Тесты

Новый сьют `tasklinks` — `api/tasks_links_test.php` (37 кейсов, временная копия БД через `SC_APP_DB`, `php -S` на ней, `data/app.db` не трогается), в `scripts/verify_all.sh`: `ALL_SUITES`, `BASELINE[tasklinks]=37`, ветка запуска рядом с `tasks|tasksn8n|tasksatt`.

M1–M2 миграция · P1–P5 парсер (одиночный/несколько/дубль/пустое `(())`/название с мусором/без названия/невалидный ID/реальный формат id) · W1 A→B видна у обеих сторон, каноническая пара, аудит · W2 B→A при существующей A→B — не создаёт вторую строку · W3 удаление токена с обеих сторон, встречный токен держит связь · W4 очистка `null`/`''` · W5 самосвязь 422 · W6 неизвестный ID 422 (POST создание не происходит) · W7 новая связь на архивную 409 · W8 старая сохраняется и `archived` у обеих сторон · W9 лимит 50/51 · W10 дубли · W11 `VERSION_CONFLICT` · W12 валидация `links_text` · W13 `unchanged`/аудит `changed` · W14 атомарность (название + ошибочный токен → ничего) · W15 невалидный ID/`(())` как текст · W16 `updated_at` второй стороны, `version` — нет · R1–R3 форма ответа/порядок/**роли** (admin пишет; supervisor/viewer 403 на запись и читают `links`, `?pick`, `?related`; аноним 401) · Q1–Q2 `?pick` (открытые+закрытые, нет архивных, DESC, лимит 2000 на 2105) · L1–L4 `?related` (цепочка 1–2–3 из любой точки с порядком по `start_at`, цикл, изолированная, разрыв через архивную, 409/404, лимит 200/`truncated`) · C1–C3 · V1 объём · G1 утечки (phone/photo/пути).

Существующие тесты, изменённые **осознанно** (только ожидания версии схемы/набора полей, 13 → 14 и аддитивные поля):
- `api/tasks_test.php`: 8 проверок версии схемы `13 → 14` (M1, «повторная миграция», «миграция с v8», M5–M7 и повторы), ожидаемый набор колонок `tasks` (+`links_text`, M2), набор ключей ответа в O14 (`+ links_text, links, links_n`, было `+3`, стало `+6`);
- `api/task_files_test.php`: 2 проверки версии (M1, M2);
- `scripts/test_v6_director.js`: `SCHEMA_VERSION = 14` (регэксп), миграция копии dev-БД → `14`, два места с `schema_version`/`meta` (v10→v11 кейсы).
Число тестов в них не менялось (`tasks` 66, `tasksatt` 24, `director` 101).

## 7. Gate (`bash scripts/verify_all.sh`, таблица целиком)

```
verify_all: f354a15 2026-11-18 22:57:10 suites: smoke tasks tasksn8n tasksatt tasklinks tasksui tasksmx taskscal director emptasks e51 e52 hygiene trips tripsform tripsstatus syntax phplint pii refs tasklink

SUITE    RES  PASSED EXPECT   TIME  NOTE
smoke    PASS     84     84     3s
tasks    PASS     66     66     4s
tasksn8n PASS     27     27    26s
tasksatt PASS     24     24     5s
tasklinks PASS     37     37     7s
tasksui  PASS    334    334    27s
tasksmx  PASS     79     79     6s
taskscal PASS    220    220     6s
director PASS    101    101    14s
emptasks PASS     34     34     2s
e51      PASS     23     23     1s
e52      PASS     41     41     0s
hygiene  PASS     19     19     0s
trips    PASS      7      7     3s
tripsform PASS    131    131    60s
tripsstatus PASS    147    147    76s
syntax   PASS      -      -     0s
phplint  PASS     38      -     4s
pii      PASS      -      -     0s
refs     PASS     28     28    21s  удалено 0, со ссылками 0, исключений 0
tasklink PASS     43     43     7s  коммитов 2, с кодом 0, нарушений 0
clean    PASS

GATE: PASS (21 suites)
```
Отдельно: `php -l api/tasks.php api/tasks_links.php api/db.php api/tasks_links_test.php` — без ошибок; `node scripts/check_syntax.js` — `failed: 0`; `bash scripts/check_no_pii.sh` — `OK`. (Таблица — на рабочем дереве до коммита; строка `tasklink` проверяет коммиты `origin/main..HEAD`, коммит этой задачи несёт `t_f1a7ff61`.)

## 8. Прод: DDL v14 (отдельно, для `DEPLOY_HOSTLAND.md`)

Миграция выполняется **сама** при первом обращении к любому `api/*.php` (`Database::migrate()` вызывается в `tasks.php` и др.) — ручной SQL не обязателен. Ниже — эквивалент на случай ручной подготовки/проверки (идемпотентность по частям; выполнять после **бэкапа `data/app.db`**, на копии — предварительно):

```sql
-- 1) колонка (SQLite не знает «ADD COLUMN IF NOT EXISTS»: выполнять только если её нет)
--    проверка:  SELECT COUNT(*) FROM pragma_table_info('tasks') WHERE name = 'links_text';   -- 0 → выполнить:
ALTER TABLE tasks ADD COLUMN links_text TEXT;

-- 2) таблица связей (каноническая пара) и индекс — идемпотентно
CREATE TABLE IF NOT EXISTS task_links (
    task_a     TEXT NOT NULL,
    task_b     TEXT NOT NULL,
    created_at TEXT,
    created_by TEXT,
    PRIMARY KEY (task_a, task_b),
    CHECK (task_a < task_b),
    FOREIGN KEY (task_a) REFERENCES tasks(id) ON DELETE CASCADE,
    FOREIGN KEY (task_b) REFERENCES tasks(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_task_links_b ON task_links (task_b);

-- 3) версия схемы (только если правим вручную; код сам ставит 14 после migrate())
INSERT INTO meta (key, value) VALUES ('schema_version', '14')
    ON CONFLICT(key) DO UPDATE SET value = excluded.value;   -- ON CONFLICT — как в Database::setMeta (SQLite ≥ 3.24)
```

### Риски для деплоя
1. **Порядок выкладки.** Выкладывать код целиком (`api/db.php`, `api/schema.sql`, `api/tasks.php`, `api/tasks_links.php`): новый `tasks.php` без `tasks_links.php`/миграции даст 500 (`require_once`). Файл `api/tasks_links.php` не должен попасть в исключения шаблона упаковки (`DEPLOY_HOSTLAND.md` исключает только `_test\.php$` — `tasks_links.php` не подпадает; `tasks_links_test.php` — подпадает и должен быть исключён, как остальные тесты; проверить `tar -tzf`).
2. **SQLite на хосте** не проверен (спека): использованы только возможности SQLite ≤ 3.8 (кроме `ON CONFLICT` в `setMeta`, уже работающего на проде для v13). `ALTER TABLE … ADD COLUMN TEXT` — мгновенная операция, таблица не пересобирается.
3. **Откат кода** безопасен (проверено, §1.4): старый код работает на БД v14, версия не понижается, связи остаются в БД и просто не показываются.
4. **Объём ответа списка**: +≈4 % без связей (§3). Оценка для 1000 задач — ≈ +60 КБ.
5. **`?pick=1` ≤ 2000** задач: при росте выше окно выбора усечёт самые старые (сортировка `start_at DESC`) — для поиска задачи по названию T2/владельцу это потенциальное ограничение (лимит — константа `TASKS_PICK_LIMIT`).
6. **Синхронизация между клиентами** отсутствует (§4): связь, добавленная одним админом, у другого видна после его перезагрузки списка (как и любое изменение задачи).

## 9. Для T2 (контракт и подводные камни)

- После успешного POST/PUT с `links_text` — `load(true)`: входящие связи у других карточек появляются только так (`version` второй стороны не менялся, форма с её `version` не конфликтует).
- Ошибки записи: 422 (`link_self`/`link_unknown`/`links_too_many`, у первых двух `link_id`), 409 (`link_target_archived` и `VERSION_CONFLICT` — различать по `error`), 400 `invalid_links_text`; у всех, кроме VERSION_CONFLICT, есть русский `message` для показа.
- Клик по перечёркнутой ссылке — по `links[i].archived === 1`; `?related` не вернёт архивные и вернёт 409 для архивной исходной — UI должен не вызывать его для `archived`.
- Название в `links[]` — актуальное, но токен в `links_text` содержит снимок; рендеринг в режиме чтения — из `links[]` по ID.
- Все данные ссылок выводить через `esc()` (названия приходят как есть).

## 10. Открытые вопросы / оговорки

- `404 not_found` вместо `task_not_found` (§2.4) — по правилам модуля; если нужен именно `task_not_found`, это замена одной строки и тестов L3/G1.
- `invalid_links_text` — **400** (как `invalid_description`), а не 422: ТЗ говорило «лимит длины — как у описания».
- Парсер лоялен: невалидный ID — не токен, без ошибки. Если владельцу нужно «ошибка при `((не id))`» — отдельное решение.
- `updated_at` второй стороны обновляется, хотя клиентский sync его не читает (§4) — оставлено по ТЗ как безопасное; снимается одной строкой.
- Попутно найдено (вне объёма): гоночное поведение при смешивании сырого соединения PDO и `copy()`/`sha1_file()` того же WAL-файла внутри одного процесса теста (закрытие любого дескриптора снимает POSIX-блокировки соединения → `php -S` пересоздаёт WAL, соединение теста «видит другую БД»). В `tasklinks` избежано (миграционный тест не копирует/не открывает вторично основную копию, миграции идут отдельным процессом); возможный источник нестабильности и в других сьютах с таким же шаблоном.
