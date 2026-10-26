# AUDIT-2026-10 — Блоки E (Frontend, урезанно) + F (Инфраструктура Hostland)

Исполнитель: sd_worker_03. Коммит: `101c846`. Worktree: `/home/hermes/audit-wt/w3`. Dev: http://127.0.0.1:8093 (php -S + router.php, PHP 8.3).
Прод: http://host1882970.hostland.pro — только анонимные GET/HEAD.
Статус: ЗАВЕРШЁН (2026-10-25).

Метод E: headless Chromium через CDP (харнесс `$TMPDIR/ef_harness.js`, чистый профиль браузера на каждого пользователя), сценарии: загрузка → логин → матрица (переключение года) → карточка сотрудника → вкладка «Командировки» → создание КМ → подтверждение → геометрия 1280/960/800/600 → экспорт → логаут; роли admin, supervisor_zone0, viewer (штатного viewer в dev-БД нет — создан временный `viewer_test` на dev, БД затем возвращена `git checkout -- data/app.db`). Собраны console.*, Runtime.exceptionThrown (pageerror), Log.entryAdded, Network.loadingFailed, HTTP ≥400.
Идентичность кода dev и прод: sha1 `js/trips.js` 7a562af0…, `js/storage.js` e61f7639…, `index.html` 8922c3a6… — совпадают у коммита 101c846 и у анонимного GET с прода (2026-10-25).

## 1. Резюме

(`$TMPDIR` в отчёте = `/home/hermes/.hermes/profiles/sd_worker_03/cache/scratch` — харнессы и сырые результаты; очищается через 24 ч простоя.)

Найдено 14 дефектов: P0 — 1, P1 — 2, P2 — 7, P3 — 4.
- P0 (F-01): прод-`index.html` анонимно раздаёт ФИО, должности, локации 45 реальных сотрудников и снапшот их отпусков (статический пререндер + `defaultData` из базового коммита) — немедленно вычистить и перевыложить.
- P1: форма командировки в панели на проде не сохраняет вообще (E-01, регрессия E12-3: TypeError в `saveTrip`, `maskPhoneField` не экспортирован) — RPA-поток со стороны UI мёртв; состав прод-пакета не контролируется (F-02) — на прод уходят smoke_test/debug_token/init_db/docs/тестовый JS.
- P2: display_errors без механизма выключения (F-03), неполный журнал безопасности и 7-дневная ротация (F-05, F-06), бэкап/откат без проверки и с WAL-ловушкой (F-07), единственный рубеж защиты БД в веб-корне (F-09), полный save на каждый render (E-02), незачищаемое клиентское состояние при выходе (E-03).
- Адаптивность ≤960px и совместимость с актуальными Chrome/Edge/Firefox/Яндекс — без существенных проблем (лишь E-05 косметика); `images/.htaccess` на проде 500 не даёт.

## 2. Таблица находок

| ID | P | Категория | Место | Заголовок | Уверенность |
|---|---|---|---|---|---|
| F-01 | P0 | F / A, CWE-200/540 | index.html:1994, 2105-2419, 2958-3319 | ФИО/должности/график 45 сотрудников в статическом index.html, анонимно на проде | подтверждено (код + прод GET) |
| E-01 | P1 | E / B, CWE-457 | js/trips.js:1555-1558, 1655, 1162, 2292 | Форма командировки в панели не сохраняет (удалённые поля, `phoneEl`, нет `maskPhoneField`) | подтверждено (код + dev + sha1 прода) |
| F-02 | P1 | F, CWE-489 | DEPLOY_HOSTLAND.md:25-50, 79; reports/E12_DEPLOY.md:8-9 | Прод-пакет ≠ документ: служебные/тестовые файлы на проде | подтверждено (док + прод GET) |
| E-02 | P2 | E / B, CWE-754 | index.html:4759, 5246-5252, 2721-2727; js/storage.js:522-531 | render() → полный save(): 403-спам у viewer, лишние upsert'ы | подтверждено (код + dev) |
| E-03 | P2 | E / B, CWE-613 | index.html:2661-2666; js/trips.js:48, 429-436 | Выход не сбрасывает DOM/localStorage/роль модуля командировок | подтверждено (код + dev) |
| F-03 | P2 | F, CWE-209 | .htaccess:4-5; api/helpers.php; api/init_db.php:20-21 | display_errors на проде включён, механизма выключения в коде нет | подтверждено (код + прод, 00_MAP) |
| F-05 | P2 | F, CWE-778 | api/auth.php:123-156; api/trip_relay.php:103-110; api/export.php:27; api/vacation_import.php:69-74 | Не логируются 401/403, reveal, выгрузки ПДн, отказы relay/import | подтверждено (код) |
| F-06 | P2 | F / D | api/db.php:274-277, 480-493; api/helpers.php:242-245 | Аудит хранится 7 дней, чистка на каждом запросе | подтверждено (код) |
| F-07 | P2 | F, CWE-312 | DEPLOY_HOSTLAND.md:62, 103-115; reports/E12_DEPLOY.md:38-39; api/export.php:36-114 | Бэкап без проверки/восстановления, откат с WAL-ловушкой, export ≠ бэкап | подтверждено (док/код); cron — требует проверки |
| F-09 | P2 | F, CWE-552 | api/db.php:27, 505-509; data/.htaccess:3; DEPLOY_HOSTLAND.md:80 | БД с ПДн в веб-корне, один рубеж защиты | подтверждено (код + прод HEAD) |
| E-04 | P3 | E | js/trips.js:1053-1056, 429-446, 1233-1245 | Viewer видит «+ Новая командировка» | подтверждено (код + dev) |
| E-05 | P3 | E | index.html:47-55, 2041 | Шапка viewer >960px: поиск съезжает влево | подтверждено (dev) |
| F-04 | P3 | F, CWE-434 | images/.htaccess:2-5 | php_flag vs Hostland; запрет только `\.php$` | подтверждено (код + прод GET); причина — требует проверки |
| F-08 | P3 | F, CWE-276 | DEPLOY_HOSTLAND.md:72-82 | §4: нет бэкапа БД, chmod, mkdir, удаления устаревших файлов | подтверждено (док); права на проде — требует проверки |

## 3. Детальные находки

### E-01 | Форма командировки в панели не сохраняет вообще: saveTrip читает удалённые поля и необъявленную `phoneEl`, `maskPhoneField` не экспортирован
- Приоритет: P1
- Категория: E (frontend, регрессия E12-3) / B; CWE-457 (использование неинициализированной переменной)
- Место: js/trips.js:1555-1558 (чтение `tripLocation`/`tripComment`/`tripStatus`), js/trips.js:1655 (`phoneEl`, regex), js/trips.js:1162 (`oninput="window.Trips.maskPhoneField(this)"`), js/trips.js:2292-2330 (объект `window.Trips` без `maskPhoneField`); форма — `renderTripFormInPanel` js/trips.js:1109-1216.
- Доказательство:
  ```js
  // js/trips.js:1555-1558 — в форме панели (1109-1216) этих id нет: удалены коммитом 0361e6f (E12 Ф1)
  var title = document.getElementById('tripTitle').value.trim();
  var location = document.getElementById('tripLocation').value.trim();   // null.value → TypeError
  var comment = document.getElementById('tripComment').value.trim();
  var status = document.getElementById('tripStatus').value;
  // js/trips.js:1655 — phoneEl нигде не объявлена (grep: единственное вхождение); '[^\\\\d]' в regex-литерале = «не '\' и не 'd'»
  var phoneDigits = phoneEl.value.replace(/[^\\d]/g, '').length;
  // js/trips.js:1162
  oninput="window.Trips.maskPhoneField(this)"   // в window.Trips (2292+) ключа maskPhoneField нет
  ```
  Подтверждено на dev харнессом (admin и supervisor_zone0, «+ Новая командировка» → ввод телефона → «Сохранить»):
  `pageerror TypeError: window.Trips.maskPhoneField is not a function at HTMLInputElement.oninput` и
  `pageerror TypeError: Cannot read properties of null (reading 'value') at Object.saveTrip (js/trips.js:1556:59)`; число КМ до/после = 0/0, POST api/trips.php не отправлен.
  Код на проде идентичен (sha1 trips.js совпадает) → дефект на проде с выкладки E12 (коммит 0361e6f, 2026-09-29).
- Сценарий сбоя (admin или supervisor своей зоны): «Командировки» → «+ Новая командировка» (или «Командировка» из карточки) → заполнить → «Сохранить». Ничего не происходит: ни сообщения, ни запроса; в консоли TypeError. То же при редактировании КМ из панели. Если бы 1556-1558 прошли — на 1655 `ReferenceError: phoneEl is not defined`; после исправления имени regex `[^\\d]` всё равно даёт `phoneDigits≈0` → вечное «Телефон сотрудника: обязательное поле».
- Последствия: создание/редактирование командировок через основной UI на проде невозможно → не формируются `trip_requests` для робота HelpMe (RPA-поток E12 со стороны UI мёртв); пользователи не видят причины. Данные не теряются, но ключевая бизнес-функция недоступна.
- Исправление (не применять):
  ```js
  // js/trips.js saveTrip — поля, которых нет в форме, читать безопасно
  function val(id) { var el = document.getElementById(id); return el ? String(el.value).trim() : ''; }
  var title = val('tripTitle');
  var location = val('tripLocation');
  var comment = val('tripComment');
  var statusEl = document.getElementById('tripStatus');
  var status = statusEl ? statusEl.value : (existing ? existing.status : TRIP_STATUS.DRAFT);
  // :1655
  var phoneEl = document.getElementById('tripPhone');
  var phoneDigits = (phoneEl ? phoneEl.value : '').replace(/\D/g, '').length;
  // :2292  window.Trips = { ..., maskPhoneField: maskPhoneField, ... }
  ```
  Плюс регресс-тест в `scripts/test_trips_frontend.sh`: `renderTripFormInPanel(null)` → заполнить → `saveTrip('null')` должен отправить `POST api/trips.php` (текущий сьют это не ловит).
- Уверенность: подтверждено (по коду + на dev харнессом; идентичность прод-кода — анонимным GET).
- Статус риска: —

### F-01 | index.html на проде анонимно отдаёт ФИО, должности, локации 45 сотрудников и их график отпусков (статический снапшот в разметке и `defaultData`)
- Приоритет: P0
- Категория: F (состав прод-пакета / статический артефакт) / A; CWE-200, CWE-540 (чувствительные данные в исходном коде), 152-ФЗ
- Место: index.html:1994 (`<tbody id="matrixBody">` — пререндеренная матрица отпусков: 42 строки `<td class="name-col" title="<должность>"><ФИО></td>`, 1 003 ячейки `type-vacation`, 56 диапазонов), index.html:2105-2419 (статические карточки зон: `<div class="name"><ФИО></div><div class="role">…`), index.html:2958-3319 (`const defaultData = [ { "name": "<ФИО>", "role": …, "location": …, "dept": … } ×45 ]`), используется index.html:5271.
- Доказательство (ФИО замаскированы):
  ```html
  <!-- index.html:1994 (одна строка ≈ 932 КБ) -->
  <tbody id="matrixBody"><tr><td class="name-col" title="Ведущий инженер"><ФИО></td><td class="day-cell-data" data-emp="1" data-day="1">…
  <!-- index.html:2109-2110 -->
  <div class="name"><ФИО></div>
  <div class="role">Руководитель направления</div>
  ```
  ```js
  // index.html:2958-2962
  const defaultData = [ { "name": "<ФИО>", "role": "Ведущий инженер", "location": "", ... }, ...45 записей ]
  ```
  Все 42 ФИО из матрицы встречаются в `staff_project/` (исходные материалы заказчика) — т.е. это реальные сотрудники, а не синтетика. Внесено базовым коммитом aa16c93 (2026-08-29, «Baseline…») и с тех пор не вычищалось.
  Прод: анонимный `GET /` → 200, `Content-Length: 1168199`, sha1 тела = sha1 index.html@101c846 (8922c3a6…); в теле 46 вхождений `class="name"` и 1 `name-col" title` (строка-снапшот).
- Сценарий (аноним, без учётной записи): `curl http://host1882970.hostland.pro/ | grep -o 'class="name-col"[^<]*'` → полный список ФИО + должности, плюс по `data-emp`/`data-day` и классам `type-vacation range-*` восстанавливается, кто и когда в отпуске (на дату снапшота). Поисковые роботы и кэши индексируют страницу (нет `noindex`, нет `robots.txt` — не проверялось отдельно, см. §5).
- Последствия: публичное раскрытие ПДн (ФИО + должность + подразделение + локация + периоды отсутствия) неограниченному кругу лиц — нарушение конфиденциальности по 152-ФЗ, вне зависимости от авторизации API; плюс 0,93 МБ мёртвого веса в каждой загрузке (страница всё равно перерисовывает матрицу из `load.php`).
- Исправление (не применять):
  1. index.html:1994 — заменить снапшот пустым контейнером: `<tbody id="matrixBody"></tbody>` (thead тоже генерируется `renderVacationMatrix()`; убедиться grep'ом, что ни один код не читает статический tbody до первого рендера).
  2. index.html:2105-2419 — оставить только каркас зон без карточек (`<div class="zone" data-zone="N">…<div class="count"></div>` без `.slot`), карточки рисует `render()`.
  3. index.html:2958 — `const defaultData = [];` и в index.html:5271 не подставлять дефолтных сотрудников (при пустом сервере показывать пустую матрицу).
  4. Добавить в чек-лист выкладки (DEPLOY_HOSTLAND.md §5) проверку: `curl -s $HOST/ | grep -c 'class="name"'` → 0.
  5. После выкладки — сбросить кэши/запросить удаление из поисковых индексов, оценить с юристом необходимость уведомления (вопрос для §7 сводного отчёта).
- Уверенность: подтверждено (по коду + анонимным GET к проду, sha1 совпадает).
- Статус риска: — (не задокументировано как проектное решение; «глобальная видимость» в проекте относится к авторизованным пользователям, не к анониму).

### E-02 | Каждый render() завершается полным `save()` → POST api/save.php: у viewer — 403 и ложное «данные сохранены локально», у редактора — полный upsert при простой навигации
- Приоритет: P2
- Категория: E / B (D — лишняя нагрузка); CWE-1176 (неэффективность), CWE-754
- Место: index.html:4759 (`if (!__suppressRenderSave) save();` в конце `render()`), index.html:5246-5252 (`save()` → `StorageAdapter.save` при `__serverStateLoaded`), index.html:2721-2724 (пересечение брейкпоинта 768px → `render()`), js/storage.js:522-533 (любой !ok, включая 403, логируется как «сервер недоступен, данные сохранены локально»).
- Доказательство:
  ```js
  // index.html:4759
        if (!__suppressRenderSave) save();
  // index.html:2722-2724
  const onChange = function () { if (window.__serverStateLoaded) { try { render(); } catch (e) {} } };
  // js/storage.js:522-531
  if (!resp.ok) { throw new Error('HTTP ' + resp.status); } ... console.warn(LOG_PREFIX, 'save() — сервер недоступен, данные сохранены локально:', err);
  ```
  Dev-харнесс: у viewer_test после логина, при открытии карточки и при смене ширины окна (геометрия 960→800) — `POST /api/save.php` → 403 + `console.warning "[StorageAdapter] save() — сервер недоступен, данные сохранены локально: Error: HTTP 403"` (стек `save@storage.js:516 < save@:5251 < render@:4759 < onChange@:2724`). У admin/supervisor те же действия (логин, открыть карточку, ресайз) — по `POST /api/save.php` с полным состоянием (`employees: N entries: …`) без единой правки.
- Сценарий сбоя: (viewer) открыть приложение, кликнуть карточку, изменить ширину окна через 768px → каждые действия = 403 в консоли и сетевой вкладке, пользователь-наблюдатель «пишет» в localStorage. (supervisor/admin) просто листать/ресайзить → полный upsert всей видимой матрицы; при устаревшей вкладке это ровно тот путь, который E10-6 закрывал freshness-гардом (теперь отбивается 409, но каждый лишний save — шанс конфликта и запись в sync_log, см. C-01 в CD_DB_PERF.md).
- Последствия: шум 403 маскирует реальные ошибки в мониторинге; лишняя запись в БД/`sync_log` на каждую навигацию (ротация 10 000 — C-01); ложное сообщение в консоли о «локальном сохранении».
- Исправление (не применять):
  ```js
  // index.html:4759
        if (!__suppressRenderSave && canEditMatrix() && window.__matrixDirty) { window.__matrixDirty = false; save(); }
  // выставлять window.__matrixDirty = true в точках реальных правок (drag слота, правка карточки, добавление/удаление)
  // js/storage.js:522
  if (resp.status === 401 || resp.status === 403) { return { success: false, forbidden: true, status: resp.status }; }
  ```
- Уверенность: подтверждено (по коду + на dev харнессом).
- Статус риска: —

### F-02 | Состав прод-пакета расходится с DEPLOY_HOSTLAND.md: на проде служебные/тестовые файлы (smoke_test, debug_token, init_db, seed_positions, schema.sql, E8_SYNC.md, docs/, js/test_trips_overlay.js)
- Приоритет: P1
- Категория: F (прод-пакет); CWE-489 (активный отладочный код), CWE-1269
- Место: DEPLOY_HOSTLAND.md:25-42 (§1 «состав»: `api/ … smoke_test.php # можно НЕ заливать (опционально)`, `js/storage.js`), DEPLOY_HOSTLAND.md:50 (§2: `tar -czf … api data images index.html js upload.php` — каталоги целиком), DEPLOY_HOSTLAND.md:79 (§4: `cp -a /tmp/scnew/api … /tmp/scnew/js …` — тоже целиком, без удаления устаревших файлов); фактическая выкладка — reports/E12_DEPLOY.md:8-9 («пакет 49 файлов… Исключены: data/app.db*, scripts/, reports/, staff_project/, DEPLOY*.md, AGENTS.md» — т.е. всё остальное, включая docs/, ушло на прод).
- Доказательство: анонимные GET к проду (2026-10-25): `/js/test_trips_overlay.js` 200 (7 357 Б), `/docs/` 403 (каталог есть) и `/docs/API_DOCUMENTATION.json` 200 (00_MAP §3), `/api/schema.sql`, `/api/E8_SYNC.md` 200, `/api/smoke_test.php`, `/api/init_db.php` — исполняются (00_MAP §3), `/api/debug_token.php` 401 JSON (исполняется). Каталога `docs/` нет ни в §1, ни в tar §2 → прод собирается не по документу, а вручную «всё кроме списка исключений» (E12_DEPLOY.md). Для сравнения не выложены (404): корневые `test_*.php`, `*.md`, `scripts/`, `staff_project/`, `router.php`, `.env`.
- Сценарий сбоя: при каждой выкладке по §2/§4 или по практике E12 в `api/` и `js/` автоматически попадает всё, что лежит в репозитории, включая отладочные эндпоинты (`debug_token.php` — раскрытие фрагмента токена, `smoke_test.php` — анонимный proc_open на хостинге; их эксплуатация — блок A) и документацию протоколов; §4 `cp -a` не удаляет файлы, убранные из репозитория, — они остаются на проде навсегда.
- Последствия: расширенная поверхность атаки на проде; раскрытие схемы БД и протоколов синхронизации/API; невоспроизводимость состава прода (документ ≠ факт).
- Исправление (не применять): заменить §2/§4 на allowlist-сборку и пост-проверку:
  ```bash
  # scripts/build_hostland_package.sh
  set -euo pipefail
  FILES="index.html upload.php js/storage.js js/trips.js \
    api/.htaccess api/auth.php api/db.php api/helpers.php api/schema.sql \
    api/login.php api/logout.php api/session.php api/change_password.php api/load.php api/reset.php \
    api/save.php api/sync.php api/entries.php api/employees.php api/groups.php api/positions.php \
    api/holidays.php api/holidays_provider.php api/trips.php api/trip_relay.php api/vacation_import.php \
    api/import.php api/export.php api/audit_export.php api/upload.php \
    data/.htaccess data/holidays images/.htaccess"
  tar -czf sc-hostland-deploy.tar.gz $FILES
  ```
  `api/schema.sql` нужен рантайму (api/db.php:30 `SCHEMA_PATH`), поэтому выкладывается, но закрывается в `api/.htaccess`: `<FilesMatch "\.(?i:sql|md|json)$">` + `Require all denied` + `</FilesMatch>`.
  На проде однократно: `cd $WWW && rm -f api/smoke_test.php api/debug_token.php api/init_db.php api/seed_positions.php api/E8_SYNC.md js/test_trips_overlay.js && rm -rf docs`.
  В §5 (проверка) добавить: `for p in api/smoke_test.php api/debug_token.php api/init_db.php api/seed_positions.php api/E8_SYNC.md api/schema.sql docs/API_DOCUMENTATION.json js/test_trips_overlay.js; do curl -s -o /dev/null -w "$p %{http_code}\n" $BASE/$p; done` → все 404/403.
- Уверенность: подтверждено (по документу и отчёту E12_DEPLOY + анонимным GET к проду).
- Статус риска: —

### F-03 | display_errors на проде включён, а в коде нет ни одного механизма его выключения (только `php_flag` в корневом .htaccess, который на Hostland запрещён)
- Приоритет: P2
- Категория: F (dev/prod-конфигурация); CWE-209 (сообщения об ошибках с чувствительной информацией)
- Место: .htaccess:4-5 (`php_flag display_errors off` — по DEPLOY_HOSTLAND.md:15,42,146 на Hostland даёт 500 и не выкладывается), api/helpers.php (нет `ini_set`/`set_exception_handler`; grep по api/*.php: `ini_set|display_errors|set_error_handler|set_exception_handler` — 0 совпадений), api/init_db.php:20-21 (`if (PHP_SAPI !== 'cli') { fwrite(STDERR, …)` — в веб-SAPI константы STDERR нет → Fatal).
- Доказательство: 00_MAP §3 — анонимный GET `/api/init_db.php` и `/api/smoke_test.php` на проде → 200 с текстом `PHP Fatal error … in /home/host1882970/…/api/…php:NN` (полный путь). DEPLOY_HOSTLAND.md:147 «display_errors обычно уже выключен у Hostland» — фактом опровергнуто.
- Сценарий сбоя: любая необработанная ошибка/исключение в любом эндпоинте (SQLITE_BUSY, нехватка места, TypeError на неожиданном JSON) отдаёт пользователю/анониму HTML-текст ошибки с абсолютным путём, строкой и сообщением (в т.ч. SQL-фрагментами PDOException), ломая JSON-контракт фронта.
- Последствия: раскрытие структуры хостинга (логин `host1882970`, пути) и внутренних деталей; фронт получает невалидный JSON.
- Исправление (не применять; без php_flag):
  ```php
  // api/helpers.php — в самом начале файла (его подключают все эндпоинты, кроме init_db/seed/smoke)
  if (PHP_SAPI !== 'cli') {
      ini_set('display_errors', '0');
      ini_set('display_startup_errors', '0');
      ini_set('log_errors', '1');
      error_reporting(E_ALL);
      set_exception_handler(function (Throwable $e) {
          error_log('[uncaught] ' . get_class($e) . ': ' . $e->getMessage() . ' @' . $e->getFile() . ':' . $e->getLine());
          if (!headers_sent()) { http_response_code(500); header('Content-Type: application/json; charset=utf-8'); }
          echo '{"error":"server_error"}';
      });
  }
  // api/init_db.php:20-23 — корректный CLI-guard
  if (PHP_SAPI !== 'cli') { http_response_code(404); exit; }
  ```
  Дополнительно — `.user.ini` в корне www (`display_errors=Off`, `log_errors=On`) действует только при CGI/FPM SAPI; по DEPLOY_HOSTLAND.md:11 SAPI = apache2handler, поэтому полагаться только на `.user.ini` нельзя — основной механизм `ini_set` выше. Плюс выключение в панели Hostland (PHP-настройки сайта).
- Уверенность: подтверждено (по коду + анонимным GET к проду, данные 00_MAP §3).
- Статус риска: —

### F-04 | images/.htaccess: `php_flag engine off` противоречит DEPLOY_HOSTLAND (php_flag → 500), запрет PHP только по `\.php$` (.phtml/.php5/.phar/.pht не закрыты)
- Приоритет: P3
- Категория: F (.htaccess); CWE-434 (защита в глубину), CWE-16
- Место: images/.htaccess:2-5; DEPLOY_HOSTLAND.md:15,146 («php_flag … НЕ РАБОТАЕТ — даёт HTTP 500»).
- Доказательство:
  ```apache
  <FilesMatch "\.php$">
    Require all denied
  </FilesMatch>
  php_flag engine off
  ```
  Прод (анонимно, 2026-10-25): `GET/HEAD /images/photo_1786695247_dc0276f5.webp` → 200 image/webp; `/images/nonexistent.webp` → 404 (не 500); `/images/x.php` → 403 (Apache, FilesMatch работает); `/images/x.phtml|x.php5|x.phar|x.pht|x.php7|x.PHP|x.php.webp` → 404 (правила запрета на них нет). Т.е. на проде в images/ действует FilesMatch, а 500 от php_flag нет → либо прод-версия images/.htaccess отличается от репозитория (дрейф конфигурации), либо утверждение DEPLOY_HOSTLAND о 500 неверно для подкаталога. Различить без SSH нельзя.
- Сценарий сбоя: исполнения через приложение нет — `api/upload.php:69` сам генерирует имя `photo_<time>_<hex>.webp`, расширение от клиента не берётся. Риск — только если файл с расширением `.phtml`/`.phar` попадёт в images/ иным путём (ручная заливка, будущий код) и у Apache на этих расширениях висит PHP-handler; и риск, что при выкладке «как в репозитории» php_flag уронит раздачу всех фото в 500.
- Последствия: потенциальная деградация (все фото 500) или неполная защита в глубину.
- Исправление (не применять): images/.htaccess без php_flag:
  ```apache
  <FilesMatch "\.(?i:php\d?|phtml|pht|phar|phps|cgi|pl|py|sh)$">
    Require all denied
  </FilesMatch>
  <FilesMatch "\.(?i:webp)$">
    ForceType image/webp
  </FilesMatch>
  ```
  (ForceType — только для webp: api/upload.php:69 пишет исключительно `.webp`.) Проверить на проде после выкладки: `/images/x.phtml` → 403, фото → 200.
- Уверенность: подтверждено (по коду + анонимным GET к проду); причина отсутствия 500 — требует проверки (SSH: `cat $WWW/images/.htaccess`).
- Статус риска: —

### F-05 | Журнал безопасности неполон: не пишутся 401/403, reveal токена робота, выгрузки ПДн (export.php, audit_export.php), отказы relay/vacation_import; IP только у login_failed
- Приоритет: P2
- Категория: F (логирование/мониторинг); CWE-778 (недостаточное логирование), CWE-223
- Место: api/auth.php:123-156 (`require_auth/require_edit/require_admin` → `sendJson(… 401|403)` без `audit()`), api/trip_relay.php:103-110 (`?action=reveal` отдаёт токен без аудита), api/export.php:27 (полный дамп сотрудников/записей, доступен viewer — без аудита), api/audit_export.php:35 (без аудита), api/vacation_import.php:69-74 (неверный Bearer → 401 без записи; исключения — только `error_log` без IP), api/trip_relay.php (poll/callback с неверным X-Auth-Token — без записи; grep `audit\|error_log` по файлу — 0 совпадений), api/login.php:45 (IP пишется только для неудачного входа; успешный `auth.login`:54 — без IP).
- Доказательство: полный перечень вызовов `audit(` в api/*.php (grep) — события: auth.login/login_failed/logout/password_change, employee.*, entry.*, group.*, position.*, holiday.*, trip.create/update/delete/confirm/legacy_migrate, import.run, vacation_import.run, photo.upload, *_blocked (гарды save.php). Отсутствуют: `*.forbidden`, `relay.reveal`, `relay.auth_failed`, `export.download`, `audit.export`, `vacation_import.auth_failed`.
  ```php
  // api/trip_relay.php:103-110
  if ($action === 'reveal') { require_auth(); require_edit();
      sendJson(['success' => true, 'token' => relay_ensure_token($pdo)]); }
  ```
- Сценарий: (1) supervisor (require_edit пропускает) получает токен робота через reveal и далее читает/подменяет callbacks — в audit_log следов нет; (2) viewer скачивает `export.php?download=1` (ФИО, телефоны, график всех сотрудников) — следов нет; (3) перебор токена `vacation_import`/relay — следов нет, обнаружить атаку невозможно. Кроме того, за nginx-прокси `REMOTE_ADDR` может быть адресом прокси (Hostland nginx→Apache) — пригодность IP требует проверки (§5).
- Последствия: невозможность расследовать утечку ПДн и злоупотребление токенами; нет сигнала для мониторинга.
- Исправление (не применять):
  ```php
  // api/auth.php — в require_edit()/require_admin() перед sendJson(403):
  if (function_exists('audit')) { try { audit(Database::getInstance()->getPDO(), 'auth.forbidden', null, null, 'endpoint', basename($_SERVER['SCRIPT_NAME'] ?? ''), ['method' => $_SERVER['REQUEST_METHOD'] ?? '', 'ip' => client_ip()]); } catch (Throwable $e) {} }
  // api/helpers.php
  function client_ip(): string { $xf = $_SERVER['HTTP_X_REAL_IP'] ?? ($_SERVER['HTTP_X_FORWARDED_FOR'] ?? ''); $ip = trim(explode(',', $xf)[0] ?? ''); return filter_var($ip, FILTER_VALIDATE_IP) ? $ip : ($_SERVER['REMOTE_ADDR'] ?? ''); }
  // api/trip_relay.php reveal: audit($pdo, 'relay.reveal', null, null, 'system', null, ['ip' => client_ip()]);  — токен НЕ писать
  // api/trip_relay.php при неверном/пустом X-Auth-Token: audit($pdo, 'relay.auth_failed', 'robot', null, 'system', null, ['ip' => client_ip()]);
  // api/export.php после require_auth(): audit($pdo, 'export.download', null, null, 'system', null, ['ip' => client_ip()]);
  // api/audit_export.php: audit($pdo, 'audit.export', null, null, 'system', null, ['format' => $format, 'days' => $days]);
  // api/vacation_import.php:69 перед 401: audit($pdo, 'vacation_import.auth_failed', 'external', null, 'system', null, ['ip' => client_ip()]);
  ```
  (X-Forwarded-For доверять только если прокси свой — на Hostland nginx перед Apache хостинга; проверить заголовок на проде авторизованно.)
- Уверенность: подтверждено (по коду).
- Статус риска: —

### F-06 | Срок хранения аудита 7 дней и очистка на каждом HTTP-запросе — журнал недостаточен для расследований
- Приоритет: P2
- Категория: F (логирование) / D; CWE-779 (ошибочное удаление журналов) — по смыслу
- Место: api/db.php:274-277 (`$this->cleanupAuditLog();` в конце `migrate()`, который вызывается каждым эндпоинтом), api/db.php:480-493 (`DELETE FROM audit_log WHERE ts < now-7d`), api/helpers.php:242-245 (+ очистка с вероятностью 5% на каждую мутацию), api/helpers.php:266-277.
- Доказательство:
  ```php
  // api/db.php:274-277
  // E5-4: периодическая очистка журнала аудита …
  $this->cleanupAuditLog();
  // api/db.php:482
  $cutoffDate = gmdate('Y-m-d\TH:i:s+00:00', time() - 7*86400);
  ```
  Ни экспорта аудита во внешнее хранилище, ни архивации перед удалением нет; бэкап БД (§6 DEPLOY_HOSTLAND, если cron настроен) — единственная копия старых записей.
- Сценарий: инцидент масштаба E10 (стирание данных устаревшей вкладкой; reports/E10_PHOTOS_RECOVERY.md восстанавливал root cause именно по audit_log + sync_log) обнаружен владельцем через 8+ дней (отпуск, праздники) → записи о том, кто и когда удалил/изменил данные, уже стёрты первым же GET любого пользователя. То же для неудачных входов/перебора.
- Последствия: невозможность расследования и доказательства действий пользователей с ПДн; срок 7 дней короче типичного цикла обнаружения.
- Исправление (не применять): хранить 180 дней (объём audit_log мал), чистить не чаще раза в сутки:
  ```php
  // api/db.php cleanupAuditLog()
  $last = $this->pdo->query("SELECT value FROM meta WHERE key='audit_cleanup_at'")->fetchColumn();
  if ($last && (time() - (int)$last) < 86400) return;
  $cutoff = gmdate('Y-m-d\TH:i:s+00:00', time() - 180*86400);
  $st = $this->pdo->prepare('DELETE FROM audit_log WHERE ts < :c'); $st->execute([':c' => $cutoff]);
  $this->pdo->prepare("INSERT INTO meta(key,value) VALUES('audit_cleanup_at', :t) ON CONFLICT(key) DO UPDATE SET value=excluded.value")->execute([':t' => (string)time()]);
  // api/helpers.php:242-245 — удалить вероятностный вызов audit_cleanup()
  ```
  Срок согласовать с владельцем/юристом (вопрос для §7 сводного отчёта).
- Уверенность: подтверждено (по коду).
- Статус риска: — (7 дней — решение этапа E5-4, но в DEPLOY/AGENTS не зафиксировано как принятый риск).

### F-07 | Бэкапы: процедура §6 не проверяема и без восстановления; откат БД копированием `.db` поверх живой при наличии `-wal`; ПДн в 30+ открытых копиях; export/import — не бэкап
- Приоритет: P2
- Категория: F (бэкап/восстановление); CWE-1059 (недостаточная документация), CWE-312 (ПДн в открытом виде)
- Место: DEPLOY_HOSTLAND.md:103-115 (§6 cron `sqlite3 … ".backup '/home/host1882970/backups/app-$(date +\%F).db'"`, хранение 30 копий, «Альтернатива: снапшот всего хостинга»), DEPLOY_HOSTLAND.md:62 (§3 `tar -czf ~/backups/old-site-….tar.gz -C $WWW .` — включает data/app.db и без ротации), reports/E12_DEPLOY.md:38-39 (откат: `cp ~/backups/app-pre-e12-….db …/data/app.db` «(осторожно, WAL)»), api/export.php:36-114 (выгружает только groups/positions/employees/schedule_entries/holidays/vacation_balances/meta.current_year — без trips, trip_participants, trip_requests, users, meta-токенов, audit_log), api/import.php:53-58 (удаляет и перезаливает только эти же таблицы; разрушение участников КМ — см. C-03 в CD_DB_PERF.md).
- Доказательство: в §6 нет ни шага проверки (`PRAGMA integrity_check`), ни процедуры восстановления, ни признака, что cron реально создан (в отчётах E5–E12 упоминаются только ручные pre-deploy снапшоты `~/backups/pre-*.tar.gz` и `app-pre-*.db`). Процедура отката из E12_DEPLOY.md копирует файл БД, не останавливая запись и не удаляя `data/app.db-wal`/`-shm` (БД работает в WAL — 00_MAP §1).
- Сценарий сбоя: (1) порча/стирание прод-БД → владелец обнаруживает, что cron в панели не создан или копии битые (не проверялись) → восстановление только из последнего ручного pre-deploy снапшота (недели назад); (2) откат по E12_DEPLOY: `cp app-pre.db app.db` при живом `app.db-wal` от новой БД → SQLite при следующем открытии применит чужие WAL-кадры к восстановленному файлу → «database disk image is malformed» или тихая порча; (3) admin считает «Экспорт» резервной копией → восстановление через import.php теряет все командировки и учётки/токены не затрагивает.
- Последствия: риск невосстановимой потери данных; ПДн всех сотрудников лежат в ~/backups в 30+ незашифрованных копиях + в каждом `old-site-*.tar.gz` бессрочно (на shared-хостинге доступ — любой с SSH-паролем, который по E12_DEPLOY не ротировался).
- Исправление (не применять) — §6 переписать:
  ```bash
  # cron (панель Hostland), ежедневно 03:00:
  D=/home/host1882970/backups; DB=/home/host1882970/host1882970.hostland.pro/htdocs/www/data/app.db
  F=$D/app-$(date +\%F).db; sqlite3 "$DB" ".backup '$F'" && sqlite3 "$F" "PRAGMA integrity_check;" | grep -qx ok \
    && gzip -f "$F" && chmod 600 "$F.gz" || echo "BACKUP FAILED $(date)" >> $D/backup.err
  find $D -name 'app-*.db.gz' -mtime +30 -delete; find $D -name 'old-site-*.tar.gz' -mtime +90 -delete
  # Восстановление (новый §6.1):
  # 1) положить index.html-заглушку/maintenance или переименовать api/ → запись остановлена
  # 2) gunzip -c app-YYYY-MM-DD.db.gz > /tmp/r.db && sqlite3 /tmp/r.db "PRAGMA integrity_check;"   # ok
  # 3) rm -f $WWW/data/app.db-wal $WWW/data/app.db-shm && cp /tmp/r.db $WWW/data/app.db && chmod 644 …
  # 4) вернуть api/, проверить §5; ежеквартально — пробное восстановление на локальном dev.
  ```
  В DEPLOY_HOSTLAND и в UI явно указать: «Экспорт» (export.php) — не резервная копия (нет командировок/учёток). Шифрование копий (`gpg --symmetric`) — по решению владельца.
- Уверенность: подтверждено (по документу/коду); факт наличия cron и содержимое ~/backups на проде — требует проверки (SSH запрещён).
- Статус риска: —

### E-03 | Выход из учётки не сбрасывает клиентское состояние: данные предыдущего пользователя остаются в DOM/localStorage, модуль командировок сохраняет его роль для следующего входа
- Приоритет: P2
- Категория: E / B; CWE-613 (недостаточное завершение сессии), CWE-524
- Место: index.html:2661-2666 (`doLogout()` → `fetch('api/logout.php')` + `showLogin()`; ни перезагрузки, ни очистки), index.html:5247 (`localStorage.setItem(STORAGE_KEY, …)` в каждом `save()`), js/storage.js:435-443 (кэш `staff_layout_v2`/`vacation_data_v3`), js/trips.js:48, 429-436 (`_currentUser` кэшируется навсегда; присвоения только в 434/436/442/1120/1282, сброса нет).
- Доказательство: dev-проба CDP (`$TMPDIR/ef_logout_probe.js`, один таб, без перезагрузки):
  ```
  0.anon до входа (чистый профиль): localStorage.staff_layout_v2=4959 Б, в DOM 45 карточек с ФИО, 49 строк матрицы  (defaultData, см. F-01)
  1.вход supervisor_zone0:          DOM 4 карточки, матрица 5 строк, Trips.getCurrentUser()=null (ещё не резолвлен)
  2.после «Выйти»:                  оверлей входа показан, НО DOM 4 карточки + матрица 5 строк, localStorage 442+74 Б, Trips user = supervisor_zone0/canEdit=true
  3.вход admin в том же табе:       AppState.user=admin, а Trips.getCurrentUser() = supervisor_zone0 (роль/зона прежнего пользователя)
  ```
- Сценарий сбоя: (общий ПК) supervisor выходит → следующий человек без входа видит/читает через DevTools матрицу и карточки предыдущего пользователя в DOM и `localStorage` (данные остаются и после закрытия вкладки); (смена учётки в одном табе) admin входит после supervisor → в командировках действуют проверки `canDeleteTrip/canConfirmTrip` для supervisor чужой зоны (кнопки скрыты), и наоборот supervisor после admin видит admin-кнопки (сервер отклонит, но UI вводит в заблуждение).
- Последствия: остаточные ПДн на клиенте после выхода; неверный ролевой UI до ручной перезагрузки.
- Исправление (не применять):
  ```js
  // index.html:2661
  async function doLogout() {
    try { await fetch('api/logout.php', { method: 'POST' }); } catch (e) {}
    try { localStorage.removeItem('staff_layout_v2'); localStorage.removeItem('vacation_data_v3'); } catch (e) {}
    location.replace(location.pathname);   // полный сброс JS-состояния (Trips._currentUser, employees, vacationData, DOM)
  }
  ```
  Плюс в `showApp(user)` передавать пользователя в модуль: `window.Trips && window.Trips.setCurrentUser && window.Trips.setCurrentUser(user)` (новый экспорт `setCurrentUser: function(u){ _currentUser = u; }`).
- Уверенность: подтверждено (по коду + на dev CDP-пробой).
- Статус риска: —

### E-04 | Viewer видит кнопку «+ Новая командировка» (скрытие зависит от асинхронно резолвленного пользователя)
- Приоритет: P3
- Категория: E (ролевой UI)
- Место: js/trips.js:1053-1056 (`if (_dom.newTripBtn && user && !user.canEdit) …display='none'` — при `user===null` кнопка остаётся), js/trips.js:429-446 (`getCurrentUser()` при первом вызове возвращает null и резолвит сессию асинхронно), js/trips.js:1233-1245 (`closeTripForm` пересоздаёт кнопку видимой).
- Доказательство: dev-харнесс, viewer_test: `tripsList: {"items":0, "newBtnVisible": true}`; клик открывает форму с disabled-полями и disabled «Сохранить».
- Сценарий: viewer → «Командировки» → видит «+ Новая командировка» → форма, которую нельзя сохранить.
- Последствия: путаница пользователя; безопасность не затронута (сервер требует require_edit).
- Исправление (не применять): скрывать кнопку класом `editor-only` (index.html:2010 и js/trips.js:978, 1235: `class="btn editor-only"`) — его уже обрабатывает `applyRoleGating` (index.html:2551-2555), и вызвать `applyRoleGating(AppState.user)` после пересоздания в `closeTripForm`.
- Уверенность: подтверждено (по коду + на dev).
- Статус риска: —

### E-05 | Шапка у viewer при ширине >960px: поиск съезжает влево (скрытый `#addBtn` выпадает из grid-потока)
- Приоритет: P3
- Категория: E (адаптивность/вёрстка)
- Место: index.html:47-55 (`.header-controls { grid-template-columns: 1fr auto 1fr }`, позиционирование только через `justify-self`, без `grid-column`), index.html:2041 (`#addBtn.editor-only` → `display:none` у viewer, index.html:2551-2555).
- Доказательство: геометрия dev 1280px: admin/supervisor — поиск x=423..843 (центр ≈633 при vw 1265, по центру); viewer — поиск x=66..486, профиль x=568..697 (элементы сдвинулись на колонку влево). При ≤960px (grid-template-areas, index.html:63-73) дефекта нет.
- Сценарий: войти viewer на экране ≥961px → поиск у левого края, бейдж роли в центре.
- Последствия: косметика.
- Исправление (не применять):
  ```css
  .header-controls #addBtn { grid-column: 1; }
  .header-controls #searchEmployee { grid-column: 2; }
  .header-controls #userIndicatorBtn { grid-column: 3; }
  ```
  (внутри @media ≤960px grid-area уже переопределяет.)
- Уверенность: подтверждено (на dev, замер getBoundingClientRect).
- Статус риска: —

### F-08 | Процедура обновления §4: нет бэкапа БД перед выкладкой, нет chmod (файлы уходят 664), нет mkdir, устаревшие файлы не удаляются
- Приоритет: P3
- Категория: F (прод-пакет, права); CWE-276 (неверные права по умолчанию)
- Место: DEPLOY_HOSTLAND.md:72-82 (§4), ср. §3 DEPLOY_HOSTLAND.md:62-66 (там бэкап и chmod 755/644 есть).
- Доказательство:
  ```bash
  # DEPLOY_HOSTLAND.md:77-81
  tar -xzf ~/sc-hostland-deploy.tar.gz -C /tmp/scnew        # каталог /tmp/scnew не создаётся → tar: Cannot open
  cp -a /tmp/scnew/api /tmp/scnew/index.html /tmp/scnew/js /tmp/scnew/upload.php $WWW/   # cp -a сохраняет права из tar
  ```
  Рабочие файлы у разработчика — 664/775 (umask 0002: `stat` index.html, api/login.php → 664; api/, data/, images/ → 775), tar §2 их сохраняет → после §4 на проде group-writable файлы. Бэкап `app.db` перед обновлением §4 не делает (AGENTS.md требует «бэкап → выкладка»; фактически делали вручную — E12_DEPLOY.md:11-13).
- Сценарий: выкладка строго по §4 → права 664/775 на shared-хостинге; при ошибке миграции схемы на первом запросе нет pre-update снапшота БД.
- Последствия: ослабление прав (риск зависит от групп Hostland — требует проверки); невозможность отката БД.
- Исправление (не применять): §4 заменить на
  ```bash
  WWW=~/host1882970.hostland.pro/htdocs/www; TS=$(date +%Y%m%d-%H%M); mkdir -p ~/backups ~/scnew
  sqlite3 $WWW/data/app.db ".backup '$HOME/backups/app-pre-$TS.db'" && sqlite3 ~/backups/app-pre-$TS.db 'PRAGMA integrity_check;'
  tar -czf ~/backups/pre-$TS.tar.gz -C $WWW --exclude='data/app.db*' .
  tar -xzf ~/sc-hostland-deploy.tar.gz -C ~/scnew --no-same-permissions
  rsync -a --delete --exclude='data/app.db*' --exclude='images/photo_*' --exclude='static/' ~/scnew/ $WWW/   # или cp + явный rm устаревших
  find $WWW/api $WWW/js $WWW/data $WWW/images -type d -exec chmod 755 {} + ; find $WWW/api $WWW/js $WWW/data/holidays -type f -exec chmod 644 {} + ; chmod 644 $WWW/index.html $WWW/upload.php
  rm -rf ~/scnew ~/sc-hostland-deploy.tar.gz
  ```
  (`--delete` только с allowlist-пакетом из F-02; ACL веб-юзера на `data/`, `images/` после chmod проверить `getfacl`.)
- Уверенность: подтверждено (по документу); фактические права/ACL на проде — требует проверки (SSH запрещён).
- Статус риска: —

### F-09 | Единственный рубеж защиты БД с ПДн — `data/.htaccess` в веб-корне; корневой .htaccess на прод не кладётся из-за php_flag, второго уровня нет
- Приоритет: P2
- Категория: F (.htaccess, размещение данных); CWE-552 (файлы доступны внешним сторонам), CWE-1188
- Место: api/db.php:27 (`DB_PATH = PROJECT_ROOT/data/app.db` — внутри www), api/db.php:505-509 (поддержка `getenv('SC_APP_DB')` уже есть, не используется), data/.htaccess:3 (`Require all denied`), .htaccess:4-5 (php_flag → корневой файл не выкладывается, DEPLOY_HOSTLAND.md:42), DEPLOY_HOSTLAND.md:80 (`cp -a /tmp/scnew/data/.htaccess … 2>/dev/null` — ошибка копирования подавляется).
- Доказательство: прод `HEAD /data/app.db` → `403`, `Content-Type: text/html; charset=iso-8859-1` — это ответ Apache (тот же формат, что Apache-404), т.е. nginx-фронт сам файл не защищает; защита держится только на `data/.htaccess`. `-wal`/`-shm` закрыты тем же правилом (00_MAP §3).
- Сценарий сбоя: выкладка/восстановление, при которой `data/.htaccess` не попал на сервер (dotfile теряется при `cp data/*`, `2>/dev/null` в §4 скрывает ошибку, загрузка через файловый менеджер панели, откат `tar` из старого бэкапа без него) → `GET /data/app.db` отдаёт всю БД анонимно: ФИО, телефоны, графики, хеши паролей, `external_api_token`, `rpa_relay_token`.
- Последствия: при единичной ошибке выкладки — полная утечка ПДн и токенов (P0-последствие при низкой вероятности).
- Исправление (не применять):
  1. Вынести БД из веб-корня, используя уже существующий `SC_APP_DB`: в КОРНЕВОМ `.htaccess` (после удаления php_flag, см. п.2; mod_env) добавить `SetEnv SC_APP_DB /home/host1882970/sc-data/app.db` — именно в корне, т.к. корневой `upload.php` (вне api/) тоже открывает БД через `api/upload.php:175` (audit), и SetEnv только в `api/.htaccess` привёл бы к созданию новой пустой `data/app.db` при загрузке фото; перенести файл: `mkdir -p ~/sc-data && sqlite3 $WWW/data/app.db ".backup '$HOME/sc-data/app.db'"` (+ ACL веб-юзера `host1882970_1` на `~/sc-data`), проверить `/api/load.php` под admin и загрузку фото, затем удалить старый `data/app.db*`.
  2. Корневой `.htaccess` разделить: убрать строки 1-5 (php_flag) и выкладывать остальное + второй рубеж:
     ```apache
     <FilesMatch "\.(?i:db|db-wal|db-shm|sqlite|sql|md|sh|bak|log)$">
       Require all denied
     </FilesMatch>
     ```
  3. В §5 проверок: `curl -s -o /dev/null -w '%{http_code}' $BASE/data/app.db` (уже есть) + `$BASE/data/app.db-wal`.
- Уверенность: подтверждено (по коду/документу + анонимным HEAD к проду); работа SetEnv на Hostland — требует проверки на тестовом каталоге.
- Статус риска: —

## 4. Проверено, проблем не найдено

E1. Консоль/ошибки в штатных сценариях (dev, Chromium headless, роли admin / supervisor_zone0 / viewer_test):
- Логин, матрица (переключение года 2026↔2027), карточка сотрудника, вкладка «Командировки», модалка экспорта, логаут: pageerror нет, кроме E-01. Прочие записи консоли — штатные `console.log` модулей ([StorageAdapter], [Trips], [Holidays]) и ожидаемые до входа `401 GET api/load.php` / `401 GET api/trips.php` + `console.error "[Trips] Error loading trips: unauthorized"` (js/trips.js:203-206) — шум до логина, на функциональность не влияет (замечание P3-уровня, отдельной находкой не оформлено; можно не дёргать trips.php до `showApp`). Failed requests: только `audit_export.php?format=csv net::ERR_ABORTED (canceled)` — отменён логаутом харнесса, не дефект.
- Роль viewer: 403 только от render→save (E-02); прочие запросы 200.

E2. Целевые браузеры (статически, index.html + js/trips.js + js/storage.js, скрипт `$TMPDIR/ef_compat.sh`): не используются structuredClone, `:has()`, CSS nesting, `@container`, `@layer`, `Array.prototype.at/findLast/toSorted`, `Object.hasOwn/groupBy`, `replaceAll`, логические присваивания, top-level await/ES-модули, `<dialog>`, popover, `dvh`, subgrid, `text-wrap`, `crypto.randomUUID`, `AbortSignal.timeout`. Используются: `??` (index.html:4630, 4735, 4809), `?.` (index.html:5784), object spread (index.html:5271), async/await — все поддерживаются Chrome/Edge ≥80, Firefox ≥74, Яндекс Браузер (Chromium) текущих версий; `matchMedia(...).addEventListener` с фоллбэком `addListener` (index.html:2726-2727); `backdrop-filter` с `-webkit-` (index.html:506-507, 1237, 1345; Firefox ≥103); `scrollbar-width` (index.html:222, 247) + `::-webkit-scrollbar` — деградация только косметическая; `color-mix()` (js/trips.js:887 — фон кнопки-ярлыка пик-режима; Chrome/Edge ≥111, Firefox ≥113; в более старых — правило отбрасывается, кнопка без фона, функция сохраняется); `writing-mode: vertical-rl` (js/trips.js:876, index.html) — повсеместно. Вывод: для «актуальных» Chrome/Edge/Firefox/Яндекс реального риска нет; минимально совместимые версии — Chromium 111 / Firefox 113 (из-за color-mix, косметика).

E3. Адаптивность (геометрия getBoundingClientRect при vw 1280/960/800/600, все роли): шапка — пересечений элементов нет (`hdrOverlaps: []`), выход за вьюпорт нет (`offscreen: []`), горизонтального скролла страницы нет (`scrollWidth == clientWidth` на всех ширинах); при ≤960px перенос в две строки (кнопка/профиль, затем поиск) срабатывает (index.html:63-73), поиск сжимается `min(420px,100%)`; заголовок не переполняется. Панель отпусков/командировок: шапка панели (вкладки, год, ×) без пересечений, матрица скроллится внутри (`overflow-x:auto`, scrollWidth 8234 при clientWidth 562-843), колонка ФИО видна, легенда в пределах панели; форма командировки — без горизонтального скролла и выхода за панель на 600-1280. Меню профиля в пределах вьюпорта. Единственный дефект — E-05 (viewer, ≥961px).

F1. Прод-пакет — помимо F-02/F-08: на проде НЕ доступны (404) корневые `test_*.php`, `router.php`, `CODEMAP.md`, `AGENTS.md`, `DEPLOY*.md`, `QA_REPORT.md`, `scripts/`, `staff_project/`, `reports/`, `.env`, `.gitignore`, `index.html.bak/~`; листинг каталогов закрыт (403 `/images/ /api/ /js/ /docs/ /data/`). `test_*.sh`, `.user.ini`, `php.ini`, `.htaccess` → 403 с телом nginx (146 Б, без charset) — это правило nginx на расширения/dot-файлы, а не признак наличия файлов (сравнить: Apache-ответы 239 Б iso-8859-1). Библиотечные `api/db.php|helpers.php|auth.php` при прямом GET → 200 пустое тело (ничего не исполняют на верхнем уровне, кроме `session_start` в auth.php) — приемлемо.

F2. .htaccess:
- `data/.htaccess` — `Require all denied` работает (прод: `/data/app.db`, `/data/holidays/2026.json`, `/data/` → 403 Apache). Риск единственного рубежа — F-09.
- `images/.htaccess` — 500 на проде НЕТ: `GET/HEAD` существующего `photo_*.webp` → 200 image/webp, несуществующего → 404; `.php` → 403. Дефекты — F-04.
- `api/.htaccess` (`SetEnvIf Authorization "(.*)" HTTP_AUTHORIZATION=$1`) — нужен только `api/vacation_import.php:45` (читает исключительно `$_SERVER['HTTP_AUTHORIZATION']`). При отсутствии файла и срезании заголовка Apache — fail-closed: внешняя система получает 401 `invalid_token` (данные не раскрываются, функция импорта отпусков ломается). `trip_relay.php:74` использует `X-Auth-Token` (`HTTP_X_AUTH_TOKEN`) — от api/.htaccess не зависит. Рекомендация (не дефект): фоллбэк `$_SERVER['REDIRECT_HTTP_AUTHORIZATION'] ?? (function_exists('getallheaders') ? (getallheaders()['Authorization'] ?? '') : '')`.
- Корневой `.htaccess` — по DEPLOY_HOSTLAND.md:42 на прод не кладётся (последствия — F-03, F-09).

F3. Dev/prod: код один (sha1 index.html/js совпадают). PHP-совместимость 8.3 (dev) / 8.1.34 (прод, `X-Powered-By`): `php -l` всех api/*.php на 8.3 — без ошибок; grep конструкций 8.2+ (`readonly class`, `true`/`false`/`null` как самостоятельный тип возврата, DNF-типы `(A&B)|C`) — 0 совпадений; прогон на 8.1 локально не выполнялся (интерпретатора 8.1 нет) — подробнее блок G/B. `router.php` — только dev (на проде 404); отличие: на dev `php -S` отдаёт файлы, которые на проде закрыты .htaccess/nginx (`data/`, dot-файлы, `*.sh`) — dev НЕ воспроизводит прод-защиту, поэтому проверки F2 выполнены на проде анонимно. Файлов «есть на проде, нет в dev» не найдено: `images/photo_*.webp` с прода — данные, не код; `static/` — каталог хостинга (AGENTS.md: защищён), в репозитории отсутствует.

F4. Логирование: пароли и токены в `audit_log`/`error_log` не пишутся — проверены все 37 вызовов `audit($pdo…)` и 12 `error_log(` в api/*.php: `login.php:45` пишет введённый логин и IP (не пароль), `change_password.php:72` — только username, `trip_relay.php` токен в ответах/логах не пишет (только `reveal`), `vacation_import.php:73,410` — текст исключения и `employee=<id>`, даты (ID, не ФИО). ПДн в audit_log: `employee.create/update/delete` (`employees.php:126,230,272`, `save.php:293,322,392`) кладут в `details` изменённые поля (ФИО/должность/телефон) — для журнала изменений это ожидаемо; доступ к выгрузке — только admin (`audit_export.php:35`). Дефекты — F-05, F-06.

F5. Бэкапы: §6 размещает копии вне веб-корня (`/home/host1882970/backups`, не под `htdocs/www`) — анонимно недоступны. Связь с export/import и остальное — F-07, F-08.

## 5. Что не удалось проверить

- Реальные Firefox / Edge / Яндекс Браузер не запускались (в окружении только Chromium headless-shell); E2 — статический анализ. 
- Штатный viewer в dev-БД отсутствует — использован временный `viewer_test` (создан на dev, БД возвращена).
- Подтверждение командировки (confirm) в UI: не проверено — создание КМ через UI невозможно (E-01), `tripConfirm.found=false`. Скачивание файла экспорта в headless не перехвачено (`exportFiles: []`, модалка открылась без ошибок).
- Всё, что требует SSH/панели Hostland (запрещено): фактические права 755/644 и ACL `host1882970_1` на `data/`, `images/`; содержимое прод-версии `images/.htaccess` (F-04); наличие cron-бэкапа и содержимое `~/backups` (F-07); настройка display_errors в панели; расположение и содержимое PHP error_log; что приходит в `REMOTE_ADDR` за nginx (F-05).
- Авторизованные сценарии на проде (вход, выгрузки) — запрещены; прод-проверки ограничены анонимными GET/HEAD (перечень — `$TMPDIR/ef_prod_probe.sh` / `.out`: ~65 запросов GET/HEAD за сессию, без Authorization/cookie, без POST; запрещённые `smoke_test/init_db/seed_positions/debug_token` не запрашивались — коды взяты из 00_MAP §3).
- Индексация главной страницы поисковиками (F-01): `/robots.txt` → 404, мета `noindex` в index.html отсутствует; факт индексации не проверялся.

## 6. Передано в A

- index.html:1994, 2105-2419, 2958-3319 — ФИО/должности/график 45 сотрудников в статике, отдаются анониму (детально — F-01, P0; для сводной CVSS-оценки).
- index.html:2661-2666, js/storage.js:486-490, index.html:5247 — остаточные ПДн в DOM/localStorage после выхода, рендер кэша анониму до логина (детально — E-03).
- api/trip_relay.php:103-108 — `?action=reveal` выдаёт токен робота любому supervisor (require_edit), без аудита (аудит — F-05).
- api/export.php:27 — полный дамп ПДн доступен viewer, без аудита (аудит — F-05).

## 7. Самопроверка

- E-01: защиты уровнем выше нет — ошибка на клиенте до отправки запроса; не проектное решение (форма E12-3 задумана сохраняемой, reports/E12_3_V2_FIX.md). Прод-код идентичен (sha1).
- E-02: сервер отбивает viewer (require_edit, 403) и устаревшие сохранения (freshness E10-6) — поэтому P2, а не выше; сам паттерн «save в конце render» — исторический (комментарий index.html:4613-4615), но как проектное решение не задокументирован.
- E-03: серверная сессия уничтожается (logout.php), но клиентское состояние — нет; документации о намеренном сохранении localStorage после выхода нет.
- E-04, E-05: косметика/UX, сервер защищает (require_edit).
- F-01: никакой guard/.htaccess не закрывает `/` (это и есть приложение); «глобальная видимость» в проекте — для авторизованных; анонимная выдача ФИО не задокументирована.
- F-02: nginx/.htaccess не закрывают `api/*.php`, `*.sql`, `*.md` в api/ и `docs/*.json` (прод 200); allowlist-сборки нет.
- F-03: в коде нет ini_set/handler; корневой .htaccess по документу не выкладывается; прод отдаёт Fatal (00_MAP).
- F-04: смягчено генерацией имени в upload.php:69 — поэтому P3.
- F-05/F-06: require_* не логирует; ротация 7 дней — код E5-4, принятием риска не оформлена.
- F-07/F-08: процедуры — документ; фактическое исполнение на проде не проверялось (отмечено «требует проверки»).
- F-09: nginx не защищает `data/` (ответ 403 сформирован Apache) — второго рубежа нет; `SC_APP_DB` в коде есть, но не применяется.
- Номера строк сверены с worktree на коммите 101c846 (`git status --porcelain` пуст).

## Не завершено

- Нет (все пункты блоков E и F покрыты; ограничения — §5).
