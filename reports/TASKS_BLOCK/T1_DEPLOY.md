# Выкладка фазы T1 «Задачи» на Hostland — 2026-11-11

Команда владельца: «Деплой» (2026-11-11). Выполнил: координатор. Коммит: `85a746d` (T1-1…T1-4, T1-7…T1-12; LLM-часть — BL-04, не выкладывается).
Механика: `DEPLOY_HOSTLAND.md` §2 (сборка), §4 (обновление), §10 (проверка). n8n на проде не подключён (вариант A, §12).

## До выкладки
| Проверка | Результат |
|---|---|
| Прод до выкладки | схема **v8**, 41 сотрудник, 1525 записей матрицы, таблиц задач нет |
| Миграция на копии прод-БД (`.backup` → локально, код `85a746d`, PHP 8.3) | v8 → **v10**; количество строк в 9 таблицах идентично до/после; `integrity_check ok`; `foreign_key_check` пуст; `task_assignees` — FK только на `tasks`; повтор — no-op. Копия удалена после проверки |
| Совместимость с PHP 8.1 (прод) | grep конструкций 8.2/8.3 по `api/*.php` (не тесты) — нет |
| Сборка из чистого worktree `85a746d` | `check_no_pii` OK; 39 файлов; запрещённых нет; js: storage, tasks, tasks_matrix, trips; md5 пакета `e8839105…` = md5 на сервере после scp |

## Выкладка (§4)
STEP0 ACL-снимок → STEP1 бэкапы `~/backups/app-pre-t1-2026-11-11-1852.db` (1 638 400 б) и `old-site-pre-t1-2026-11-11-1852.tar.gz` (без `images/`) →
STEP2 копирование (`images/.htaccess` не копировался, R1-02) → STEP3 удаление служебных (в т.ч. найденный на проде `js/test_trips_overlay.js`) →
STEP4 chmod только `api`, `data/holidays`, `js`, `index.html`, `upload.php` → STEP5 ACL `data/`/`images/` **без изменений**.

## После выкладки
- Миграция на проде (запущена анонимным `GET /api/tasks.php`, `migrate()` до проверки сессии): `schema_version 10`, `integrity_check ok`, `foreign_key_check` пуст, 41 сотрудник, 1525 записей матрицы, таблицы `tasks`, `task_assignees`, `task_checklist`.
- md5 отдаваемых `/` и `/js/tasks.js` = md5 файлов сборки (`f040d081…`, `8d6b1f2a…`).
- §10, анонимно: `/` 200 и без ПДн; `/api/tasks.php` 401; `/api/holidays.php` 401; `smoke_test`/`init_db`/`seed_positions`/`E8_SYNC.md` 403; `tasks_test.php`/`tasks_n8n_test.php` 404; `schema.sql` 403; `/docs/API_DOCUMENTATION.json` 404; фото 200; `session.php` 200 без `X-Powered-By`; `/data/app.db` 403; доп.: `/js/tasks.js` 200, `/js/test_trips_overlay.js` 404, `/n8n/tasks-validate.json` 404.
- Отклонение: `/api/debug_token.php` → **403** вместо 404 по §10. Файла на сервере нет (`ls` — No such file); 403 отдаёт `FilesMatch` в `api/.htaccess` до проверки существования. Защита не слабее ожидаемой; ожидание в `DEPLOY_HOSTLAND.md` §10 исправлено на «403 или 404».

## Не проверено (нужен владелец)
Функциональная проверка под учётной записью (пароли прода у владельца): вход → панель «Задачи» → создать задачу → иконка в матрице → удаление сотрудника с задачей → окно замены. Откат: восстановить `app-pre-t1-2026-11-11-1852.db` и распаковать `old-site-pre-t1-2026-11-11-1852.tar.gz` в `$WWW`.
