# AUDIT 2026-10 — Сводный отчёт: «Пульт управления СЦ Урай» (service-center-app)

Коммит `101c846` (main). Дата 2026-10-25. Координатор: software-development-coordinator.
Режим: **ревью + план, ничего не правилось** — код, БД, конфиги, git-история и прод не изменялись. Dev-БД после проверок возвращена (`git checkout -- data/app.db`). Атаки — только на локальном dev (worktree). К проду — только анонимные GET/HEAD.

| Блок | Исполнитель | Kanban | Отчёт | Находок |
|---|---|---|---|---|
| Карта + A (безопасность, ПДн) | coordinator | t_5e70ac67 | `A_SECURITY.md`, `00_MAP.md` | 21 |
| B (корректность, надёжность) | sd_worker_01 | t_9810bd57 | `B_CORRECTNESS.md` | 23 |
| C (БД) + D (производительность) | sd_worker_02 | t_20e9e4e5 | `CD_DB_PERF.md` | 16 |
| E (frontend) + F (инфраструктура) | sd_worker_03 | t_15c92107 | `EF_FRONT_INFRA.md` | 14 |
| G (качество, тесты) | sd_worker_04 | t_8e772872 | `G_QUALITY.md` | 11 |

Сырые находки: 85. После объединения дублей — **56 сводных: P0 — 1, P1 — 14, P2 — 26, P3 — 15**.
Детали каждой находки (код, сценарий, патч, уверенность) — в отчёте блока под исходным ID. Ниже — сведение, разрешение конфликтов и план.

## 1. Резюме

- **Главный риск сейчас:** ПДн сотрудников уже раскрыты анониму.
  - Прод-`index.html` (sha1 совпадает с репозиторием) без логина отдаёт около 45 карточек сотрудников: 38 полных ФИО с отчеством, должности, населённые пункты и снимок графика отсутствий (S-01, P0).
  - Те же данные лежат в git-истории с базового коммита.
- **Модель прав на сервере не соблюдается.**
  - Supervisor обходит зону и approved-guard через REST-эндпоинты; viewer удаляет записи через `PUT sync.php` (S-03).
  - Хранимый XSS в карточке и матрице превращает supervisor'а в admin'а (S-02).
  - `holidays.php` пишется анонимно (S-05).
  - Защиты от CSRF фактически нет: `*.hostland.pro` — один «сайт» для браузера (S-04).
- **Прод содержит служебные скрипты** (`smoke_test.php` порождает процессы по анонимному GET, `debug_token.php` раскрывает часть токена), `display_errors=On` (S-06, S-19).
- **Функциональный отказ на проде:** форма командировки не сохраняет (S-12). Поток RPA ненадёжен: токен робота раскрывает supervisor, заявки выдаются не более одного раза, request_id неуникален (S-07); удалённые командировки остаются в очереди (S-10).
- **Целостность данных:** восстановление `import.php` из собственного экспорта стирает участников командировок (S-11). Freshness-защита E10 обходится через ротацию `sync_log` (S-13). Параллельные записи падают с `database is locked` (S-09).
- **Вывод:** эксплуатация в текущем виде допустима только как временная.
  - Немедленно (хотфикс до любых новых функций): убрать ПДн из `index.html` (S-01), удалить служебные скрипты с прода (S-06), закрыть `holidays.php` (S-05), починить форму командировок (S-12).
  - Сразу за хотфиксом — серверная авторизация (S-03), XSS (S-02), CSRF (S-04), relay (S-07).
  - Деплой — только по команде владельца «Деплой».
- SQL-инъекций, XXE, десериализации, command injection, SSRF, open redirect и RFI в рабочем коде нет.

## 2. Карта системы и поверхность атаки (кратко; полностью — `00_MAP.md`)

```
Браузер: index.html (монолит 1,17 МБ, inline JS/CSS) + js/storage.js (StorageAdapter) + js/trips.js
  │ cookie PHPSESSID (HttpOnly, SameSite=Lax, secure=false), fetch same-origin, polling sync.php
  ▼
api/*.php → auth.php (session, роли: admin / supervisor(scope_group_id) / viewer) → db.php (PDO SQLite WAL, FK=ON,
  busy_timeout, миграции на первом запросе) → data/app.db
Машинные акторы: внешняя система → vacation_import.php (Bearer); робот HelpMe ↔ trip_relay.php (X-Auth-Token: poll/callback)
```

**Входы:**
- Сессия: `login` / `logout` / `session` / `change_password`.
- Чтение: `load`, `export`, `reset` — полный дамп для любой роли.
- Запись: `save` (полный upsert + E10-guard'ы), `sync` (GET дельта; POST/PUT/DELETE), `entries`, `employees`, `groups`, `positions`, `trips` (`?action=confirm`).
- Без аутентификации: **`holidays` (CRUD!)**, `holidays_provider`.
- Машинные: `trip_relay` (`?action=reveal` — supervisor+), `vacation_import`.
- Только admin: `import`, `audit_export`.
- Загрузка фото: `upload` (multipart).
- Служебные, на проде: **`debug_token`, `smoke_test`, `init_db`, `seed_positions`**.

**Доступно на проде анонимно** (GET/HEAD 2026-10-25):
- `/` и `/index.html` — с ПДн (S-01);
- `/js/*.js`;
- `/api/holidays.php` — 200;
- `/api/smoke_test.php`, `/api/init_db.php` — 200 с Fatal и путём;
- `/api/debug_token.php` — 401, исполняется;
- `/api/seed_positions.php` — 200;
- `/api/schema.sql`, `/api/E8_SYNC.md`, `/docs/API_DOCUMENTATION.json` — 200.

**Закрыто** (403/404): `/data/*` (включая `-wal`/`-shm`), `/.git/`, `.htaccess`, листинги каталогов; `CODEMAP.md`, `AGENTS.md`, `test_*`, `router.php`, `reports/` не выложены.

## 3. Таблица находок (сводная, по приоритету)

| ID | P | CVSS | Кат. | Место (основное) | Заголовок | Исходные находки | Статус риска |
|---|---|---|---|---|---|---|---|
| S-01 | P0 | 7.5 | A | index.html:1994, 2105-2419 | ПДн сотрудников (≈45 карточек, 38 полных ФИО) + должности + график в статическом index.html — анониму на проде и в git-истории | A-01, F-01, D-02 | — |
| S-02 | P1 | 8.7 | A | index.html:4647-4654, 3605-3608; api/employees.php:137-139; api/positions.php:57-59 | Хранимый XSS (ФИО/должность/локация/photoUrl/группа) → действия от имени admin | A-02 | — |
| S-03 | P1 | 7.1 | A | api/employees.php:89-91,137-139,239-241; api/groups.php:57-59,83-85,132-134; api/positions.php:57-59,83-85,… | Обход роли/зоны/approved-guard: supervisor через employees/groups/positions/entries/save.php; viewer удаляет через PUT/DELETE sync.php; 9 inline-копий правил | A-03, G-01, A-04 | — |
| S-04 | P1 | 6.8 | A | api/helpers.php:65-78; api/auth.php:314-319 | CSRF с same-site `*.hostland.pro` (не в PSL) + приём text/plain | A-05 | — |
| S-05 | P1 | 6.5 | A | api/holidays.php:20-23, 59-150 | holidays.php без аутентификации: анонимная запись/удаление на проде | A-06 | — |
| S-06 | P1 | 6.5 | A | api/smoke_test.php:200-224; api/debug_token.php:11-67; api/init_db.php:17-22 | Служебные/тестовые скрипты на проде (smoke_test proc_open, debug_token, init_db, schema/docs); прод-пакет не по allowlist; smoke пишет в боевую БД | A-07, F-02, C-06, G-07 | — |
| S-07 | P1 | 7.6 | A | api/trip_relay.php:103-110, 115-209 | Relay: reveal токена supervisor'у; at-most-once без повторной выдачи, callback last-write-wins; request_id неуникален — заявка HelpMe тихо не создаётся | A-08, B-11, B-09 | — |
| S-08 | P1 | — | B | js/storage.js:459-491; index.html:5306-5329 | Сбой load.php → тихий откат на localStorage, сохранения без курсора свежести | B-01 | — |
| S-09 | P1 | — | B | api/save.php:69; trips.php:435,582,630,807; sync.php:106; trip_relay.php:118; import.php:50; vacation_impor… | Deferred BEGIN: параллельные записи мгновенно падают с 500 «database is locked» | B-07 | — |
| S-10 | P1 | — | B | api/trips.php:578-605, 714-886; api/trip_relay.php:120-141 | Очередь RPA не отражает удаление/правку подтверждённой КМ; trip_requests без FK — робот оформляет удалённую командировку | B-10, C-05 | — |
| S-11 | P1 | — | B | api/import.php:50-171; api/export.php | import.php из выгрузки export.php стирает trip_participants, сбрасывает версии, не пишет sync_log | B-18, C-03 | — |
| S-12 | P1 | — | B | js/trips.js:1655 | Форма командировки не сохраняет (ReferenceError phoneEl, удалённые поля, нет maskPhoneField) — создание/правка КМ на проде невозможны | B-19, E-01 | — |
| S-13 | P1 | — | C/B | api/save.php:55-60, :289; api/sync.php:231-235 | Ротация sync_log + безусловный employee-upsert ослепляют freshness E10-6: устаревшая вкладка перезаписывает/воскрешает данные | C-01, B-21, B-17 | — |
| S-14 | P1 | — | G | api/smoke_test.php; scripts/*; api/save.php:202-247,328-351,621-645,138-174 | Нет тестов guard'ов E10, relay, import-восстановления, безопасности | G-03 | — |
| S-15 | P1 | — | G (+B) | api/db.php:292-323,430; api/save.php:492; index.html:2762 | Legacy status=trip не закрыт на сервере; конверсия legacy↔server стирает комментарии и смешивает approval | G-04, B-02 | — |
| S-16 | P2 | 6.1 | A | api/audit_export.php:123-139; api/login.php:45 | CSV/формульная инъекция в аудит, источник — анонимный логин | A-09 | — |
| S-17 | P2 | 6.5 | A | api/login.php:38-47; api/change_password.php:53 | Нет rate limit/блокировки, перечисление логинов по таймингу, минимум 8 символов | A-10 | — |
| S-18 | P2 | 4.8 | A | api/change_password.php:49-73; api/auth.php:314-320 | Смена пароля не завершает другие сессии; нет idle/absolute тайм-аута | A-11 | — |
| S-19 | P2 | 5.3 | A | api/helpers.php:124-127 + 19 catch (G-10); прод display_errors | Раскрытие исключений/путей (display_errors=On на проде, getMessage() в 19 catch), разнобой формата ошибок | A-12, F-03, G-10 | — |
| S-20 | P2 | 4.2 | A | api/helpers.php:37-46; прод-заголовки | Нет CSP, X-Content-Type-Options, X-Frame-Options, Referrer-Policy | A-13 | — |
| S-21 | P2 | 4.8 | A | api/trip_relay.php:50-64; api/init_db.php:180-185; data/app.db (git, 14 коммитов) | Токены открытым текстом, без ротации; dev-БД с хешами/токеном в git | A-14 | — |
| S-22 | P2 | 6.5 | A | api/export.php:27; api/load.php; api/reset.php | Полный дамп ПДн для viewer (export/reset) без аудита; журнал безопасности не пишет 401/403, reveal, выгрузки, отказы relay/import | A-15, F-05 | видимость — проектное решение E8-4; отсутствие аудита — дефект |
| S-23 | P2 | — | A | api/schema.sql:202-214; api/helpers.php:242-245; DEPLOY_HOSTLAND.md §6 | Удержание ПДн: trip_requests.payload бессрочно, нет VACUUM; аудит 7 дней с чисткой на каждом запросе; фото удалённых сотрудников | A-16, C-08, F-06 | — |
| S-24 | P2 | 6.4 | A | вся система (HTTP) | Отсутствие TLS: пароли, cookie, токены, ПДн, JS открытым текстом | A-17 | **риск принят владельцем** |
| S-25 | P2 | — | B | api/db.php:100-138, 292-439 | Миграции на первом HTTP-запросе без транзакции/блокировки: 500 и дубли legacy-КМ при гонке | B-06, C-09 | — |
| S-26 | P2 | — | B | api/save.php:439-455, 565-586, 736-796 | Нет серверной валидации полей записей/праздников/балансов и CHECK в схеме; одна битая запись → 500 всего save | B-08, C-04 | — |
| S-27 | P2 | — | B | api/trips.php:716-754, 829-852 | PUT status=confirmed обходит ?action=confirm — заявки не создаются | B-12 | — |
| S-28 | P2 | — | B | api/trips.php:548, 724-733, 807-852 | Проверка версии trips вне транзакции — потерянное обновление | B-13 | — |
| S-29 | P2 | — | B | api/vacation_import.php:195-210, 374-403 | Перенос отпуска оставляет призрачные дни; импорт не идемпотентен | B-15 | — |
| S-30 | P2 | — | B | api/vacation_import.php:299-301, 341-342 | date_create молча сдвигает несуществующие/неоднозначные даты; статусы не валидируются | B-16 | — |
| S-31 | P2 | — | B | js/trips.js:249, 299, 332, 371-406, 2123-2141; api/sync.php:42-82 | Дельта-синхронизация: курсор КМ := версия, нет RPA-полей; смена approval не применяется; lastSyncId читается после данных | B-20, B-03, B-05 | — |
| S-32 | P2 | — | C | api/sync.php:237-240, :178-189 | Поиск записи по конкатенации ключа (employee_id + ':' + date) — полный скан на каждое событие (13–14 с) | C-02 | — |
| S-33 | P2 | 4.3 | D | api/upload.php:48-60, :78-92 | Upload: нет лимита пикселей (PNG 8 КБ держит воркер >100 с); аудит photo.upload — мёртвый код | D-01, A-18 | — |
| S-34 | P2 | — | D | index.html:3553-3725, :3655-3662 | Полная перерисовка матрицы ~0.5 с, ~100 тыс. addEventListener за рендер | D-03 | — |
| S-35 | P2 | — | D | index.html:2486-2487; прод-заголовки | Статика без Cache-Control и версий — старый JS после деплоя | D-05 | — |
| S-36 | P2 | — | E | index.html:4759, 5246-5252, 2721-2727; js/storage.js:522-531 | render() → полный save(): 403-спам у viewer, лишние upsert'ы; ошибки save и 401 не видны пользователю | E-02, B-04 | — |
| S-37 | P2 | — | E | index.html:2661-2666; js/trips.js:48, 429-436 | Выход не очищает DOM/localStorage/роль модуля КМ — ПДн видны следующему пользователю ПК до логина; logout пишет actor=api | E-03, A-21 | — |
| S-38 | P2 | — | F | DEPLOY_HOSTLAND.md:62, 103-115; reports/E12_DEPLOY.md:38-39; api/export.php:36-114 | Бэкапы: нет проверки результата/целостности и восстановления, WAL-ловушка при откате, ротация удаляет удачные копии, ПДн в открытом виде | F-07, C-07 | — |
| S-39 | P2 | — | F | api/db.php:27, 505-509; data/.htaccess:3; DEPLOY_HOSTLAND.md:80 | БД с ПДн в веб-корне, один рубеж защиты | F-09 | — |
| S-40 | P2 | — | G | index.html:3885-3913; js/trips.js:2069-2104; api/auth.php:107-119 | Две модели зоны во фронтенде; матрица определяет зону по username | G-02 | — |
| S-41 | P2 | — | G | docs/API_DOCUMENTATION.json | Документация API не обновлялась с baseline: нет trips/relay/audit_export, неверные auth/методы/коды | G-09 | — |
| S-42 | P3 | 0.0 | A | api/helpers.php:23-29 | CORS `*` без credentials: риска чтения с cookie нет, но политика избыточна | A-19 | — |
| S-43 | P3 | — | A | index.html:5 | Google Fonts: IP сотрудников уходит третьей стороне, без SRI | A-20 | — |
| S-44 | P3 | — | B | api/trips.php:79-87, 193-225, 247-288, 414-420 | Неполная валидация trips (2026-02-30, дубли участников → 500, аванс, телефон) | B-14 | — |
| S-45 | P3 | — | B | api/helpers.php:85-88, 266-282; api/db.php:358, 480-494 | Смешение date('c')/gmdate в строковых сравнениях ts; NULL ts в audit_log | B-22 | — |
| S-46 | P3 | — | B | api/holidays_provider.php:46-123 | Календарь вне 2026–2028 — молчаливый упрощённый fallback | B-23 | — |
| S-47 | P3 | — | C | api/schema.sql:132,190; api/entries.php:70-73 | Избыточный/неверный индекс, не-sargable фильтр года | C-10 | — |
| S-48 | P3 | — | D | api/trips.php:154-182, :388-397; js/trips.js:2123-2141 | N+1 в trips, посуточный цикл без лимита периода, второй поллер | D-06 | — |
| S-49 | P3 | — | E | js/trips.js:1053-1056, 429-446, 1233-1245 | Viewer видит «+ Новая командировка» | E-04 | — |
| S-50 | P3 | — | E | index.html:47-55, 2041 | Шапка viewer >960px: поиск съезжает влево | E-05 | — |
| S-51 | P3 | — | F | images/.htaccess:2-5 | php_flag vs Hostland; запрет только `\.php$` | F-04 | — |
| S-52 | P3 | — | F | DEPLOY_HOSTLAND.md:72-82 | §4: нет бэкапа БД, chmod, mkdir, удаления устаревших файлов | F-08 | — |
| S-53 | P3 | — | G (+C) | api/load.php:36-169; api/reset.php:30-130; api/export.php:33-138 | Тройная копия сборки состояния (load/reset/export), reset.php мёртв; неограниченные выборки всех лет, JSON_PRETTY_PRINT | G-05, D-04 | — |
| S-54 | P3 | — | G | js/trips.js:987,1291,1499,1874,2866,3001; index.html:3460,4016,4029,5598 | Мёртвый код: legacy-модалка командировок, невызываемые helpers/CSS | G-06 | — |
| S-55 | P3 | — | G | CODEMAP.md | CODEMAP устарел (50/237 ссылок смещены), не покрывает api/ | G-08 | — |
| S-56 | P3 | — | G | index.html:6-1948, 2488-5819 | Монолит index.html; бизнес-правила продублированы в UI | G-11 | — |

**Разрешение дублей и конфликтов приоритетов (решение координатора):**
- **S-01** (A-01, F-01, D-02): одна причина — пререндер и `defaultData` в `index.html`. Расхождение «45 сотрудников» (F-01) и «38» (A-01) — разные метрики: около 45 карточек в `defaultData`, из них у 38 полное ФИО с отчеством. Перепроверено скриптом.
- **S-03** (A-03, A-04, G-01): A-04 — отдельный путь для viewer, корневая причина та же (правила продублированы inline, G-01). Исправление общее — единая политика авторизации.
- **S-06** (A-07, F-02, C-06, G-07): прод-пакет без allowlist. C-06 и G-07 — тестовая сторона: smoke пишет в `data/app.db` мимо `SC_APP_DB`, сиротский `php -S`.
- **S-07** (A-08, B-09, B-11): одна подсистема relay. B-09 подтверждён координатором по коду: `substr($tripId,0,4)` всегда даёт `"trip"`, поэтому две подтверждённые в одну секунду КМ получают одинаковый `request_id`.
- **S-13** (C-01, B-17, B-21): C-01 (P1) показал потерю данных, поэтому кластер P1.
- **S-25** (B-06 P1 / C-09 P3) → **P2**: гонка возможна только на первом запросе после выкладки новой схемы. Её гасит процедурный прогрев (один GET сразу после деплоя), дубли разовые. Код всё равно исправлять (транзакция + `BEGIN IMMEDIATE`).
- **S-33** (A-18 P3 / D-01 P2) → **P2**: DoS одного воркера на >100 с подтверждён на dev.
- **S-37** (A-21 P3 / E-03 P2) → **P2**: на общих ПК кэш ПДн рендерится до логина.
- **S-15** (G-04, B-02): B-02 подтверждён на dev (стирание комментариев) — P1.
- Остальные кластеры — одинаковые приоритеты в исходных отчётах.

**Выборочная верификация отчётов воркеров** (AC: находка опирается на код, место точное):
- B-19/E-01 — `js/trips.js:1655` `phoneEl` не объявлен;
- B-09 — `api/helpers.php:116`;
- C-03 — `import.php:53-58` очищает `employees` → CASCADE на `trip_participants`, а `export.php` их не выгружает;
- G-01 п. D — `sync.php:95-101`, воспроизведено координатором на dev (viewer PUT → 200);
- B §6 — `save.php` балансы и самосогласование перепроверены по коду.

Все ссылки на чужие ID в A_SECURITY.md (20 штук) существуют в отчётах блоков. Ложных срабатываний при выборке не найдено.


## 4. Детальное описание находок

Полный формат (ID, приоритет, CVSS для уязвимостей, категория/CWE, `файл:строка`, доказательство, сценарий, последствия, патч PHP 8.1 без `php_flag`, уверенность, статус риска) — в отчётах блоков под исходными ID:

- `A_SECURITY.md` §3 — A-01…A-21 (CVSS 3.1 рассчитан по формуле спецификации);
- `B_CORRECTNESS.md` §3 — B-01…B-23;
- `CD_DB_PERF.md` §3 — C-01…C-10, D-01…D-06 (с замерами);
- `EF_FRONT_INFRA.md` §3 — E-01…E-05, F-01…F-09;
- `G_QUALITY.md` §3 — G-01…G-11 (с прогоном тестов).

Ниже — сжатая выжимка для P0/P1 (что сломано → что делать).

| ID | Суть и доказательство | Исправление (из отчёта блока) |
|---|---|---|
| S-01 | Строка `index.html:1994` (933 КБ пререндера матрицы) и `defaultData` 2105-2419; прод GET `/` → тот же sha1 | Пустой `<tbody id="matrixBody">`, пустой `defaultData`; pre-deploy grep на ФИО = 0; решить вопрос переписывания git-истории и видимости репозитория |
| S-02 | `innerHTML` с `emp.name/role/location/photo` (`index.html:4647-4654, 3605-3608`); payload сохранён supervisor'ом через `PUT employees.php` → 200 | `escHtml()` во всех сборках HTML, whitelist `photo_url` (regexp) на сервере, CSP |
| S-03 | employees/groups/positions/entries — только `require_edit`; `save.php:582` approval из тела; `save.php:734-796` балансы без admin; `sync.php:95` edit только для POST | Единые `authorize_employee_write` / `authorize_entry_write`; справочники и DELETE сотрудника — `require_admin`; `sync.php`: `require_edit` для всех не-GET |
| S-04 | `getJsonBody` без проверки Content-Type; `text/plain` + чужой Origin → 201; hostland.pro не в PSL | `require_same_origin_json()`: `application/json` + Origin == Host + `X-Requested-With`; долгосрочно — свой домен |
| S-05 | `holidays.php` не подключает `auth.php`; анонимный POST/PUT/DELETE на dev → 201/200/200; прод GET 200 | `require_auth` для GET, `require_admin` для записи |
| S-06 | Прод: `smoke_test.php` 200 + Fatal (proc_open), `debug_token.php` исполняется (8+8 символов токена) | Удалить с прода; allowlist-сборка; `api/.htaccess` FilesMatch deny; `PHP_SAPI !== 'cli'` → 404 |
| S-07 | `reveal` под `require_edit` (supervisor → 200); delivered без повторной выдачи; callback last-write-wins; неуникальный `request_id` | `reveal` → `require_admin` + audit + rotate; lease/TTL повторной выдачи; переход callback только из `delivered`; `request_id` из `random_bytes` |
| S-08 | Сбой `load.php` → тихий fallback на localStorage, дальнейшие сохранения без freshness-курсора | Блокирующая ошибка + read-only режим вместо fallback (B-01) |
| S-09 | Deferred BEGIN → `SQLITE_BUSY` без ожидания busy_timeout → 500 | `BEGIN IMMEDIATE` во всех пишущих транзакциях (B-07) |
| S-10 | Удаление/правка подтверждённой КМ не отзывает `trip_requests`; нет FK | Отзыв/обновление заявки в той же транзакции, FK/статус `cancelled` (B-10, C-05) |
| S-11 | `import.php:53-58` → CASCADE `trip_participants`; `export.php` их не выгружает; версии сброшены | Выгружать и восстанавливать `trips`/`trip_participants`/`trip_requests`, валидация до DELETE, sync_log-событие «reset» (B-18, C-03) |
| S-12 | `js/trips.js:1655` `phoneEl` не объявлен → ReferenceError; на проде тот же файл | `var phoneEl = document.getElementById('tripPhone')`, вернуть удалённые поля / экспорт `maskPhoneField` (E-01) + E2E-тест |
| S-13 | `sync_log` ротируется на 10 000, employee-upsert на каждый save → курсор устаревшей вкладки «свеж» | Детект разрыва курсора (`afterId < min(id)` → 409 full reload), upsert только изменённых (C-01, B-21) |
| S-14 | Ни один E10-guard, relay, import и тест безопасности не покрыт | Матрица ролей × эндпоинтов в `smoke_test.php` + тесты guard'ов (G-03) |
| S-15 | `status='trip'` всё ещё принимается сервером; конверсия legacy↔server теряет комментарии | Серверный запрет `trip` в `schedule_entries`, починка конверсии (G-04, B-02) |


## 5. Что проверено и признано корректным

- **SQL:** все пользовательские данные идут через prepared statements; динамические имена колонок — только из whitelist-`$map`; ORDER BY из ввода нет; DDL миграций константные (A §4, C §4).
- **Пароли:** `password_hash`/`password_verify`; хеши не отдаются API; `import.php` таблицу `users` не трогает; mass assignment ролей невозможен.
- **Сессии:** `session_regenerate_id(true)` при логине; HttpOnly + SameSite=Lax; logout уничтожает сессию.
- **Токены:** `random_bytes(32)`; сравнение `hash_equals` во всех трёх местах.
- **Path traversal / LFI:** `year` приводится к int с диапазоном; имя фото генерирует сервер; `photo_url` в ФС не попадает; временные файлы аудита — `tempnam`/`unlink`; `router.php` на прод не выкладывается.
- **Загрузка фото:** MIME через finfo, whitelist, 2 МБ, перекодирование в WebP, EXIF удаляется, PHP в `images/` не исполняется (прод — 500 не даёт, F-04 P3).
- **XSS в `js/trips.js`:** `escapeHtml` применяется последовательно. `document.write`, `eval`, `new Function` нет.
- **XLSX** аудита — `inlineStr` + `xmlEsc`. **CORS `*`** без credentials — чтение с cookie невозможно.
- **Доступ к БД по вебу** закрыт: `/data/*`, `-wal`, `-shm` → 403; `.git` → 403; листинги каталогов закрыты.
- **Совместимость с PHP 8.1** (B §4): конструкций только из 8.2+/8.3 (readonly-классы, типизированные константы, `json_validate`, DNF) не найдено.
- **Адаптивность ≤960px и браузеры** (E §4): существенных проблем нет (Chromium; Firefox/Edge/Яндекс — статически).
- **Индексы** `schedule_entries` по сотруднику/дате, `foreign_keys=ON` на каждом соединении, бэкап `.backup` корректен для WAL (C §4).

## 6. Принятые риски и проектные решения

| Решение | Статус | Текущая оценка последствий |
|---|---|---|
| HTTP без TLS (S-24, A-17) | **риск принят владельцем на период тестирования** (решение 2026-10-26) | Пароли, cookie сессии, Bearer/X-Auth-Token и ПДн идут открытым текстом; MITM может подменить JS. Владелец намеренно работает по HTTP на этапе тестирования; Let's Encrypt на Hostland доступен, переход на HTTPS — позже по команде владельца (бэклог BL-02, чек-лист в `reports/BACKLOG.md`). После перехода — смена паролей и ротация токенов. |
| Глобальная видимость всех сотрудников и записей (E8-4) | **проектное решение** | Дефектом не считается, но каждый viewer получает полный дамп ПДн одной кнопкой (`export.php?download=1`), включая сведения о больничных (спецкатегория «здоровье»), без следа в аудите (S-22). Рекомендация: экспорт только admin + аудит; маскирование причины `sick` для не-admin — решение владельца. |
| Деплой только по команде «Деплой», корневой `.htaccess` с `php_flag` не выкладывается | процедура владельца | Следствие: `display_errors` на проде включён и выключить его средствами кода нечем (S-19). Нужен `ini_set` в `helpers.php` или `.user.ini`. |
| Срок хранения аудита 7 дней | решение по коду, не документировано | Для расследования инцидентов (E10 — массовое стирание) мало; брутфорс-лимит S-17 опирается на аудит. Рекомендуется 90 дней (S-23). |

## 7. Вопросы для юриста по 152-ФЗ — отложено владельцем

Решение владельца 2026-10-26: юридические вопросы отложены. Перечень перенесён в архив `DEFERRED_LEGAL_152FZ.md`; в планы работ не входит.

## 8. Что не удалось проверить

- **Авторизованные действия на проде** (логин, запись, выгрузки, `debug_token` с Bearer) — запрещено. Выводы сделаны по коду и dev; прод-код совпадает побайтно (sha1 `index.html`, `trips.js`).
- **Конфигурация Hostland:** `phpinfo` (`memory_limit`, `post_max_size`, `upload_max_filesize`, `session.gc_maxlifetime`, `date.timezone`, Imagick/GD, версия SQLite), `mod_headers`, `.user.ini`, `REMOTE_ADDR` за nginx, права 755/644 и ACL на `data/`/`images/`, error_log. Нужен доступ владельца.
- **Бэкапы:** настроен ли cron, содержимое и целостность `~/backups`, права. Совпадают ли прод-токены и хеши с dev-БД из git (S-21).
- **Прод-данные:** объём прод-БД и реальная нагрузка (окно гонок S-09/S-28, рост `sync_log`/`audit_log`).
- **Сторона HelpMe:** ретраи, таймауты, реакция на повторную выдачу и на заявку удалённой КМ. **Сторона внешней системы импорта:** контракт id/отмен/формата дат.
- **Браузеры:** реальные Firefox/Edge/Яндекс; исполнение XSS-payload в браузере (сохранение и отдача подтверждены); E2E-харнессы `/tmp/e5_final.js`, `/tmp/e6_final.js` отсутствуют на хосте.
- **Внешние факты:** наличие посторонних сайтов на `*.hostland.pro` (S-04 — проверен только PSL); индексация главной страницы поисковиками (S-01).

## 9. План исправлений

Каждый этап — отдельная фаза Kanban. После фазы — стоп; продолжение по «Старт», выкладка — только по «Деплой».

> **Актуализация 2026-10-26 (решения владельца):** H0 детализирован в `reports/HOTFIX_H0/PLAN.md` (2 воркера, запуск по «Старт»). S-12 и командировочный долг (S-07-остаток, S-10, S-27, S-28, S-44, S-48) перенесены в бэклог BL-01 (`reports/BACKLOG.md`). Git-история очищена 2026-10-26 (`reports/GIT_REWRITE_2026-10-26.md`).

**Фаза H0 — немедленно (хотфикс, одна выкладка):**
1. S-01 — вычистить ПДн из `index.html` (строка 1994, `defaultData`) + pre-deploy grep-проверка. Git-история — ✅ очищена 2026-10-26.
2. S-06 — удалить с прода `api/smoke_test.php`, `debug_token.php`, `init_db.php`, `seed_positions.php`, `schema.sql`, `E8_SYNC.md`, `docs/`; `api/.htaccess` FilesMatch deny; allowlist в `DEPLOY_HOSTLAND.md` §2/§4.
3. S-05 — `auth.php` + `require_admin` в `holidays.php`.
4. ~~S-12 — починить форму командировки~~ → **бэклог BL-01** (сущность пока не применяется в бизнесе).
5. S-19 — `ini_set('display_errors','0')` и `header_remove('X-Powered-By')` в `helpers.php`.
6. S-07 (часть) — `reveal` → `require_admin`; после выкладки — ротация `rpa_relay_token` и `external_api_token` (могли утечь через `debug_token`/reveal).

**Фаза H1 — следующая (P1):**
- S-03 (единая политика авторизации + матрица тестов S-14);
- S-02 (экранирование + whitelist `photo_url` + CSP S-20);
- S-04 (Content-Type/Origin/X-Requested-With);
- ~~S-07 (lease/повторная выдача, уникальный `request_id`, callback-переходы)~~ → BL-01;
- S-11, S-13, S-09 (`BEGIN IMMEDIATE`), S-08, S-15 (S-10 → BL-01).

Порядок внутри H1: S-14 (тесты) параллельно с S-03 — тесты служат приёмкой S-03. Затем S-02/S-04, затем целостность (S-11, S-13, S-09, S-08, S-15).

**Фаза H2 — технический долг P2:**
- безопасность: S-16…S-18, S-21, S-22 (аудит выгрузок), S-23 (retention), S-33, S-37, S-38, S-39;
- корректность: S-25, S-26, S-29…S-31 (S-27, S-28 → BL-01);
- производительность: S-32, S-34, S-35, S-36;
- сопровождаемость: S-40, S-41;
- S-24 (TLS): переход на HTTPS после этапа тестирования — бэклог BL-02, по команде владельца.

**Фаза H3 — P3:** S-42…S-56 (CORS, локальные шрифты, валидация trips, TZ, календарь вне 2026–2028, индексы, N+1, UI-мелочи, §4 процедуры, рефакторинг load/reset/export, мёртвый код, CODEMAP, монолит).

**Зависимости:**
- S-03 → S-02 (сервер перестанет принимать чужие записи, XSS сузится);
- S-07 → ротация токенов после H0;
- S-11 зависит от формата `export.php` (S-53);
- S-01 и S-06 не зависят ни от чего — выполнять первыми.
