# V6.2 — выкладка на прод (Hostland)

- Команда владельца: «Деплой» (2026-11-14). Выложен `main` = `2b0bc39` (прод до этого `a16db33`, V6).
- Объём: только код — `js/tasks.js`, `api/tasks.php` (теги меток, Список/Доска, перетаскивание и копирование в календаре). Изменений БД нет, schema_version остаётся 11. Миграции, DRY-RUN и APPLY не требовались.

## Перед выкладкой (только чтение)
- Прод: schema 11, g3 «Управление СЦ», tasks 15, из них 2 с запятой в метке (после выкладки показываются как теги — принято владельцем).
- Локальный gate на `2b0bc39`: PASS (14 suites). HEAD = origin/main.

## Бэкап
- `/home/host1882970/backups/app-pre-v62-2026-11-14-0012.db` (`.backup`, integrity ok; employees 41, schedule_entries 1517, tasks 15).
- `/home/host1882970/backups/www-pre-v62-2026-11-14-0012.tar.gz` (код без БД и images).
- ACL `data/`, `images/` → `~/acl-before.txt`.
- Откат: распаковать `www-pre-v62-…tar.gz` в `$WWW` (БД не менялась, восстанавливать не нужно).

## Пакет и выкладка
- `sc-hostland-deploy.tar.gz`: 39 файлов, md5 `d52a480bd859b61aa5fde6e939b0493f` (совпал локально и на сервере). `check_no_pii` OK, фильтр FORBIDDEN пройден.
- Выкладка по разделу 4 `DEPLOY_HOSTLAND.md`: копирование, удаление тестовых и служебных файлов, chmod. «OK ACL unchanged».

## Проверки после выкладки
- md5 на сервере = HEAD: `index.html`, `js/tasks.js` (`8424c845…`), `js/tasks_matrix.js`, `js/storage.js`, `js/trips.js`, `api/tasks.php` (`76984dee…`), `api/db.php`.
- БД: schema 11, g3 «Управление СЦ», integrity ok, tasks 15 — без изменений.
- HTTP (запросы с самого сервера, см. ниже): `/` 200 (md5 = `index.html` HEAD); `/js/tasks.js` 200 (md5 = HEAD); `/api/tasks.php` 401; `/api/holidays.php` 401; `/api/session.php` 200; `/api/schema.sql` 403; `/data/app.db` 403; фото директора 200; `smoke_test`, `init_db`, `seed_positions`, `debug_token`, `E8_SYNC.md` 403; `tasks_test.php`, `tasks_n8n_test.php`, `/docs/…` 404; X-Powered-By отсутствует.

## Замечание
- С внешнего адреса координатора (138.124.68.206) сайт отвечает `452 / Status: 403 Forbidden by IP restrictions` («Site is closed, wrong ip»). Это ограничение доступа по IP в панели Hostland; к выкладке не относится (файлы совпадают с HEAD, с сервера всё отвечает штатно). Настройки панели координатор не менял. Поэтому HTTP-проверки выполнены с самого сервера.
- Что владельцу проверить вживую: Ctrl+F5 во всех открытых вкладках, затем Список (✎, теги), Доска, перетаскивание и копирование правой кнопкой в Календаре.
- Известное P3 (решение владельца): двойное сообщение об ошибке при неудачном переносе/вставке (`V6.2-3_ACCEPTANCE.md`, D-1).
- Хвосты на сервере (удаляются по слову владельца): `~/sc-hostland-deploy.tar.gz`, `~/v6-3/`, `~/v6-dryrun.txt`, `~/v6-apply.txt`, `~/acl-before.txt`, `~/acl-after.txt`.
