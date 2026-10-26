# HF-DOC-FIX_REPORT — закрытие P2 ревью в DEPLOY_HOSTLAND.md

Задача: t_f143dabc. Исполнитель: sd_worker_03. База: `main` (2846d74), рабочее дерево было чистым.
Не коммичено, не пушено; прод не затрагивался (только правка документации).
Изменены ровно два файла: `DEPLOY_HOSTLAND.md` и этот отчёт.

## Что изменено в DEPLOY_HOSTLAND.md

| Находка | Изменение |
|---|---|
| R1-01 (chmod по data/images) | §4 шаг 4: убраны `find … images …`, `chmod 755 data`, `chmod 644 data/.htaccess`. Остались `find api data/holidays js -type d/f -exec chmod 755/644 {} +` и `chmod 644 index.html upload.php`. `chmod -R` нет. Добавлен комментарий, почему `data/`, `images/`, `static/`, `app.db` не трогаем. Добавлены шаг 0 (`getfacl -p $WWW/data $WWW/images \| tee ~/acl-before.txt`, до распаковки) и шаг 5 (`getfacl` после + `diff`). Добавлен чек-лист §4 из 7 пунктов, включая проверку записи (логин и сохранение). |
| R1-02 (images/.htaccess, php_flag) | §4 шаг 2: удалена строка `cp -a /tmp/scnew/images/.htaccess $WWW/images/`, вместо неё комментарий «НЕ копировать (php_flag → 500)». §10: в таблицу и в скрипт `chk` добавлена строка `GET /images/<существующее фото>` → 200. Файл `images/.htaccess` в репозитории не менялся. |
| R2-01 (удаление служебных файлов) | В `main` (после merge HF-1) шаг 3 §4 уже содержал `rm -f api/smoke_test.php api/debug_token.php api/init_db.php api/seed_positions.php api/E8_SYNC.md` и `rm -rf docs`. Ревью R2 смотрело ветку, где этого ещё не было. Эти строки сохранены без изменений. Добавлено недостающее: §4 шаг 6, цикл `curl -I` по 6 путям (5 файлов + `/docs/API_DOCUMENTATION.json`) с ожиданием 403/404. В §10 добавлена строка `/api/E8_SYNC.md` → 403/404, в таблице и в `chk`. |

## Как проверено

- `git status --short`: только `M DEPLOY_HOSTLAND.md` (отчёт — новый файл в `reports/`).
- `git diff --stat`: `DEPLOY_HOSTLAND.md | 42 +++++++++++++++++++++++++++++++++++-------` (35 вставок, 7 удалений). `git diff --check`: чисто.
- Раздел §4 вырезан в отдельный файл: `chmod -R` — 0 вхождений. Строки с `chmod` вне комментариев: только `api`, `data/holidays`, `js`, `index.html`, `upload.php`. Строк `cp … images` нет.
- В §4 присутствуют `rm -f api/smoke_test.php api/debug_token.php api/init_db.php api/seed_positions.php api/E8_SYNC.md` и `rm -rf docs`.
- `bash -n` на bash-блоке §4 → синтаксис OK.
- `bash scripts/check_no_pii.sh` → «check_no_pii: OK», exit 0.
- Прод не трогался; команды на проде (`getfacl`, `curl`) не выполнялись, они только описаны в документе. Работоспособность `getfacl -p` и `diff` на Hostland не проверена.

## Остаточные замечания (вне scope, для координатора)

1. §3 (первая выкладка) всё ещё делает `find $WWW/api $WWW/data $WWW/images $WWW/js … chmod` и `tar -xzf` в `$WWW`. Это тот же класс проблемы, что R1-01: после заливки `app.db` такой chmod заденет `data/`, а распаковка положит `images/.htaccess` с `php_flag`. Критерий приёмки касался только §4, поэтому §3 не менял. Для боевого прода первая выкладка уже неактуальна, но текст лучше выровнять.
2. `images/.htaccess` по-прежнему входит в allowlist пакета (§1 дерево, §2 шаг 4). §4 его теперь не копирует, но лежит он в tar. Решение по замене `php_flag` на `FilesMatch`-deny — за координатором (так сказано в R1-02).
3. Пакет уже не содержит служебных файлов, но проверка `curl` в §4 шаг 6 и в §10 нужна, пока на проде могут лежать старые копии.
4. P3 из R1 (R1-03…R1-06) не затрагивались, как и предписано. В частности, `cd $WWW` в §4 по-прежнему без `|| exit 1` (R1-04).
