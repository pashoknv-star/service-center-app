# V9 — выкладка на прод (Задачи: связанные задачи)

- Основание: команда владельца 2026-11-19 «Примени патч и Деплой» (вариант A, ключ `(())`).
- Выложен `main` = `1616e8d` (= `origin/main`, push 37b0eab..1616e8d до выкладки). Прод до выкладки — V8 `d24fdd7` (md5 `index.html`, `js/tasks.js`, `api/tasks.php`, `api/db.php`, `api/schema.sql` на сервере совпали с `d24fdd7`).
- Вариант: **аддитивная миграция схемы v13→v14** без data-шага (`tasks.links_text`, таблица `task_links`).
- Приёмка: V9-T1 `5f3c047`, V9-T2 `26d4147`, V9-T3 (независимая, вердикт «принять», P0–P2 нет, P3 ×5) `dce7f68`. GATE: PASS (22 suites).
- Дата: 2026-11-19, 07:56–07:59 (+05).
- Объём (`git diff --stat d24fdd7..HEAD -- index.html js api upload.php data/holidays`, без `*_test.php`): `api/db.php`, `api/schema.sql`, `api/tasks.php`, `api/tasks_links.php` (новый), `js/tasks.js`. `index.html` не менялся.
- Патч AGENTS.md (tasklinks 37, tasklinksui 211) применён по команде владельца, коммит `1616e8d`.

## Бэкап (до выкладки)
- `/home/host1882970/backups/app-pre-v9-2026-11-19-0556.db` (`.backup`, `integrity_check` ok, schema_version 13).
- `/home/host1882970/backups/www-pre-v9-2026-11-19-0556.tar.gz` (код без `data/app.db`, `images`, `static`, `data/task_files`).
- `/home/host1882970/backups/task_files-pre-v9-2026-11-19-0556.tar.gz`.
- ACL `data`/`images` до выкладки: `~/acl-before.txt`; после: `~/acl-after.txt`, `diff` пуст.
- Счётчики в бэкапе: employees 41, schedule_entries 1533, tasks 27, task_assignees 44, task_checklist 27, task_occurrences 4, task_attachments 4, trips 2, trip_requests 3, users 3, audit_log 234, sync_log 10003.

## Репетиция миграции (локальная копия бэкапа, `SC_APP_DB`, копия уничтожена `shred`)
- schema_version 13→14; `task_links` 0 строк; колонка `tasks.links_text` есть; `integrity_check` ok; `foreign_key_check` пуст; повторный `migrate()` — no-op.
- Счётчики всех таблиц идентичны, кроме `audit_log` 234→176: штатная очистка по сроку (E5-4, «удалено 58 записей»), срабатывает при обращении к БД, к миграции не относится.

## Выкладка
- Пакет: 42 файла, md5 `47223fbfabe061839dc2c3eb9789e41b` — совпал локально и на сервере; `check_no_pii` OK; запрещённых файлов нет. От списка V8 (41) отличие одно: `api/tasks_links.php`.
- Порядок — `DEPLOY_HOSTLAND.md` §4. Миграция сработала на первом обращении к БД (анонимный `GET /api/holidays.php` → 401).

## Проверка (с сервера, `ssh hostland 'curl …'`)
| Проверка | Результат |
|---|---|
| schema_version | 14 |
| `integrity_check` / `foreign_key_check` | ok / пусто |
| Счётчики после vs бэкап | все равны, кроме `audit_log` 234→176 (E5-4); `task_links`=0 |
| md5 на сервере = `git show HEAD:` (index.html, js/tasks.js, api/tasks.php, api/tasks_links.php, api/db.php, api/schema.sql) | 6/6 совпали |
| md5 отдаваемого `/js/tasks.js` | = локальный; маркер `linkTokenText` ×3; `/` отдаёт тот же `index.html` |
| Анонимная матрица §10 + `?pick=1`, `?related=x` (401), `tasks_links_test.php` (404) | 23/23 OK |
| ПДн в отдаваемом `/` | 0 |
| ACL data/images | не изменились |

Примечания:
- С машины координатора `curl` даёт 404 (IP-ограничение хостинга, не дефект выкладки); все проверки выполнены с сервера.
- **P3 (не блокирует):** `/api/tasks_links.php` по вебу даёт 200 с пустым телом (библиотека без вывода; `.htaccess` закрывает только `smoke_test|debug_token|init_db|seed_positions` и `.sql/.md`). Предложение: закрыть `FilesMatch` (в бэклог).
- Не проверено мной: работа UI связей на проде под реальной сессией admin (нет прод-учётных данных у координатора) — владельцу проверить после Ctrl+F5.

## Откат
- Код: `ssh hostland 'tar -xzf /home/host1882970/backups/www-pre-v9-2026-11-19-0556.tar.gz -C ~/host1882970.hostland.pro/htdocs/www'` (затем удалить `api/tasks_links.php`). Таблица `task_links` и колонка `links_text` аддитивные — старый код их игнорирует, БД восстанавливать не нужно.
- Полный откат БД (только если нужен): `sqlite3 <DB> ".restore '/home/host1882970/backups/app-pre-v9-2026-11-19-0556.db'"` — `.restore` в существующий файл, не `cp`.

## Остатки на сервере (удалять только по слову владельца)
`~/sc-hostland-deploy.tar.gz`, `~/acl-before.txt`, `~/acl-after.txt`. Бэкапы `~/backups/` сохранены.

## Состав пакета
```
api/.htaccess
api/audit_export.php
api/auth.php
api/change_password.php
api/db.php
api/employees.php
api/entries.php
api/export.php
api/groups.php
api/helpers.php
api/holidays.php
api/holidays_provider.php
api/import.php
api/load.php
api/login.php
api/logout.php
api/positions.php
api/reset.php
api/save.php
api/schema.sql
api/session.php
api/sync.php
api/task_files.php
api/task_files_lib.php
api/tasks.php
api/tasks_links.php
api/tasks_rules.php
api/trip_relay.php
api/trips.php
api/upload.php
api/vacation_import.php
data/.htaccess
data/holidays/2026.json
data/holidays/2027.json
data/holidays/2028.json
images/.htaccess
index.html
js/storage.js
js/tasks.js
js/tasks_matrix.js
js/trips.js
upload.php
```
