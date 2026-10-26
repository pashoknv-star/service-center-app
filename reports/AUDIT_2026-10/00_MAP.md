# AUDIT 2026-10 — Карта системы и поверхность атаки (шаги 1–2 методики)

Автор: software-development-coordinator. Коммит: `101c846` (main, дерево чистое). Дата: 2026-10-25.
Режим: **ревью + план, ничего не правь.**

## 1. Архитектура и поток данных

```
Браузер (index.html монолит ~1,17 МБ, inline JS/CSS; js/storage.js; js/trips.js)
  │  cookie PHPSESSID (HttpOnly, SameSite=Lax, secure=false), fetch same-origin
  ▼
api/*.php  (без фреймворка; helpers.php: sendJson/corsHeaders(ACAO:*)/getJsonBody/audit)
  │  auth.php: session_start() при include; current_user() = SELECT * FROM users по $_SESSION['user_id']
  │  роли: is_admin → admin; can_edit → supervisor (scope_group_id); иначе viewer
  ▼
db.php: Database singleton → PDO sqlite data/app.db (WAL, foreign_keys=ON, busy_timeout=5000)
        migrate(): schema.sql + applyIncrementalMigrations() + migrateLegacyTrips() — на первом HTTP-запросе
```

- **Загрузка:** `StorageAdapter.load()` → `GET api/load.php` (полный ScheduleState + `lastSyncId`).
- **Сохранение:** `StorageAdapter.save()/saveVacation()` → `POST api/save.php` (полный upsert, freshness-протокол E10-6, guard'ы массового стирания).
- **Дельта-синхронизация:** polling `GET api/sync.php?afterId=N` (+ на focus); `POST/PUT/DELETE sync.php` — запись (require_edit).
- **Командировки:** `js/trips.js` → `api/trips.php` (GET список; POST/PUT/DELETE; `?action=confirm` → создаёт `trip_requests` для робота).
- **RPA HelpMe:** робот → `api/trip_relay.php` (`X-Auth-Token` = `meta.rpa_relay_token`, poll/callback); `?action=reveal` — показ токена (require_auth+require_edit → supervisor тоже!).
- **Внешний импорт отпусков:** `POST api/vacation_import.php` (Bearer = `meta.external_api_token`), поиск сотрудника по id/ФИО.
- **Аудит:** `audit()` в helpers.php → `audit_log`; очистка 7 дней (5% вероятность на мутацию + db.php cleanupAuditLog); выгрузка `api/audit_export.php` (admin, csv/md/xlsx).
- **Фото:** `POST upload.php` (корневой делегат) → `api/upload.php` (require_edit; GD/Imagick → 512×512 WebP, `images/photo_<time>_<rand>.webp`).
- **Календарь:** `api/holidays_provider.php?year=` (читает `data/holidays/{year}.json`, fallback-генерация); `api/holidays.php` CRUD.

## 2. Поверхность атаки (входы)

| Эндпоинт | Методы | Авторизация (по коду) | Входы |
|---|---|---|---|
| api/login.php | POST | — | JSON username/password |
| api/logout.php | POST | — | cookie |
| api/session.php | GET | — | cookie |
| api/change_password.php | POST | require_auth | JSON currentPassword/newPassword |
| api/load.php | GET | require_auth | — |
| api/reset.php | GET | require_auth | — (полный дамп как load) |
| api/export.php | GET | require_auth (**viewer тоже**) | ?download=1 |
| api/save.php | POST | require_auth+require_edit (+ зоны/guard внутри) | JSON полный state |
| api/sync.php | GET / POST,PUT,DELETE | auth / edit | ?afterId, JSON |
| api/entries.php | GET/POST/PUT/DELETE | auth / edit (+admin для force) | ?employeeId&date&year, JSON |
| api/employees.php | GET/POST/PUT/DELETE | auth / edit | ?id, JSON |
| api/groups.php, api/positions.php | GET/POST/PUT/DELETE | auth / edit | ?id, JSON |
| **api/holidays.php** | GET/POST/PUT/DELETE | **НЕТ НИКАКОЙ (не подключает auth.php)** | ?date/?id, JSON |
| api/holidays_provider.php | GET | — | ?year (int, 2000–2100) |
| api/trips.php | GET / POST,PUT,DELETE | auth / edit (+зона) | ?id, ?action=confirm, JSON |
| api/trip_relay.php | poll/callback; ?action=reveal | X-Auth-Token / reveal: auth+edit | заголовок, JSON |
| api/vacation_import.php | POST | Bearer external_api_token (hash_equals) | JSON |
| api/import.php | POST | require_admin | JSON backup (DELETE всех таблиц + заливка) |
| api/audit_export.php | GET | require_admin | ?format, ?days |
| api/upload.php, /upload.php | POST | auth+edit | multipart photo |
| **api/debug_token.php** | любой | **НЕТ** | Authorization → отдаёт `stored_token_preview` (8+8 символов реального токена) и эхо заголовка |
| **api/smoke_test.php** | любой | **НЕТ** | при веб-вызове делает proc_open(`php -S`) и (если сервер поднимется) ПИШЕТ в data/app.db |
| api/init_db.php, api/seed_positions.php | любой | CLI-guard (init_db падает Fatal на STDERR) | — |
| router.php | только dev (php -S) | — | REQUEST_URI |

CORS: `Access-Control-Allow-Origin: *` на всех JSON-ответах, Methods GET,POST,PUT,DELETE,OPTIONS; Headers Content-Type, Authorization, X-Requested-With (без X-Auth-Token). Без `Allow-Credentials`.

## 3. Прод — анонимные GET/HEAD (2026-10-25, http://host1882970.hostland.pro)

| URL | Код | Вывод |
|---|---|---|
| / , /index.html | 200, 1 168 199 Б, gzip, ETag, без Cache-Control | монолит |
| /api/holidays.php | **200 `[]`** анонимно | эндпоинт без auth на проде |
| /api/debug_token.php | **401 JSON** (файл на проде, исполняется) | утечка префикса/суффикса токена при любом Bearer |
| /api/smoke_test.php | **200, PHP Fatal error с полным путём** | на проде; анонимный GET запускает proc_open (упал на «Server did not start», стр. 224 — до фикстур БД) |
| /api/init_db.php | **200, PHP Fatal error с полным путём** | display_errors=On на проде |
| /api/seed_positions.php | 200 пусто | на проде |
| /api/schema.sql, /api/E8_SYNC.md | 200 | раскрытие схемы/протокола |
| /docs/API_DOCUMENTATION.json | 200 | раскрытие API-документации |
| /data/app.db, -wal, -shm, /data/holidays/*.json | 403 | ок |
| /.git/HEAD, /.htaccess, /api/.htaccess | 403 | ок |
| /images/, /api/, /js/, /static/ | 403 | листинг закрыт |
| /js/trips.js, /js/storage.js | 200 | |
| /CODEMAP.md, /AGENTS.md, /test_*.php, /router.php, /reports/ | 404 | не выложены |
| /api/session.php | 200 | заголовки: нет CSP/XCTO/XFO/Referrer-Policy; `X-Powered-By: PHP/8.1.34` |

⚠️ **Для всех исполнителей:** НЕ запрашивать на проде `api/smoke_test.php`, `api/init_db.php`, `api/seed_positions.php`, `api/debug_token.php` с заголовком Authorization — первый спаунит процесс на хостинге, последний раскрывает фрагмент реального токена. Карта выше уже содержит их коды ответа.

## 4. Разбиение аудита (Hermes Kanban)

| Блок | Исполнитель | Отчёт |
|---|---|---|
| Карта + A (безопасность) | coordinator | `A_SECURITY.md` |
| B (корректность/надёжность) | sd_worker_01 | `B_CORRECTNESS.md` |
| C (БД) + D (производительность) | sd_worker_02 | `CD_DB_PERF.md` |
| E (frontend) + F (инфраструктура) | sd_worker_03 | `EF_FRONT_INFRA.md` |
| G (качество/тесты) | sd_worker_04 | `G_QUALITY.md` |
| Сводный отчёт (формат §1–9 промпта) | coordinator | `AUDIT_REPORT.md` |
