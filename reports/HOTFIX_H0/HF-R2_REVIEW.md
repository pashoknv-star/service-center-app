# HF-R2 — Ревью HF-2 (backend-хотфикс)

Ревьюер: sd_worker_03. Задача: Kanban `t_72194ca1`. Ревьюируется: ветка `hotfix/hf2-backend`, коммит `6815089563c3c26c0a26be601ee436479d44df36` (исполнитель sd_worker_02, Kanban `t_32a957ab`), worktree `/home/hermes/hf-wt/hf2` (только чтение; код не правил, не коммитил, не пушил).
Спека: `reports/HOTFIX_H0/specs/HF-2.md`. Отчёт исполнителя: `reports/HOTFIX_H0/HF-2_REPORT.md` (в ветке).

## Вердикт: **ACCEPT**

Блокеров (P0/P1) нет. Все критерии приёмки 1–4, 6, 7 подтверждены независимо; критерий 5 (`.htaccess`) локально проверить нельзя — переносится на прод по матрице HF-1. Есть одна находка P2 (процедура деплоя не удаляет старые файлы на проде) и несколько P3 — они не мешают приёмке ветки, но P2 нужно закрыть на этапе HF-INT/деплоя.

## Находки

| ID | Приор. | Файл:строка | Суть | Как воспроизвести / что сделать |
|---|---|---|---|---|
| R2-01 | P2 | `DEPLOY_HOSTLAND.md` §4 (HF-1) + `api/debug_token.php` (удалён) | Раздел 4 выкладывает код через `cp -a /tmp/scnew/api … $WWW/` — это только перезапись, удаления нет. Удаление `api/debug_token.php` из ветки на проде **ничего не удалит**: старый файл (отдаёт 8+8 символов токена импорта без авторизации) останется. Закрывается только `FilesMatch`-deny в новом `api/.htaccess`, который на проде ещё не проверен (`apachectl` на хосте нет). В `PLAN.md:62` шаг «Удалить с прода: smoke_test, debug_token, init_db, seed_positions, E8_SYNC.md…» есть, но в `DEPLOY_HOSTLAND.md` его нет. | После деплоя на проде: `rm -f api/debug_token.php api/smoke_test.php api/init_db.php api/seed_positions.php api/E8_SYNC.md` и проверка `curl -I` → 403/404 на каждый (матрица HF-1). Дописать `rm -f` в раздел 4 `DEPLOY_HOSTLAND.md` (зона HF-1/HF-INT, не HF-2). Токен импорта не ротирован по решению владельца — до удаления файла утечка 16 символов остаётся. |
| R2-02 | P3 | `api/holidays.php:29-44` | Проверка авторизации стоит после `Database::getInstance()` / `$db->migrate()`. Аноним на 401 всё равно инициирует открытие БД и миграцию. Эксплуатируемости нет (миграции идемпотентны), но «авторизация до любой работы» было бы чище. Спека явно требовала «до `switch`» — исполнитель сделал по спеке. | `curl -X POST /api/holidays.php` без сессии → 401, но `migrate()` уже выполнен. Предложение (фаза H1+): вынести `require_auth/admin` выше `$db->migrate()`. |
| R2-03 | P3 | `api/helpers.php:5-8` ↔ `api/smoke_test.php` | `helpers.php` подключается и в CLI-смоуке, поэтому в самом smoke теперь `display_errors=0`: PHP-warning/notice в процессе-раннере не печатаются на экран (идут в `log_errors` → stderr CLI). На результат смоука не влияет (84/84), но маскирует ворнинги раннера. | Предложение: в smoke_test.php сразу после `require_once helpers.php` вернуть `ini_set('display_errors','1')` (только под CLI). Не блокер. |
| R2-04 | P3 | `api/init_db.php:17-21` (старый guard) | Старый `STDERR`-guard теперь недостижимый код (новый `PHP_SAPI` guard выше). Спека это допускала. | Мёртвый код — убрать при ближайшей правке файла. |
| R2-05 | P3 | `api/smoke_test.php` проверка [76] | Проверка «токен не записан в аудит» смотрит только `details`; `entity_id`/`action` не проверяются. Реальный вызов пишет `entity_id='rpa_relay_token'` (имя ключа, не значение), `details='[]'` — я проверил SQL-ом по всем трём полям: значение токена нигде не встречается. | Предложение: расширить assert на `entity_id`/`action`. Не блокер. |
| R2-06 | P3 | `docs/API_DOCUMENTATION.json:323-325` | Док по `/api/holidays.php` описывает эндпоинт без указания авторизации (теперь GET=auth, запись=admin). `docs/` HF-2 трогать запрещено, правка — за координатором. | Обновить в docs-фазе. |
| R2-07 | info | `api/helpers.php:5-8` | `display_errors=0` действует только после подключения `helpers.php`: parse-error/Fatal до этого и ошибки «выше» PHP (nginx-прокси) не закрыты. `header_remove('X-Powered-By')` убирает заголовок PHP, но не заголовок, добавленный Apache/nginx. Исполнитель это честно указал. | Проверить на проде после деплоя: `curl -I /api/session.php` — нет `X-Powered-By`; `curl -I /api/holidays.php` (аноним) 401 без утечек путей. |
| R2-08 | info | `router.php` (dev) | На dev-роутере удалённый `/api/debug_token.php` отдаёт SPA-страницу (200, HTML 1 164 537 байт, не PHP-вывод токена). Это поведение dev-роутера, не дефект ветки. Подтверждаю замечание исполнителя. | `curl -i http://127.0.0.1:<port>/api/debug_token.php` на `php -S … router.php`. |
| R2-09 | info | — | `scripts/check_no_pii.sh` в ветке `hotfix/hf2-backend` отсутствует (его создаёт HF-1). Для HF-2 это ожидаемо; PII-скрипт нужно прогнать на объединённой ветке в HF-INT. В диффе HF-2 реальных ФИО/телефонов нет (плейсхолдер в `vacation_import.php:22` заменён на `<ФИО сотрудника>`, CRLF сохранён). | `bash scripts/check_no_pii.sh` после слияния HF-1+HF-2. |

## Проверка по списку ревью (п.5 задачи)

| Вопрос | Результат |
|---|---|
| Обход guard `PHP_SAPI` / порядок `declare` | OK. В `smoke_test.php`, `init_db.php`, `seed_positions.php` порядок: `<?php` → `declare(strict_types=1);` → guard (первый исполняемый оператор) → докблок → остальной код. Условие `PHP_SAPI !== 'cli'` отсекает и `cli-server` (dev `php -S`), и `apache2handler`/`cgi-fcgi`. `require_once` db.php/seed_positions.php в `init_db.php` стоят ниже guard. Других мест, которые подключали бы эти файлы под веб-SAPI, нет (`grep init_db\|seed_positions\|smoke_test` вне reports — только доки и `init_db.php → seed_positions.php`). Fatal под веб-SAPI нет (0 в логе сервера). |
| `require_admin` на всех пишущих методах `holidays.php` | OK. Логика `GET → require_auth()`, иначе `require_admin()` стоит до `switch`, значит покрывает POST/PUT/DELETE и любые прочие методы (HEAD тоже → 401). Прямых обходов нет: `X-HTTP-Method-Override`/`_method` в `api/*.php` не используется (grep пуст). OPTIONS обрабатывается до auth (`handleOptions()` → 204, preflight, без данных) — штатно. |
| Аудит reveal не пишет токен | OK. `audit($pdo,'relay.token_reveal',null,null,'relay','rpa_relay_token',null)`; actor/role берутся из сессии. Проверено SQL-ом по реальной записи после curl: `relay.token_reveal|admin|admin|relay|rpa_relay_token|[]`; вхождений значения токена в `details`+`entity_id`+`action`: 0. |
| `.htaccess` без `php_flag` | OK. `api/.htaccess`: `SetEnvIf Authorization …` сохранён + `<FilesMatch "^(smoke_test|debug_token|init_db|seed_positions)\.php$|\.(sql|md)$"> Require all denied </FilesMatch>`. `php_flag`/`php_value` нет. По `DEPLOY_HOSTLAND.md:14` `Require all denied` на Hostland работает (403), `php_flag` даёт 500. `schema.sql` остаётся в пакете и читается `db.php` через ФС — deny его не затрагивает. Синтаксис не проверен `apachectl` (на хосте нет) — см. R2-01/R2-07, проверка на проде. |

## Проверка diff против Scope

`git diff --stat main` / `main...HEAD`, ровно 1 коммит (`git rev-list --count main..HEAD` = 1), 10 файлов:
`api/.htaccess`, `api/debug_token.php` (удалён), `api/helpers.php`, `api/holidays.php`, `api/init_db.php`, `api/seed_positions.php`, `api/smoke_test.php`, `api/trip_relay.php`, `api/vacation_import.php`, `reports/HOTFIX_H0/HF-2_REPORT.md`. Все — из Scope. Запрещённое не тронуто: `index.html`, `js/*`, `DEPLOY_HOSTLAND.md`, `data/app.db`, `staff_project/`, `static/`, корневой `.htaccess`, `docs/`. Изменения в `vacation_import.php` — только строка примера (~22), CRLF сохранён. Изменения в `trip_relay.php` — только шапка-комментарий, ветка `reveal`; логика командировок не затронута. Лишних правок и дрейфа вне scope нет. Отклонений от спеки не найдено.

## Выполненные проверки (команда → результат)

Среда: PHP 8.3.6 CLI, worktree `/home/hermes/hf-wt/hf2`, ветка `hotfix/hf2-backend`, `git status` перед прогонами — чистый.

1. `php -l` для 7 изменённых PHP-файлов (helpers, holidays, init_db, seed_positions, smoke_test, trip_relay, vacation_import) → «No syntax errors detected» для всех.
2. `php api/smoke_test.php` (весь набор одной командой) → exit 0, `=== RESULTS: 84 passed, 0 failed out of 84 ===`, `DB intact: YES`. Новые [70]–[77] все PASS. После прогона `git status` показал `M data/app.db` → `git checkout -- data/app.db` → чисто.
3. `bash scripts/check_no_pii.sh` → файла в ветке нет (создаётся в HF-1), не применимо; см. R2-09.
4. Ручные curl на собственном `php -S 127.0.0.1:18791 router.php` (учётки dev-БД: admin, supervisor_zone0, viewer_test):
   - anon `POST`/`PUT`/`DELETE`/`GET`/`HEAD /api/holidays.php` → 401 (anon `OPTIONS` → 204);
   - anon `GET /api/trip_relay.php?action=reveal` → 401;
   - supervisor `POST`/`PUT`/`DELETE /api/holidays.php` → 403; supervisor `GET` → 200;
   - viewer `GET /api/holidays.php` → 200; viewer reveal → 403; supervisor reveal → 403;
   - admin reveal → 200 `{"success":true,"token":"<MASKED>"}` (токен dev-БД в отчёт не переношу);
   - admin `POST /api/holidays.php` → 201, `DELETE {"confirm":true}` → 200 (запись удалена);
   - `audit_log`: `relay.token_reveal|admin|admin|relay|rpa_relay_token|[]`; SQL-поиск значения токена по details+entity_id+action → 0;
   - `GET /api/smoke_test.php`, `/api/init_db.php`, `/api/seed_positions.php` → 404, size=0; `ps` до и после (smoke_test/init_db/seed_positions) — идентичны, процессов не запущено; `grep -ci fatal` в логе сервера = 0;
   - `GET /api/debug_token.php` → 200 HTML 1 164 537 байт = SPA-фолбэк dev-роутера (R2-08), не токен.
   - Заголовок `X-Powered-By` у `session.php`: моя curl-проверка по HEAD дала 405 (метод не поддерживается эндпоинтом, ошибка моего вызова), поэтому опираюсь на smoke-тест [77] — PASS (`headerValue(...,'X-Powered-By')===''` по GET).
5. `grep -rn "holidays\.php" index.html js` → пусто (фронтенд эндпоинт не вызывает, поломки UI нет); `grep -rn reveal index.html js` → пусто (UI supervisor'а reveal не использует, сужение прав UI не ломает).
6. `which apachectl apache2ctl httpd apache2` → пусто; `apachectl -t` не выполнен. `.htaccess` проверяется только на проде (R2-01, R2-07).
7. `git -C /home/hermes/hf-wt/hf2 checkout -- data/app.db` после всех прогонов; итог: `git status --short` пустой, процессов `php -S` на портах 18791/187xx не осталось.

## Остаточные риски / follow-up

- До деплоя: добавить явное удаление старых служебных файлов с прода (R2-01) и прогнать матрицу: `curl -I` на `smoke_test.php|debug_token.php|init_db.php|seed_positions.php|schema.sql|E8_SYNC.md` → 403/404; `session.php` работает (SetEnvIf цел) и без `X-Powered-By`.
- Смена `rpa_relay_token` (действие владельца) — после деплоя; при этом токен импорта по решению владельца не ротируется, поэтому 16 символов, отдававшиеся `debug_token.php`, остаются известными до его удаления.
- Прогнать `check_no_pii.sh` на объединённой ветке HF-1+HF-2 (HF-INT).

## Повторная верификация (run 130, после сбоя memguard)

Отчёт был написан в run 129; в run 130 результаты перепроверены независимо на том же коммите `6815089`: `php -l` ×7 — OK; `php api/smoke_test.php` — 84/84, DB intact; curl на `php -S 127.0.0.1:18833` — anon holidays POST/GET/PUT/DELETE 401, anon reveal 401, supervisor/viewer reveal 403, admin reveal 200, supervisor/viewer POST holidays 403 (GET 200), admin POST 201 / DELETE 200, служебные скрипты 404, `X-Powered-By` отсутствует, `audit_log` — `relay.token_reveal|admin|admin|relay|rpa_relay_token|[]`, Fatal в логе 0. Расхождений с содержимым отчёта нет, вердикт ACCEPT подтверждён. Dev-БД возвращена (`git status` в worktree пуст), сервер остановлен.
