# V7 — выкладка на прод (Hostland)

- Команда владельца: «Старт на весь план» (2026-11-16), включая Ш6. Выложен `main` = `3826b2e` (прод до этого `2879e23`, V6.3 — md5 `js/tasks.js`/`api/tasks.php` на сервере совпали с `2879e23`).
- Объём: вложения файлов в задачах. Файлы кода: `api/db.php`, `api/schema.sql`, `api/tasks.php`, `api/task_files.php` (новый), `api/task_files_lib.php` (новый), `js/tasks.js`. `index.html` не менялся.
- **Шаг БД: миграция v12 → v13** — новая таблица `task_attachments` + индекс; существующие данные не меняются.

## Ш0 (до разработки): лимиты PHP прода
Зонд со случайным именем, запрос с сервера, затем удалён (повторный запрос → 404): `upload_max_filesize=256M`, `post_max_size=256M`, `max_file_uploads=20`, PHP 8.1.34, `finfo` есть → действует лимит 5 МБ.

## Бэкап (до выкладки)
- `/home/host1882970/backups/app-pre-v7-2026-11-16-1457.db` (`.backup`, integrity ok, schema 12).
- `/home/host1882970/backups/www-pre-v7-2026-11-16-1457.tar.gz` (код без `data/app.db`, `images`, `static`); ACL `data`/`images` сняты до выкладки.

## Репетиция миграции на копии боевой БД (локально, scratch 700, затем `shred`)
| | schema | employees | schedule_entries | tasks | task_assignees | task_checklist | task_occurrences | audit_log | groups | task_attachments |
|---|---|---|---|---|---|---|---|---|---|---|
| до | 12 | 41 | 1541 | 19 | 31 | 20 | 2 | 220 | 8 | — |
| после | 13 | 41 | 1541 | 19 | 31 | 20 | 2 | 220 | 8 | 0 |

integrity ok, foreign_key_check пусто, объектов `task_attachments` 3 (таблица, индекс, UNIQUE); повторный запуск — no-op (13).

## Выкладка
- Пакет: 41 файлов, md5 `38e9cf263dba828d539be400892054b6` (совпал локально и на сервере), `check_no_pii` OK, FORBIDDEN-фильтр пройден. Новые в пакете: `api/task_files.php`, `api/task_files_lib.php`; тест `api/task_files_test.php` в пакет не вошёл.
- Раздел 4 `DEPLOY_HOSTLAND.md`: копирование, удаление служебных файлов и тестов, chmod; «OK ACL unchanged».
- Миграция: анонимный `GET /api/tasks.php` → 401.

## Проверки после выкладки
- БД прода: schema **13**, integrity ok, foreign_key_check пусто; employees 41, schedule_entries 1541, tasks 19, task_assignees 31, task_checklist 20, task_occurrences 2 — как в бэкапе; task_attachments 0.
- Каталог вложений: зонд (тем же кодом `tf_dir()`, под веб-пользователем) создал `data/task_files/` (владелец `host1882970_1`, ACL унаследован от `data/`: rwx у веб-пользователя и у `host1882970`), записал и удалил пробный файл, `.htaccess`-запрет на месте, действующий лимит `5242880`; зонд удалён (→ 404).
- md5 на сервере = HEAD: `index.html`, `js/tasks.js`, `api/tasks.php`, `api/task_files.php`, `api/task_files_lib.php`, `api/db.php`, `api/schema.sql`; отдаваемый `/js/tasks.js` = HEAD (`05409fa2…`), маркеры V7 есть.
- HTTP (запросы с сервера — внешний IP VPS закрыт IP-фильтром Hostland): `/` 200, `/js/tasks.js` 200, `/api/tasks.php` 401, `/api/holidays.php` 401, `/api/session.php` 200 без X-Powered-By, `/api/schema.sql` 403, `/data/app.db` 403, фото 200, служебные 403, `*_test.php` и `/docs/…` 404; **V7:** `/api/task_files.php?limits=1` 401, `?id=1` 401, `/api/task_files_lib.php` 404, `/api/task_files_test.php` 404, `/data/task_files/.htaccess` 403.

## Не проверено на проде
- Загрузка/скачивание под реальной учётной записью (паролей у исполнителя нет) — проверить владельцу: карточка задачи → скрепка → «Выбрать файлы»/перетащить файл → скачать → удалить. Ctrl+F5 во всех открытых окнах (новый `js/tasks.js`).
- Лимит nginx на размер тела запроса (эксперименты запрещены владельцем).

## Откат
- Код: распаковать `www-pre-v7-2026-11-16-1457.tar.gz` в `$WWW` и удалить `api/task_files.php`, `api/task_files_lib.php`. Таблица `task_attachments` добавочная — старый код её игнорирует, БД восстанавливать не нужно.
- Полный откат БД (если потребуется): `sqlite3 $WWW/data/app.db ".restore /home/host1882970/backups/app-pre-v7-2026-11-16-1457.db"` (не `cp` — сохраняются ACL). Загруженные после выкладки файлы останутся в `data/task_files/`.

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
