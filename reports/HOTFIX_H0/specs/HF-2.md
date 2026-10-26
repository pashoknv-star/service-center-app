# HF-2 — Backend-хотфикс: auth в holidays.php, выключение display_errors, reveal только admin, служебные скрипты

Исполнитель: sd_worker_02. Роль: backend PHP.
Workspace: `dir:/home/hermes/hf-wt/hf2` — git worktree, ветка `hotfix/hf2-backend`, основа — `main`.
Ревью: HF-R2 (sd_worker_03). Интеграция: координатор (HF-INT).
Внешние эффекты: никаких. Не пушить, не трогать прод. Код должен работать на PHP 8.1 (прод) и 8.3 (dev); `php_flag` не использовать.

## Контекст

Находки аудита AUDIT-2026-10 (`reports/AUDIT_2026-10/A_SECURITY.md`; `AUDIT_REPORT.md` — сводные S-ID):
- S-05/A-06 (P1): `api/holidays.php` не подключает `auth.php`. Аноним на проде может делать POST/PUT/DELETE.
- S-19/A-12/F-03 (P2, входит в хотфикс): на проде `display_errors=On`. Fatal-ошибки с путём сервера видны анониму, отдаётся `X-Powered-By`.
- S-07/A-08 (P1, часть): `api/trip_relay.php?action=reveal` защищён `require_edit()`, поэтому supervisor получает токен робота.
- S-06/A-07/F-02 (P1): `api/smoke_test.php` (при веб-вызове делает `proc_open`), `api/debug_token.php` (отдаёт 8+8 символов токена импорта, без авторизации), `api/init_db.php`, `api/seed_positions.php`, `api/schema.sql`, `api/E8_SYNC.md` доступны по вебу на проде.
- После перезаписи истории (2026-10-26) в `api/vacation_import.php:22` в примере стоит плейсхолдер `Сотрудник NN`. Его нужно заменить нейтральным примером.

## Scope

Разрешено менять: `api/holidays.php`, `api/helpers.php`, `api/trip_relay.php`, `api/.htaccess`, `api/smoke_test.php`, `api/init_db.php`, `api/seed_positions.php`, `api/vacation_import.php` (только строка примера ~22), удалить `api/debug_token.php`. Отчёт — `reports/HOTFIX_H0/HF-2_REPORT.md`.

Запрещено:
- `index.html`, `js/*`, `DEPLOY_HOSTLAND.md` (это HF-1);
- логика командировок и форма (бэклог BL-01);
- `data/app.db` (после тестов `git checkout -- data/app.db`);
- `staff_project/`, `static/`, корневой `.htaccess`;
- остальные находки аудита (фазы H1+).

## Шаги

1. Базовая линия: `php api/smoke_test.php` на `main` (ожидается 76/76).
2. `api/holidays.php`: после `require_once __DIR__ . '/db.php';` добавить `require_once __DIR__ . '/auth.php';`. До `switch` поставить: метод `GET` → `require_auth()`, остальные методы → `require_admin()`. Проверить grep'ом, что фронтенд `holidays.php` не вызывает (календарь берётся из `holidays_provider.php` — его не трогать).
3. `api/helpers.php` — сразу после `declare(strict_types=1);`:
   ```php
   ini_set('display_errors', '0');
   ini_set('log_errors', '1');
   if (!headers_sent()) { header_remove('X-Powered-By'); }
   ```
   Замену `getMessage()` в catch-блоках не делать — это фаза H2.
4. `api/trip_relay.php` `?action=reveal`: заменить `require_edit()` на `require_admin()`. Добавить запись аудита `relay.token_reveal` через существующую `audit()` из helpers.php: сигнатуру посмотреть в коде, значение токена в аудит не писать. Обновить комментарий в шапке файла (сейчас там «admin/supervisor»).
5. Служебные скрипты:
   - `git rm api/debug_token.php`. Ссылки на него вне `reports/` перечислить в отчёте: правку `DEPLOY_HOSTLAND.md` делает HF-1, `docs/` не трогать.
   - В `api/smoke_test.php`, `api/init_db.php`, `api/seed_positions.php` первым исполняемым оператором после `declare(strict_types=1);` (если declare есть) поставить: `if (PHP_SAPI !== 'cli') { http_response_code(404); exit; }`.
   - В `init_db.php` старый CLI-guard через `STDERR` (стр. 17-22) заменить или оставить после нового — главное, чтобы под веб-SAPI не было Fatal.
6. `api/.htaccess` — существующую строку `SetEnvIf Authorization …` сохранить, дописать:
   ```apache
   <FilesMatch "^(smoke_test|debug_token|init_db|seed_positions)\.php$|\.(sql|md)$">
     Require all denied
   </FilesMatch>
   ```
   Apache 2.4, без `php_flag`. `api/schema.sql` остаётся в пакете: его читает `db.php` через ФС, не по HTTP.
7. `api/vacation_import.php:22` — в примере JSON заменить значение `employeeName` на `"<ФИО сотрудника>"`.
8. `api/smoke_test.php` — новые проверки, все через HTTP к поднятому smoke-серверу:
   - аноним: `GET holidays.php` → 401, `POST holidays.php` → 401;
   - supervisor: `POST holidays.php` → 403;
   - admin: `POST` → 201 и `DELETE {"confirm":true}` → 200, с уборкой за собой;
   - `trip_relay.php?action=reveal`: viewer → 403, supervisor → 403, admin → 200;
   - после reveal admin'ом в `audit_log` есть `relay.token_reveal`;
   - ответ `session.php` не содержит `X-Powered-By`.

   Учётки берутся из существующих фикстур smoke. Если viewer нет — создать во временной БД smoke так же, как это уже делает smoke для своих фикстур.

## Критерии приёмки

1. `php -l` проходит для каждого изменённого PHP-файла.
2. `php api/smoke_test.php` — 100% pass (76 старых + новые). dev-БД возвращена (`git status` чистый, кроме коммита).
3. Ручная проверка curl на локальном `php -S` с приложенным выводом: аноним `POST /api/holidays.php` → 401; supervisor reveal → 403; admin reveal → 200 (токен в отчёте замаскировать).
4. Веб-вызов скриптов под dev-сервером (router.php не исполняет `.htaccess`, поэтому проверяется только guard): `curl /api/smoke_test.php` и `/api/init_db.php` → 404 без запуска процессов (`ps` до и после) и без Fatal.
5. `api/.htaccess` синтаксически корректен для Apache 2.4. Если доступен `apachectl -t` — приложить вывод; иначе пометить «проверка на проде после деплоя (матрица HF-1)».
6. Один коммит на ветке `hotfix/hf2-backend`. `git diff --stat main` — только файлы из Scope.
7. Отчёт `reports/HOTFIX_H0/HF-2_REPORT.md` в ветке: что сделано, команды → результаты, отклонения от спеки.

## Возврат

`kanban complete` с итогом и путём к отчёту. При блокере — `kanban block` с причиной.
