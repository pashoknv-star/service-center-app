# HF-R1 — ревью HF-1 (ветка `hotfix/hf1-pii-deploy`, коммит 7686637)

Ревьюер: sd_worker_02. Исполнитель: sd_worker_03. Задача kanban: t_0551a205.
Worktree: `/home/hermes/hf-wt/hf1` (только чтение; код не правился, не коммитился, не пушился). Дата: 2026-10-26.

## Вердикт: **ACCEPT**

P0/P1 нет. Критерии приёмки спеки HF-1 (1–8) выполнены и перепроверены независимо.
Есть 2 находки P2 и 4 P3, все в `DEPLOY_HOSTLAND.md` и guard-скрипте. Они не блокируют слияние.
Находки P2 (R1-01, R1-02) нужно закрыть до команды «Деплой». Остальное можно вынести в бэклог.

## Находки

| ID | Приоритет | `файл:строка` | Суть | Как воспроизвести |
|---|---|---|---|---|
| R1-01 | P2 | `DEPLOY_HOSTLAND.md:141-143` | §4 теперь делает рекурсивный `chmod 644/755` по `images` и `chmod 755 data`. Старый §4 chmod не делал. В `images/` лежат фото, загруженные веб-юзером `host1882970_1`, то есть чужие для SSH-юзера файлы. `chmod` на них даст `Operation not permitted`, как и на `static/` (это описано в §3). `chmod 755 data` на каталоге с ACL веб-юзера может пересчитать ACL-маску и убрать у веб-юзера запись в `data/`, а значит и в `app.db`. Спека требовала «chmod 755/644», но не проверяла эффект на ACL. | Прочитать §4 шаг 4; на проде сравнить `getfacl data images` до и после. **Предложение:** chmod только для кодовых каталогов (`api`, `js`, `data/holidays`) и файлов `index.html` и `upload.php`, а `data` и `images` не трогать. После выкладки проверить запись: логин и сохранение. Либо добавить `getfacl data` до и после в чек-лист. |
| R1-02 | P2 | `DEPLOY_HOSTLAND.md:130` (+ `images/.htaccess:5`) | §4 теперь копирует `images/.htaccess` на прод через `cp -a`. Раньше при обновлении его не копировали. Файл содержит `php_flag engine off`, а §0 (стр. 15) и §9 (стр. 214) говорят, что `php_flag` на Hostland даёт HTTP 500. Если директива срабатывает, все `/images/*` (фото) отдадут 500. В матрицу §10 строки для `/images/` не добавлены. Это ровно аудиторская находка S-51/F-04, и HF-1 её не закрывает, а лишь выкатывает файл при обновлении. | `grep -n php_flag images/.htaccess`. На проде после выкладки: `curl -I $BASE/images/<существующее фото>`. **Предложение:** (a) добавить в §10 строку «`/images/<фото>` → 200»; (b) до «Деплоя» решить, оставлять ли `php_flag` в `images/.htaccess`. Замена на `<FilesMatch "\.php$"> Require all denied</FilesMatch>` без `php_flag` — вопрос к HF-2 или координатору. Либо не копировать файл при обновлении, как раньше. |
| R1-03 | P3 | `scripts/check_no_pii.sh:21-23` | Покрытие guard'а узкое. `PAT_FIO` требует окончание отчества `вич/вна/ична`. Не ловит «Ильич», «Кузьмич», «…оглы/кызы», ФИО из двух слов («Фамилия Имя») и ФИО в верхнем регистре. «Фамилия И.О.» ловится только при заглавных буквах. Реальные имена в `index.html` уже заменены плейсхолдерами, поэтому сейчас опасности нет. Но guard — единственный автоматический барьер перед сборкой пакета. | `printf 'Иванов Иван\n' \| bash scripts/check_no_pii.sh -` → exit 0 (пропущено). `printf 'ИВАНОВ ИВАН ИВАНОВИЧ\n' \| …` → exit 0. **Предложение:** в бэклог, например `(вич\|вна\|ична\|ьич\|оглы\|кызы)` и режим без учёта регистра. Для двух слов нужен словарь фамилий, так что это скорее процедура ревью, чем regexp. |
| R1-04 | P3 | `DEPLOY_HOSTLAND.md:127-134` | §4: `/tmp/scnew` не очищается перед распаковкой. Остатки прошлой выкладки (например, удалённые в новой версии файлы) смешаются с новым пакетом и попадут на прод через `cp -a`. Путь `/tmp/scnew` предсказуем, и на общем хостинге это ещё и symlink-риск. `cd $WWW` (стр. 134) без `\|\| exit`: при ошибке `rm -rf docs` и `rm -f api/...` выполнятся в `$HOME`, то есть в текущем каталоге. | Прочитать §4. **Предложение:** `S=$(mktemp -d)` вместо `/tmp/scnew`; `cd "$WWW" \|\| exit 1`. |
| R1-05 | P3 | `DEPLOY_HOSTLAND.md:62-90` | §2 собирает пакет из рабочего дерева, а не из коммита (`git archive`). Неотслеживаемые файлы в `api/*.php` или `data/holidays/*.json` попадут в пакет. Блок начинается с `set -euo pipefail`: вставленный в интерактивный shell он закроет сессию при первой ошибке. `$JS` без кавычек и без поддержки `?v=` в `src`. Сейчас `src` без query, поэтому не проявляется. | `touch api/zz_local.php; <блок §2>; tar -tzf … \| grep zz_local` → попадёт в пакет. **Предложение:** предупреждение «собирать из чистого `git status`» в тексте и вынос блока в `scripts/build_package.sh`. |
| R1-06 | P3 | `DEPLOY_HOSTLAND.md:160-` (§10), `router.php` | Строки §10 `holidays.php→401`, `schema.sql→403`, `smoke_test`, `init_db`, `seed_positions`, `debug_token→404`, `X-Powered-By` локально проверить нельзя. `php -S … router.php` не читает `.htaccess` и отдаёт эти URL как 200. Это dev-поведение, а не регрессия HF-1. Выполнение матрицы возможно только на прод-Apache, а HF-1 ещё и зависит от HF-2 (это указано в документе). | `curl -s -o /dev/null -w '%{http_code}' 127.0.0.1:8273/api/smoke_test.php` → 200; `…/api/schema.sql` → 200; `…/data/app.db` → 200; `…/api/session.php` → есть `X-Powered-By`. **Предложение:** оставить как есть. В отчёт «Деплоя» записать, что матрица валидна только на проде после HF-2. |

Находок вне Scope, лишних файлов и скрытых правок кода нет (см. «Scope» ниже).

## Проверка Scope

- `git merge-base main HEAD` = `f01765e` = `main`. Основа корректна, один коммит.
- `git diff --name-status main...HEAD`: `M CODEMAP.md`, `M DEPLOY_HOSTLAND.md`, `M index.html`, `A reports/HOTFIX_H0/HF-1_REPORT.md`, `A scripts/check_no_pii.sh`. Всё из Scope.
- Нет правок `api/*`, `js/*`, `data/app.db`, `staff_project/`, `static/`, корневого `.htaccess`.
- `git status` в worktree после моих прогонов: чисто (`data/app.db` восстановлен, `test_cookies.jar` — артефакт trips-сьюта — удалён).

## Проверка index.html (спека, шаги 2–4)

- `git diff -U0 main...HEAD -- index.html` содержит ровно 4 hunks:
  - 1994: пререндер матрицы → `<tbody id="matrixBody"></tbody>`;
  - 2105-2422: пререндер поля → `row-0`, `row-1`, `row-2` (пустые контейнеры);
  - 2882: `DEFAULT_VACATION_DATA = {}`;
  - 2958: `defaultData = []`.
- Добавлено 5 строк, остальное — удаления данных. Код функций не тронут.
- `<section class="field" id="field">` сохранён. `buildZones()` (`index.html:3690`) берёт `row-0/1/2` по id, поэтому контейнеры нужны, и они на месте.
- Потребители: `loadDefault()` (4557) → `employees = []`; `initFromServer` перезаписывает данные ответом сервера при `employees.length > 0`. Пустой ответ даёт пустую матрицу без исключений.
- Поиск оставшихся вшитых данных в `index.html` и `js/*.js`: e-mail нет; телефонов нет (только `type="tel"` в форме); `images/*.jpg`/`data:image` нет; пар «Имя Фамилия» в кавычках нет; «Инст.»/«Ставка (Декрет …)»/локации сотрудников нет. «Урай» остаётся только в заголовке организации. Единственная длинная строка — `<thead id="matrixHead">` (11 615 символов, названия месяцев и числа). `check_no_pii.sh index.html js CODEMAP.md` → exit 0.

## Проверка allowlist в DEPLOY_HOSTLAND.md

- `api/schema.sql` включён (стр. 80), `api/.htaccess` включён.
- Исключены: `docs/`, `api/E8_SYNC.md`, `smoke_test.php`, `init_db.php`, `seed_positions.php`, `debug_token.php`, `test_*`, `js/test_*`, `scripts/`, `reports/`, `staff_project/`, `data/app.db`, корневой `.htaccess`.
- Блок §2 выполнен буквально (подстановка путей на worktree и scratch):
  - с guard по умолчанию (`index.html js api`): сборка прервана на `api/vacation_import.php:22`, exit 1, пакет не создан. Штатно до HF-2;
  - с guard `index.html js`: exit 0, 35 файлов, `tar -tzf | sort` совпадает с отчётом исполнителя. Запрещённых файлов нет, `api/schema.sql` и `api/.htaccess` на месте.
- Post-check в §2 (`^(…|\.htaccess$)`) бьёт только по корневому `.htaccess` (`$` внутри группы), `api/`, `data/` и `images/.htaccess` не ловит.
- §11: `meta.key='rpa_relay_token'` совпадает с `api/trip_relay.php:54,60,79`. Таблица `meta(key,value)` есть. Токен создаётся лениво, как описано. `external_api_token` не трогается (решение владельца).

## Выполненные проверки (команда → результат)

Все команды выполнены в `/home/hermes/hf-wt/hf1`.

| Команда | Результат |
|---|---|
| `php api/smoke_test.php` | 76 passed, 0 failed, `DB intact: YES` |
| `php -l` для `api/*.php`, `upload.php`, `router.php` | без ошибок |
| `node --check js/storage.js`, `js/trips.js` | ok |
| Inline-`<script>` из `index.html` (1 блок) → файл → `node --check` | ok |
| `node scripts/test_e51_pick_geometry.js` | 23/23 |
| `node scripts/test_e52_pick_semantics.js` | 41/41 |
| `node scripts/test_r4_hygiene.js` | 19/19 |
| `bash scripts/test_trips_frontend.sh` | ALL TESTS PASSED |
| `bash scripts/check_no_pii.sh` (по умолчанию) | exit 1, одна строка `api/vacation_import.php:22` (ожидаемо, HF-2) |
| `bash scripts/check_no_pii.sh index.html js` на ветке | exit 0 |
| то же на `main` (`git archive main`, скрипт скопирован) | exit 1, 124 строки |
| stdin-режим `-`: ФИО с отчеством; «Фамилия И. О.»; «Фамилия И.О.»; `Сотрудник 07`; 3 строки подряд | exit 1, `<stdin>:N` для каждой |
| stdin `ok text` | exit 0 |
| `check_no_pii.sh index.html js nonexist` | exit 2, `path not found` |
| `bash -n scripts/check_no_pii.sh`, режим файла 100755 | ok |
| `php -S 127.0.0.1:8273 router.php` + `curl /` | 200, 203 826 Б, `check_no_pii.sh -` → exit 0 |
| `curl /api/load.php` без cookie | 401 |
| `POST api/login.php {"username":"admin","password":"changeme"}` → `GET api/load.php` | 200, 4 сотрудника в `employees` |
| Headless Chrome (CDP), до логина | матрица 0 строк, 0 слотов, 7 зон, оверлей логина виден, ошибок JS нет |
| Headless Chrome, логин `admin` через форму | оверлей скрыт; `#matrixBody` — 5 строк (группа + 4 сотрудника из БД); `#field` — 4 слота; `__serverStateLoaded=true`; ошибок JS нет |
| Сборка пакета по блоку §2 (см. выше) | guard по умолчанию блокирует, 35 файлов без запрещённых |
| `git checkout -- data/app.db` после всех прогонов | `git status` чисто |

Сервер `php -S` на порту 8273 остановлен (отдельный процесс, не затронул чужие worktree).

## Что не проверено

- Реальный прод (Hostland, Apache): матрица §10 и ACL (R1-01, R1-02) — по запрету на внешние эффекты не проверялись.
- Режим «API недоступен» (Fetch.failRequest) не воспроизводил отдельно. Вывод сделан из чтения кода (`initFromServer` + пустые дефолты) и результатов исполнителя.
- Логаут/повторный вход и сохранение данных в БД не проверялись: вне Scope HF-1.
- Находку исполнителя про `401` на `api/load.php` и `api/trips.php` до логина считаю предсуществующей (поведение `main` то же). Вне Scope.
