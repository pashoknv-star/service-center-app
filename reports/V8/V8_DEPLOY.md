# V8 — выкладка на прод (Командировки: юзабилити)

- Основание: решение владельца 2026-11-18 «После выполнения пп 1,2,3 → Деплой» (пп.: продолжать; телефон обязателен только для «Подтвердить» + пометки «*»; ошибка Матрицы → бэклог BL-09). Условие координатора «нет P0–P2 в ревью и браузерной приёмке» выполнено: T5 P2 ×2 и T6 P1 исправлены в T7, перепроверка T8 — P0/P1/P2 = 0.
- Выложен `main` = `d24fdd7` (= `origin/main`). Прод до выкладки — V7 `3826b2e` (md5 `index.html`, `js/trips.js`, `js/tasks.js`, `api/trips.php` на сервере совпадали с `3826b2e`).
- Вариант: только код (миграций нет: `git diff 3826b2e..HEAD -- api/db.php api/schema.sql` пуст).
- Объём (`git diff --stat 3826b2e..HEAD -- index.html js api upload.php data/holidays`): `api/trips.php`, `index.html`, `js/tasks.js`, `js/trips.js` (+ `api/smoke_test.php` — в пакет не входит).
- Дата: 2026-11-18, 07:41–07:50 (+05).

## Бэкап (до выкладки)

- `/home/host1882970/backups/app-pre-v8-2026-11-18-0741.db` (`.backup`, `integrity_check` ok, schema_version 13).
- `/home/host1882970/backups/www-pre-v8-2026-11-18-0741.tar.gz` (код без `data/app.db`, `images`, `static`).
- `/home/host1882970/backups/task_files-pre-v8-2026-11-18-0741.tar.gz` (вложения задач).
- ACL `data`/`images` сняты до выкладки (`~/acl-before.txt`).
- Счётчики в бэкапе: employees 41, schedule_entries 1550, tasks 22, trips 0, trip_requests 0, users 3.

## Выкладка

- Пакет: 41 файл (состав как в V7, см. ниже), md5 `4faf590c6b0949d146dd264967e08f4f` — совпал локально и на сервере; `check_no_pii` OK, FORBIDDEN-фильтр пройден.
- Порядок — `DEPLOY_HOSTLAND.md` §4: распаковка в `/tmp/scnew`, `cp -a`, удаление служебных/тестовых файлов, `chmod` только `api`, `data/holidays`, `js`, `index.html`, `upload.php`; `images/.htaccess` не копировался. `/tmp/scnew` и пакет на сервере удалены.

## Проверки после выкладки

| Проверка | Результат |
|---|---|
| md5 на сервере = HEAD: `index.html`, `js/trips.js`, `js/tasks.js`, `api/trips.php`, `api/db.php` | OK (все 5 совпали) |
| md5 отдаваемых `/` и `/js/trips.js` = HEAD | OK (`9d53af4d…`, `c4ed56c1…`) |
| Маркеры V8 в отдаваемом коде | `phone_required`/`status_change_forbidden` в `/js/trips.js` (3), `tasksFromEmpCardBtn` в `/index.html` (2) |
| ACL `data`/`images` до/после | без различий |
| Анонимная матрица §10 (с сервера, `ssh hostland 'curl …'`) + `/api/trips.php`, `/api/trip_relay.php` | 21/21 OK (`/` 200, API без сессии 401, служебные/тесты 403/404, `/data/app.db` 403, фото 200) |
| БД после выкладки | `integrity_check` ok, `foreign_key_check` пуст, schema_version 13; счётчики = бэкапу |

## Не проверено на проде

- Логин и сценарии в браузере на проде (учётные данные прода — у владельца). Проверены в браузере на dev: T6, T8.
- Робот HelpMe не работает (решение владельца: подтверждение ставит заявки в очередь, обработка — вне фазы).

## Откат

- Код: `tar -xzf /home/host1882970/backups/www-pre-v8-2026-11-18-0741.tar.gz -C ~/host1882970.hostland.pro/htdocs/www` (БД не трогается — миграций не было).
- Полный откат БД (если потребуется): `sqlite3 $WWW/data/app.db ".restore /home/host1882970/backups/app-pre-v8-2026-11-18-0741.db"` (не `cp` — сохраняются ACL).

## Оставлено на сервере

- `~/acl-before.txt`, `~/acl-after.txt` — удалить по слову владельца. `~/backups/` — сохраняется (путь отката).

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
