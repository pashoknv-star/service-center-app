# HF-1 — Убрать ПДн из index.html + guard-скрипт + прод-пакет по allowlist

Исполнитель: sd_worker_03. Роль: frontend + deploy-документация.
Workspace: `dir:/home/hermes/hf-wt/hf1` — git worktree, ветка `hotfix/hf1-pii-deploy`, основа — `main`.
Ревью: HF-R1 (sd_worker_02). Интеграция: координатор (HF-INT).
Внешние эффекты: никаких. Не пушить, не трогать прод, не логиниться на прод.

## Контекст

- Аудит AUDIT-2026-10, находка S-01/A-01/F-01 (P0): статический `index.html` содержит вшитые данные ~45 сотрудников — пререндер матрицы, `defaultData`, `DEFAULT_VACATION_DATA`. На проде этот файл отдаётся анонимно.
- 2026-10-26 история git переписана: реальные ФИО в репозитории заменены плейсхолдерами `Сотрудник NN`. Но **на проде лежит старый index.html с реальными ФИО**. Его заменит выкладка результата этой задачи.
- Приложение строит матрицу из `GET api/load.php` после логина (`renderMatrix()`, index.html ~3596/3650). Захардкоженные данные для работы не нужны.
- Отчёты: `reports/AUDIT_2026-10/A_SECURITY.md` (A-01), `EF_FRONT_INFRA.md` (F-01, F-02), `CD_DB_PERF.md` (D-02).

## Scope

Разрешено менять: `index.html`, `scripts/check_no_pii.sh` (новый), `DEPLOY_HOSTLAND.md`, `CODEMAP.md`, отчёт `reports/HOTFIX_H0/HF-1_REPORT.md`.

Запрещено:
- `api/*` (это HF-2);
- `js/trips.js` и форма командировки (отложено в бэклог BL-01 решением владельца);
- `data/app.db` (после тестов вернуть: `git checkout -- data/app.db`);
- `staff_project/`, `static/`, корневой `.htaccess`;
- любые другие находки аудита.

## Шаги

1. Зафиксировать базовую линию до правок: `php api/smoke_test.php` и JS-сьюты из AGENTS.md (e51, e52, hygiene, trips frontend). Записать результаты — часть сьютов может падать уже на `main` (G-07).
2. `index.html:1994` — заменить пререндер (~933 КБ в одной строке) на `<tbody id="matrixBody"></tbody>`.
3. `index.html:2882` `DEFAULT_VACATION_DATA` → `{}`; `index.html:2958` `defaultData` → `[]`. Проверить диапазон 2105-2419 (по F-01): если там данные сотрудников или отпусков — тоже очистить. Других вшитых списков сотрудников, должностей с ФИО и графиков остаться не должно.
4. Проверить потребителей: `loadDefault()` (~5269), инициализацию, fallback при недоступном API (B-01). С пустыми дефолтами страница не падает. До логина и при ошибке API показывается пустая матрица или экран логина, без фиктивных сотрудников. После логина матрица строится из БД как раньше.
5. Новый `scripts/check_no_pii.sh [paths...]`:
   - по умолчанию проверяет `index.html js api`;
   - завершается с exit 1 и выводит `файл:строка`, если найдены:
     - ФИО с отчеством: `[А-ЯЁ][а-яё]+ [А-ЯЁ][а-яё]+ [А-ЯЁ][а-яё]+(вич|вна|ична)`;
     - «Фамилия И. О.»: `[А-ЯЁ][а-яё]+ [А-ЯЁ]\. ?[А-ЯЁ]\.`;
     - плейсхолдер `Сотрудник [0-9]{2}`;
   - сам скрипт реальных имён не содержит.
   - Пример в `api/vacation_import.php:22` заменяет HF-2. Поэтому на ветке HF-1 запускать `bash scripts/check_no_pii.sh index.html js`.
6. `DEPLOY_HOSTLAND.md`:
   - §2 (сборка пакета): заменить `tar … api data images …` на **явный allowlist**:
     - `index.html`, `upload.php`;
     - JS-файлы, реально подключённые в `index.html` через `<script src>`;
     - `api/*.php`, **кроме** `smoke_test.php`, `init_db.php`, `seed_positions.php`; `debug_token.php` HF-2 удаляет из репозитория;
     - `api/.htaccess` и `api/schema.sql` (нужен `db.php` для миграций; от веба закрывается в HF-2);
     - `data/.htaccess`, `data/holidays/*.json`, `images/.htaccess`;
     - **не** включать: `docs/`, `api/E8_SYNC.md`, `test_*`, `scripts/`, `reports/`, `staff_project/`, `data/app.db`;
     - первым шагом сборки — `bash scripts/check_no_pii.sh`; при exit≠0 сборку прервать.
   - §4 (обновление):
     - перед выкладкой — бэкап БД `sqlite3 data/app.db ".backup '<abs>/backups/app-<date>.db'"`;
     - удалить с прода устаревшие файлы: `api/smoke_test.php`, `api/debug_token.php`, `api/init_db.php`, `api/seed_positions.php`, `api/E8_SYNC.md`, `docs/`, а также тестовые JS, если есть (F-02);
     - `chmod` 755/644.
   - Новый раздел «Проверка после выкладки» — анонимные curl с ожидаемыми кодами:

     | URL | Ожидание |
     |---|---|
     | `/` | 200, и `curl -s … \| bash scripts/check_no_pii.sh -` (или grep тех же регэкспов) находит 0 совпадений |
     | `/api/holidays.php` | 401 |
     | `/api/smoke_test.php` | 403 или 404 |
     | `/api/init_db.php` | 403 или 404 |
     | `/api/seed_positions.php` | 403 или 404 |
     | `/api/debug_token.php` | 404 |
     | `/api/schema.sql` | 403 |
     | `/docs/API_DOCUMENTATION.json` | 404 |
     | `/api/session.php` | 200, без заголовка `X-Powered-By` |
     | `/data/app.db` | 403 |

     Если `check_no_pii.sh` не умеет читать stdin — добавить режим `-`.
   - Новый раздел «Ротация токенов после хотфикса» (выполняет владелец по SSH; значения в чат и файлы не выводить):
     ```
     sqlite3 data/app.db "DELETE FROM meta WHERE key='rpa_relay_token';"
     sqlite3 data/app.db "UPDATE meta SET value=lower(hex(randomblob(32))) WHERE key='external_api_token';"
     ```
     Токен робота пересоздаётся лениво при `?action=reveal` (теперь только admin). Новый токен импорта владелец передаёт внешней системе.
7. `CODEMAP.md` — обновить номера строк `index.html`: после удаления строк они сдвинутся.

## Критерии приёмки

1. `bash scripts/check_no_pii.sh index.html js` → exit 0. До правок на `main` тот же вызов → exit 1 (доказательство, что скрипт ловит).
2. `index.html` уменьшился примерно на 0,9 МБ. Нет `defaultData` и `DEFAULT_VACATION_DATA` с записями.
3. Все inline-`<script>` из `index.html` проходят `node --check`: извлечь блоки в файлы и проверить.
4. Smoke 100% pass. JS-сьюты — не хуже базовой линии из шага 1. dev-БД возвращена.
5. Локально `php -S 127.0.0.1:<port> router.php`:
   - `curl /` без cookie не содержит имён (`check_no_pii.sh -`);
   - логин `admin`/`changeme` (dev) → `load.php` 200, матрица строится из БД — подтвердить через headless Chromium или скриншот консоли, без ошибок в консоли.
6. `DEPLOY_HOSTLAND.md` содержит allowlist, список удаляемых файлов, матрицу проверок и ротацию. Пакет, собранный по новому §2, не содержит запрещённых файлов: приложить `tar -tzf … | sort`.
7. Один коммит на ветке `hotfix/hf1-pii-deploy`. `git diff --stat main` — только файлы из Scope.
8. Отчёт `reports/HOTFIX_H0/HF-1_REPORT.md` закоммичен в ветку: что сделано, вывод проверок (команда → результат), отклонения от спеки.

## Возврат

`kanban complete` с кратким итогом и путём к отчёту. При блокере — `kanban block` с причиной, не угадывать.
