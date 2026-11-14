# V6.3 — выкладка на прод (Hostland)

- Команда владельца: «Деплой сразу после приемки» (2026-11-14). Приёмка V6.3-3 нашла P2-1 → деплой был придержан, исправлено в V6.3-4, координатор независимо перепрогнал harness приёмщика (A2 6/0, A 40/0); затем «продолжай». Выложен `main` = `2879e23` (прод до этого `2b0bc39`, V6.2).
- Объём: И-1, И-2 (Список: ≤2 исполнителей + «…», ширины колонок), Д-1 (повторяющиеся задачи). Файлы: `api/db.php`, `api/schema.sql`, `api/tasks.php`, `api/tasks_rules.php`, `js/tasks.js`, `js/tasks_matrix.js`. **Шаг БД: миграция v11 → v12** (новая таблица `task_occurrences` + 2 индекса; существующие данные не меняются). Скрипта данных нет.

## Перед выкладкой (только чтение)
- Прод: schema 11; `js/tasks.js` = V6.2 (md5 совпал с `2b0bc39`).
- Локальный gate на `2879e23`: PASS (14 suites); HEAD = origin/main.

## Бэкап
- `/home/host1882970/backups/app-pre-v63-2026-11-14-1032.db` (`.backup`, integrity ok, schema 11).
- `/home/host1882970/backups/www-pre-v63-2026-11-14-1032.tar.gz` (код без БД и images); ACL → `~/acl-before.txt`.

## Репетиция на копии боевой БД (локально, scratch 700, затем `shred`)
| | schema | employees | schedule_entries | tasks | task_assignees | task_checklist | groups | audit_log | task_occurrences |
|---|---|---|---|---|---|---|---|---|---|
| до | 11 | 41 | 1517 | 16 | 26 | 15 | 8 | 179 | — |
| после | 12 | 41 | 1517 | 16 | 26 | 15 | 8 | 179 | 0 |
integrity ok, foreign_key_check пусто, таблица и 2 индекса созданы; повторный запуск — no-op (12, 0).

## Выкладка
- Пакет: 39 файлов, md5 `672cadd755e84147213911e511ae479b` (совпал локально и на сервере), `check_no_pii` OK, FORBIDDEN-фильтр пройден.
- Раздел 4 `DEPLOY_HOSTLAND.md`: копирование, удаление служебных файлов, chmod; «OK ACL unchanged».
- Миграция: анонимный `GET /api/tasks.php` → 401.

## Проверки после выкладки
- БД прода: schema **12**, integrity ok, foreign_key_check пусто; employees 41, schedule_entries 1517, tasks 16, task_assignees 26, task_checklist 15 — как в бэкапе; task_occurrences 0; объекты `task_occurrences` (таблица + 2 индекса) — 3.
- md5 на сервере = HEAD: `index.html`, `js/tasks.js`, `js/tasks_matrix.js`, `js/storage.js`, `api/tasks.php`, `api/tasks_rules.php`, `api/db.php`, `api/schema.sql`. Отдаваемые `/` и `/js/tasks.js` = HEAD (`d3163df8…`), маркеры V6.3 в отдаваемом JS есть.
- HTTP (запросы с сервера — внешний IP координатора закрыт IP-фильтром панели Hostland, см. V6_2_DEPLOY.md): `/` 200, `/js/tasks.js` 200, `/api/tasks.php` 401, `/api/holidays.php` 401, `/api/session.php` 200, `/api/schema.sql` 403, `/data/app.db` 403, фото 200, служебные `smoke_test`/`init_db`/`seed_positions`/`debug_token`/`E8_SYNC.md` 403, `*_test.php` и `/docs/…` 404; X-Powered-By нет.

## Откат
- Код: распаковать `www-pre-v63-2026-11-14-1032.tar.gz` в `$WWW`. Таблица `task_occurrences` добавочная — старый код её игнорирует; БД восстанавливать не нужно. Полный откат БД (если потребуется): `sqlite3 $WWW/data/app.db ".restore /home/host1882970/backups/app-pre-v63-2026-11-14-1032.db"` (не `cp` — сохраняются ACL).

## Открытое (решение владельца)
- P3-2: при подключённом n8n проверка идёт по каждому повтору последовательно (на проде n8n не подключён).
- P3-3: двойное сообщение об ошибке в календаре (с V6.2).
- Вкусовые замечания — `V6.3-3_ACCEPTANCE.md` §9.
- Хвосты на сервере (по слову владельца): `~/sc-hostland-deploy.tar.gz`, `~/v6-3/`, `~/v6-dryrun.txt`, `~/v6-apply.txt`, `~/acl-before.txt`, `~/acl-after.txt`.
