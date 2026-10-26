# HF-1 REPORT — ПДн из index.html + check_no_pii.sh + прод-пакет по allowlist

Задача: kanban t_bbb5f5e9 (HOTFIX-H0 HF-1). Исполнитель: sd_worker_03.
Ветка: `hotfix/hf1-pii-deploy` (от `main` f01765e). Внешних эффектов нет: не пушил, прод не трогал.

## 1. Что сделано

1. `index.html` 1 164 537 → 203 826 байт (−960 711 Б, ≈ −0,96 МБ; −712 строки).
   - Строка 1994: пререндер матрицы (~932 КБ в одной строке) → `<tbody id="matrixBody"></tbody>`.
     `<thead id="matrixHead">` (стр. 1993) оставлен: заголовок месяцев/дней, ПДн не содержит.
   - Строки 2105–2422: пререндер поля (карточки сотрудников по зонам) → три пустых контейнера
     `<div class="layout-row" id="row-0|1|2"></div>`. Контейнеры нужны: `buildZones()` берёт их по id и
     сам строит зоны из `ZONES`. Баланс `<div>` в удалённом блоке = 0 (проверено HTMLParser).
   - `DEFAULT_VACATION_DATA` → `{}`, `defaultData` → `[]` (бывш. 2882 / 2958).
   - Других вшитых списков сотрудников, ФИО, фото, телефонов, e-mail в `index.html` не найдено
     (`ZONES` — названия подразделений, не ПДн).
2. `scripts/check_no_pii.sh [paths...|-]` (новый). По умолчанию `index.html js api`; режим `-` читает stdin.
   Печатает только `файл:строка` (значения совпадений не выводятся). Exit 0 — чисто, 1 — найдено, 2 — ошибка запуска.
   Паттерны по спеке: ФИО с отчеством; «Фамилия И. О.»; `Сотрудник [0-9]{2}`. Реальных имён в скрипте нет.
3. `DEPLOY_HOSTLAND.md`:
   - §1 и §2: явный allowlist, guard `check_no_pii.sh` первым шагом (`set -e` — при exit≠0 сборка прерывается),
     список JS берётся из `<script src>` в `index.html`, `api/*.php` без `smoke_test|init_db|seed_positions|debug_token`,
     post-check состава пакета (запрещённое → пакет удаляется, exit 1), требование приложить `tar -tzf … | sort`.
   - §3: примечание про отдельную заливку БД при самой первой выкладке.
   - §4: бэкап БД `sqlite3 … ".backup '<abs>/backups/app-<date>.db'"` перед выкладкой, удаление устаревших файлов
     (`api/smoke_test.php`, `api/debug_token.php`, `api/init_db.php`, `api/seed_positions.php`, `api/E8_SYNC.md`,
     `docs/`, тестовые JS/PHP/sh), chmod 755/644 без трогания `data/app.db`.
   - §5: ссылка на новый §10.
   - §10 (новый): «Проверка после выкладки» — матрица анонимных curl с ожидаемыми кодами + готовый bash-блок.
   - §11 (новый): «Смена токена робота после хотфикса» — только `DELETE FROM meta WHERE key='rpa_relay_token'`;
     `external_api_token` не меняется (решение владельца 2026-10-26).
4. `CODEMAP.md` перегенерирован целиком по AGENTS.md (`rg -j1 --json -n "function |const .*=.*=>" js/storage.js js/trips.js index.html`).
   Номера строк `index.html` сдвинуты; файл был устаревшим (с 2026-09-24), поэтому в `js/trips.js` тоже обновились номера.

## 2. Проверки (команда → результат)

Базовая линия ДО правок (ветка == main f01765e):

| Команда | Результат |
|---|---|
| `php api/smoke_test.php` | 76 passed, 0 failed (exit 0), DB intact |
| `node scripts/test_e51_pick_geometry.js` | 23 passed, 0 failed |
| `node scripts/test_e52_pick_semantics.js` | 41 passed, 0 failed |
| `node scripts/test_r4_hygiene.js` | 19 passed, 0 failed |
| `bash scripts/test_trips_frontend.sh` | 7/7, ALL TESTS PASSED |

ПОСЛЕ правок (те же команды): smoke 76/76; e51 23/23; e52 41/41; hygiene 19/19; trips frontend 7/7. Не хуже базовой линии
(падений на `main` в этих сьютах нет). После каждого прогона: `git checkout -- data/app.db`, удалён `test_cookies.jar`
(артефакт trips-сьюта); `git status` — только файлы Scope.

Guard-скрипт:

| Команда | Результат |
|---|---|
| `bash scripts/check_no_pii.sh index.html js` на main (`git archive main`, абсолютные пути) | exit 1, 124 строки `index.html:N` (плейсхолдеры `Сотрудник NN` в пререндере/defaultData) |
| `bash scripts/check_no_pii.sh index.html js` на ветке | `check_no_pii: OK`, exit 0 |
| `bash scripts/check_no_pii.sh api` | exit 1, `api/vacation_import.php:22` — пример, чистит HF-2 (ожидаемо) |
| stdin: ФИО с отчеством / «Фамилия И. О.» / `Сотрудник 07` | exit 1 (`<stdin>:N`) |
| stdin: `clean` | exit 0 |
| `bash scripts/check_no_pii.sh scripts` (сам скрипт) | exit 0 — имён в скрипте нет |
| `bash -n scripts/check_no_pii.sh` | ок |

Реальных ФИО на `main` после переписывания истории нет, поэтому «ловит» на main именно паттерн-плейсхолдер;
ловля ФИО и инициалов проверена на синтетических строках через stdin.

Синтаксис inline-JS: `python3` извлёк все `<script>` без `src` (1 блок, 2 935 строк) → `node --check` exit 0.
Внешние скрипты: `js/storage.js`, `js/trips.js`.

Локально, `php -S 127.0.0.1:8191 router.php` + headless Chrome (chrome-headless-shell, CDP):

| Сценарий | Ветка HF-1 | main (для сравнения, :8192) |
|---|---|---|
| `curl /` → 200, размер | 200, 203 826 Б; `check_no_pii.sh -` exit 0 | — |
| До логина: строк матрицы / слотов | 0 / 0, экран логина виден, 7 зон | 42 / 45 (ПДн-пререндер) |
| Ошибки в консоли до логина | нет | нет |
| Логин `admin/changeme` → `load.php` 200 | матрица из БД: 5 строк, 4 сотрудника, `__serverStateLoaded=true` | идентично |
| Скриншот после логина | байт-в-байт идентичен скриншоту main | — |
| API недоступен (Fetch.failRequest на `*api/*`) | экран логина, пустая матрица, 0 сотрудников, исключений JS нет (только сетевые ошибки fetch) | — |

В консоли после логина есть `401` на `api/load.php` и `api/trips.php` (анонимные запросы до логина, из `initFromServer`
и `js/trips.js:203`) — то же самое на `main`; не регрессия, находка вне Scope.

Пакет по новому §2 (блок из документа выполнен буквально, пути подставлены на worktree, `OUT` во scratch):

- с guard по умолчанию (`index.html js api`): **сборка прервана** на `api/vacation_import.php:22`, пакет не создан (exit 1) — штатное поведение до HF-2;
- с guard `index.html js` (как на ветке HF-1): exit 0, 35 файлов. `tar -tzf … | sort`:

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
js/trips.js
upload.php
```

В пакете нет: `docs/`, `api/E8_SYNC.md`, `api/smoke_test.php`, `api/init_db.php`, `api/seed_positions.php`, `api/debug_token.php`,
`test_*`, `js/test_trips_overlay.js`, `scripts/`, `reports/`, `staff_project/`, `data/app.db`, корневого `.htaccess`.
Негативный тест post-check: на синтетическом списке (`api/smoke_test.php`, `docs/x`, `data/app.db`, `js/test_*.js`, корневой `.htaccess`, `test_*.php`)
регэксп совпал 6 из 6; на разрешённых (`api/.htaccess`, `api/load.php`, `index.html`) — 0.

## 3. Отклонения от спеки и замечания

1. `check_no_pii.sh` использует `grep -P` (PCRE), а не `-E`: диапазоны `[А-ЯЁ]` в ERE при `C.UTF-8` дают `Invalid collation character`,
   `-E` молча ничего не находил. Регэкспы те же, что в спеке. Нужен GNU grep с `-P` (на машине разработчика есть, 3.11).
2. В allowlist `api/*.php` дополнительно исключён `debug_token.php` (спека оставляла это за HF-2, который удалит файл из репозитория).
   Лишней защитой до слияния HF-2; после — no-op.
3. `data/app.db` не входит в пакет (по спеке). Прежний §1/§2 клал БД в пакет, поэтому для самой первой выкладки добавлено примечание:
   БД заливается отдельным `scp`. Для обновлений ничего не меняется (БД и раньше не перезаписывалась).
4. Новые разделы названы §10 и §11 (в конец) — существующая нумерация §1–§9 не менялась, чтобы не ломать ссылки (AGENTS.md ссылается на §4, §7).
5. Строки матрицы §10 `/api/holidays.php → 401`, `/api/schema.sql → 403`, `/api/session.php` без `X-Powered-By`, `/api/debug_token.php → 404`
   зависят от HF-2; до его выкладки могут не выполняться — указано в документе.
6. Пререндер `#field` (стр. 2105–2422) явно не упомянут в шагах, но подпадает под F-01 («диапазон 2105–2419») — очищен.
7. Встроенный браузер-инструмент не запустился (таймаут), E2E выполнен собственным CDP-драйвером на chrome-headless-shell из `~/.cache/ms-playwright`;
   скрипт драйвера в репозиторий не добавлялся (scratch).
8. `scripts/check_no_pii.sh` проверяет только исходники; PII в БД/`data/app.db` и `staff_project/` вне его области (запрещено Scope).

## 4. Остаточные риски / требуется дальше

- До слияния HF-2 guard по умолчанию (`… api`) будет падать на `api/vacation_import.php:22` — сборка по §2 блокируется намеренно.
- На проде до выкладки лежит старый `index.html` с реальными ФИО: выкладка + проверка §10 — отдельный шаг по команде «Деплой».
- `images/.htaccess` содержит `php_flag engine off`, а в §0 документа сказано, что `php_flag` на Hostland даёт 500 — не проверялось, вне Scope.
- Смена `rpa_relay_token` (§11) выполняется владельцем по SSH.
