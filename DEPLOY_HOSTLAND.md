# Деплой Service Center App — Hostland (шаред-хостинг)

> Отдельная инструкция для реального окружения прод-сервера. Основной `DEPLOY.md`
> (Apache + mod_php) остаётся нетронутым и к этому серверу **не применяется**.

**Факты окружения (зафиксированы разведкой 2026-08-15):**

| Параметр | Значение |
|---|---|
| Хостинг | Hostland, шаред, AlmaLinux 8.10 |
| Веб | Apache (SAPI `apache2handler`, PHP 8.1.34) **за nginx-прокси** (`Server: nginx`) |
| CLI PHP | 5.3.29 — `init_db.php`/`smoke_test.php` из CLI запускать **нельзя** |
| Расширения web-PHP | pdo_sqlite, gd, mbstring, fileinfo, imagick, curl, session, json — всё есть |
| `.htaccess` | Apache-синтаксис поддерживается: `Require all denied` работает (403) |
| `php_flag` в `.htaccess` | **НЕ РАБОТАЕТ — даёт HTTP 500.** Корневой `.htaccess` с `php_flag` на этот сервер НЕ класть |
| SSH | `host1882970@serv18.hostland.ru:1024`, sudo нет |
| Каталог сайта | `~/host1882970.hostland.pro/htdocs/www` (техдомен) |
| Запись веб-сервера | через ACL (`host1882970_1` = веб-юзер); `data/`, `images/` доступны на запись |
| БД | SQLite `data/app.db`, инициализируется локально на PHP 8.3 и заливается готовой (CLI на хостинге — 5.3) |
| sqlite3 CLI | есть (3.26) — для бэкапов |
| Стартовые пароли | admin/supervisor_zone0/supervisor_zone1 = `changeme` — сменить после деплоя (раздел 7) |

---

## 1. Что кладём на хостинг (состав Hostland-пакета)

Пакет собирается по **явному allowlist** (раздел 2). Каталоги целиком (`tar … api data images …`) не архивируем.

```
www/
├── index.html          # фронтенд (vanilla JS, монолит) — БЕЗ вшитых данных сотрудников
├── upload.php          # корневой делегат загрузки фото -> api/upload.php
├── api/
│   ├── *.php           # backend (PHP 8.1-совместимый), КРОМЕ smoke_test.php, init_db.php,
│   │                   #   seed_positions.php, debug_token.php и ВСЕХ тестов `*_test.php`
│   │                   #   (tasks_test.php, tasks_n8n_test.php и будущие — исключаются по шаблону)
│   ├── .htaccess
│   └── schema.sql      # нужен db.php для миграций (от веба закрывается в HF-2)
├── js/                 # ТОЛЬКО файлы, подключённые в index.html через <script src>
│                       #   (на 2026-11-10: js/storage.js, js/trips.js, js/tasks.js, js/tasks_matrix.js).
│                       #   Список АВТОМАТИЧЕСКИЙ: шаг 2 раздела 2 берёт его из index.html,
│                       #   поэтому новый подключённый скрипт попадёт в пакет сам, а текст выше
│                       #   — лишь снимок на дату. js/test_*.js не кладём
├── data/
│   ├── .htaccess       # Require all denied — ЗАЩИТА БД (работает, проверено)
│   └── holidays/*.json
└── images/
    └── .htaccess       # запрет исполнения PHP в папке фото
```

**НЕ кладём:** `data/app.db` (БД не входит в пакет — см. ниже), `docs/`, `api/E8_SYNC.md`,
`test_*` (корневые и `js/test_*`), `api/*_test.php`, `n8n/` (экспорты workflow и их код),
`scripts/`, `reports/`, `staff_project/`, корневой `.htaccess`
(php_flag → 500), `DEPLOY.md`, `css/`, `QA_REPORT.md`.

> **БД.** `data/app.db` в пакет не входит — ни при первой выкладке, ни при обновлении.
> При самой первой выкладке (на сервере ещё нет БД) БД инициализируется локально
> (`php api/init_db.php` на PHP 8.3 в staging-копии) и заливается **отдельным** `scp` в `$WWW/data/`;
> при обновлении живую `data/app.db` на проде не трогаем (раздел 4).

## 2. Сборка пакета (на машине разработчика, PHP 8.3)

Собирать из чистого дерева нужной ветки/коммита (корень репозитория). Корневой `.htaccess`
в пакет не попадает: он не входит в allowlist.

```bash
set -euo pipefail
cd /home/hermes/service-center-app          # корень репозитория (или worktree нужной ветки)
OUT=/home/hermes/sc-hostland-deploy.tar.gz

# Шаг 1. Guard ПДн. exit != 0 -> сборку ПРЕРВАТЬ (set -e), пакет не создавать.
bash scripts/check_no_pii.sh            # по умолчанию: index.html js api

# Шаг 2. JS — только реально подключённые в index.html (<script src>), без внешних URL.
JS=$(grep -oP '<script[^>]+src="\K[^"]+' index.html | grep -vE '^(https?:)?//')

# Шаг 3. api/*.php, кроме служебных/отладочных (списком) и ВСЕХ тестов `*_test.php` (шаблоном:
#        новый тест не попадёт в пакет, даже если про него забыли).
API=$(ls api/*.php | grep -vE '^api/(smoke_test|init_db|seed_positions|debug_token)\.php$|_test\.php$')

# Шаг 4. Явный allowlist (никаких каталогов целиком).
tar -czf "$OUT" \
  index.html upload.php \
  $JS \
  $API api/.htaccess api/schema.sql \
  data/.htaccess data/holidays/*.json \
  images/.htaccess

# Шаг 5. Приложить список содержимого и убедиться, что запрещённого в пакете нет.
tar -tzf "$OUT" | sort | tee /home/hermes/sc-hostland-deploy.lst
if tar -tzf "$OUT" | grep -E '^(docs/|scripts/|reports/|staff_project/|n8n/|data/app\.db|test_|js/test_|api/(E8_SYNC\.md|smoke_test\.php|init_db\.php|seed_positions\.php|debug_token\.php)$|\.htaccess$)|_test\.php$'; then
  echo "ЗАПРЕЩЁННЫЕ ФАЙЛЫ В ПАКЕТЕ — выкладку остановить" >&2; rm -f "$OUT"; exit 1
fi
```

> Список `tar -tzf … | sort` каждой сборки прикладывается к отчёту о выкладке.
> Шаг 1 проверяет исходники; результат на проде проверяется отдельно (раздел 10).

## 3. Выкладка на Hostland

```bash
# с машины разработчика:
sshpass -p '<пароль>' scp -P 1024 /home/hermes/sc-hostland-deploy.tar.gz \
  host1882970@serv18.hostland.ru:/home/host1882970/

# на сервере (SSH):
WWW=~/host1882970.hostland.pro/htdocs/www
tar -czf ~/backups/old-site-$(date +%Y%m%d-%H%M).tar.gz -C $WWW .   # бэкап старого
tar -xzf ~/sc-hostland-deploy.tar.gz -C $WWW
# ТОЛЬКО при самой первой выкладке (БД на сервере ещё нет): отдельным scp залить
# локально инициализированную data/app.db в $WWW/data/ (в пакет она не входит).
find $WWW/api $WWW/data $WWW/images $WWW/js -type d -exec chmod 755 {} +
find $WWW/api $WWW/data $WWW/images $WWW/js -type f -exec chmod 644 {} +
chmod 644 $WWW/index.html $WWW/upload.php
rm -f ~/sc-hostland-deploy.tar.gz
```

> Каталог `static/` (владелец `host1882970_1`) не трогать — chmod на него падает без прав.

## 4. Обновление приложения (когда код изменится)

Живую `data/app.db` НЕ перезаписывать (пакет её и не содержит). Порядок:

```bash
WWW=~/host1882970.hostland.pro/htdocs/www

# 0. Снимок ACL ДО выкладки (R1-01): data/ и images/ принадлежат веб-юзеру/имеют его ACL.
getfacl -p $WWW/data $WWW/images | tee ~/acl-before.txt

# 1. Бэкап БД ПЕРЕД выкладкой (абсолютный путь, каталог backups должен существовать).
mkdir -p /home/host1882970/backups
sqlite3 $WWW/data/app.db ".backup '/home/host1882970/backups/app-$(date +%F-%H%M).db'"
ls -l /home/host1882970/backups | tail -3        # убедиться, что копия создана и не пуста

# 2. Распаковать пакет во временный каталог и скопировать в $WWW.
mkdir -p /tmp/scnew && tar -xzf ~/sc-hostland-deploy.tar.gz -C /tmp/scnew
cp -a /tmp/scnew/api /tmp/scnew/index.html /tmp/scnew/js /tmp/scnew/upload.php $WWW/
cp -a /tmp/scnew/data/.htaccess /tmp/scnew/data/holidays $WWW/data/ 2>/dev/null
# images/.htaccess на прод НЕ копировать (R1-02): в нём php_flag -> на Hostland даёт HTTP 500
# для всех /images/*. Файл в репозитории не меняется; проверка фото — строка /images/ в разделе 10.
rm -rf /tmp/scnew ~/sc-hostland-deploy.tar.gz

# 3. Удалить с прода устаревшие/служебные файлы (F-02). `cp -a` их не удаляет сам.
cd $WWW
rm -f  api/smoke_test.php api/debug_token.php api/init_db.php api/seed_positions.php api/E8_SYNC.md
rm -f  api/*_test.php                         # тесты по шаблону: tasks_test.php, tasks_n8n_test.php и любые будущие *_test.php
rm -rf docs
rm -f  js/test_*.js test_*.php test_*.sh      # тестовые файлы, если есть
# (api/schema.sql остаётся: нужен db.php для миграций; закрывается от веба в HF-2)

# 4. Права (R1-01): chmod ТОЛЬКО для кодовых каталогов и двух файлов. Без -R.
#    data/, images/, static/ и data/app.db НЕ трогать: в images/ лежат фото веб-юзера
#    (chmod -> Operation not permitted), chmod на data/ может пересчитать ACL-маску
#    и отнять у веб-юзера запись в data/app.db.
find api data/holidays js -type d -exec chmod 755 {} +
find api data/holidays js -type f -exec chmod 644 {} +
chmod 644 index.html upload.php

# 5. Снимок ACL ПОСЛЕ выкладки и сравнение с шагом 0: различий быть не должно.
getfacl -p $WWW/data $WWW/images > ~/acl-after.txt
diff ~/acl-before.txt ~/acl-after.txt && echo "OK   ACL data/images не изменились" || echo "FAIL: ACL изменились"

# 6. Служебные файлы удалены (R2-01): каждый должен отдавать 403 или 404.
BASE=http://host1882970.hostland.pro
for p in /api/debug_token.php /api/smoke_test.php /api/init_db.php /api/seed_positions.php \
         /api/tasks_test.php /api/tasks_n8n_test.php \
         /api/E8_SYNC.md /docs/API_DOCUMENTATION.json; do
  code=$(curl -sI -o /dev/null -w '%{http_code}' "$BASE$p")
  case $code in 403|404) echo "OK   $p -> $code";; *) echo "FAIL $p -> $code (ожидалось 403|404)";; esac
done
```

Чек-лист §4: (1) `acl-before.txt` снят до распаковки; (2) `images/.htaccess` не скопирован;
(3) `chmod` выполнен только на `api`, `data/holidays`, `js`, `index.html`, `upload.php`;
(4) `diff` ACL пуст; (5) `curl -I` по 8 путям шага 6 — только 403/404; (6) запись работает:
логин и сохранение данных в приложении (проверяет, что у веб-юзера сохранилась запись в `data/app.db`);
(7) выполнен раздел 10.

После обновления — обязательно раздел 10 «Проверка после выкладки».

## 5. Проверка после деплоя (только веб — CLI-тесты недоступны)

> Анонимная матрица проверок с ожидаемыми кодами (обязательна после каждой выкладки) — раздел 10.

```bash
BASE=http://host1882970.hostland.pro
JAR=/tmp/jar.$$
# 1. Логин
curl -s -c $JAR -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"<НОВЫЙ ПАРОЛЬ>"}' $BASE/api/login.php
# 2. Состояние
curl -s -b $JAR $BASE/api/load.php | head -c 200
# 3. ЗАЩИТА БД (ожидаем 403)
curl -s -o /dev/null -w '%{http_code}\n' $BASE/data/app.db
# 4. Anon-защита (ожидаем 401)
curl -s -o /dev/null -w '%{http_code}\n' $BASE/api/load.php
# 5. Фронтенд
curl -s -o /dev/null -w '%{http_code}\n' $BASE/
rm -f $JAR
```

## 6. Бэкапы на Hostland

CLI-скрипты cron на шареде недоступны, но есть панель Hostland → «Планировщик (cron)».
Настройте ежедневное задание (веб-интерфейс панели или поддержка Hostland):

```
sqlite3 /home/host1882970/host1882970.hostland.pro/htdocs/www/data/app.db \
  ".backup '/home/host1882970/backups/app-$(date +\%F).db'"
```

> `$(date)` и `%` в панели экранируйте по её правилам. Хранить 30 последних копий:
> `find /home/host1882970/backups -name 'app-*.db' -mtime +30 -delete`.
> Альтернатива: раздел «Резервные копии» в панели Hostland (делает снапшот всего хостинга).

## 7. Первый вход и смена паролей (КРИТИЧНО)

1. Открыть `http://host1882970.hostland.pro/` → войти `admin / changeme`
2. F12 → Console:
```js
fetch('/api/change_password.php', {
  method: 'POST',
  headers: {'Content-Type': 'application/json'},
  credentials: 'same-origin',
  body: JSON.stringify({currentPassword: 'changeme', newPassword: 'НОВЫЙ_ПАРОЛЬ_12+'})
}).then(r => r.json()).then(console.log)  // {success: true}
```
3. Повторить для `supervisor_zone0` и `supervisor_zone1`
4. Сменить SSH-пароль хостинга (использовался для деплоя)

## 8. External API token

Токен печатается при локальной инициализации БД (шаг 2) — сохранить в менеджер паролей.
Узнать текущий можно на сервере:
```bash
sqlite3 ~/host1882970.hostland.pro/htdocs/www/data/app.db \
  "SELECT value FROM meta WHERE key='external_api_token';"
```
Использование: `Authorization: Bearer <токен>` → `api/vacation_import.php`.

## 9. Известные ограничения этого окружения

- **HTTP без SSL** — пароли открытым текстом (риск принят, внутренний круг лиц). Пароли 12+.
- **CLI PHP 5.3** — smoke/init только через веб или с машины разработчика.
- **php_flag/.htaccess-директивы PHP** не поддерживаются (500) — настройки PHP только через панель.
- **`.user.ini`** можно попробовать для PHP-настроек (проверить в панели), но display_errors обычно уже выключен у Hostland.
- Техдомен `host1882970.hostland.pro` — если понадобится свой домен, сайт в панели привязывается к новому домену с тем же каталогом.

## 10. Проверка после выкладки (анонимные curl, без cookie)

Выполняется сразу после каждой выкладки (§3/§4). Любое отклонение от ожидания — выкладка
не принята, разбираться до закрытия окна работ.

| URL | Ожидание |
|---|---|
| `/` | 200, и `curl -s … \| bash scripts/check_no_pii.sh -` находит 0 совпадений (exit 0) |
| `/api/holidays.php` | 401 |
| `/api/smoke_test.php` | 403 или 404 |
| `/api/init_db.php` | 403 или 404 |
| `/api/seed_positions.php` | 403 или 404 |
| `/api/tasks.php` (без сессии) | 401 |
| `/api/tasks_test.php` | 403 или 404 |
| `/api/tasks_n8n_test.php` | 403 или 404 |
| `/api/debug_token.php` | 403 или 404 (файла нет; 403 даёт `FilesMatch` в `api/.htaccess` — факт выкладки T1 2026-11-11) |
| `/api/schema.sql` | 403 |
| `/docs/API_DOCUMENTATION.json` | 404 |
| `/api/E8_SYNC.md` | 403 или 404 |
| `/images/<существующее фото>` | 200 (проверка, что `images/.htaccess` с `php_flag` не даёт 500, R1-02) |
| `/api/session.php` | 200, без заголовка `X-Powered-By` |
| `/data/app.db` | 403 |

```bash
BASE=http://host1882970.hostland.pro
chk() { # chk <path> <regex ожидаемых кодов>
  code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE$1")
  if echo "$code" | grep -Eq "^($2)$"; then echo "OK   $1 -> $code"; else echo "FAIL $1 -> $code (ожидалось $2)"; fi
}
chk /                              200
chk /api/holidays.php              401
chk /api/smoke_test.php            '403|404'
chk /api/init_db.php               '403|404'
chk /api/seed_positions.php        '403|404'
chk /api/tasks.php                 401              # без сессии (блок «Задачи»)
chk /api/tasks_test.php            '403|404'        # тесты на прод не выкладываются
chk /api/tasks_n8n_test.php        '403|404'
chk /api/debug_token.php           '403|404'
chk /api/schema.sql                403
chk /docs/API_DOCUMENTATION.json   404
chk /api/E8_SYNC.md                '403|404'
# фото: подставить реальное имя существующего файла из images/ (ls $WWW/images | head)
chk /images/<существующее-фото>    200
chk /api/session.php               200
chk /data/app.db                   403
# заголовок X-Powered-By на session.php: ожидаем пустой вывод
curl -sI $BASE/api/session.php | grep -i '^x-powered-by' && echo "FAIL: X-Powered-By присутствует" || echo "OK   X-Powered-By отсутствует"
# ПДн в отдаваемом анонимно index.html: ожидаем exit 0
curl -s $BASE/ | bash scripts/check_no_pii.sh - && echo "OK   / без ПДн" || echo "FAIL: ПДн в /"
```

> `scripts/check_no_pii.sh -` читает stdin; при совпадении печатает только номера строк
> (`<stdin>:N`), сами значения не выводятся. Скрипт выполняется на машине разработчика
> (в пакет и на прод он не попадает).
>
> Часть ожиданий (`/api/holidays.php` → 401, `/api/schema.sql` → 403, `/api/session.php`
> без `X-Powered-By`, 404 на `debug_token.php`) обеспечивается изменениями HF-2; до его выкладки
> эти строки матрицы могут не выполняться — это ожидаемо, но фиксируется в отчёте о выкладке.

## 11. Смена токена робота после хотфикса

Выполняет **владелец по SSH**. Значения токенов в чат, логи и файлы не выводить.

```bash
sqlite3 ~/host1882970.hostland.pro/htdocs/www/data/app.db \
  "DELETE FROM meta WHERE key='rpa_relay_token';"
```

Токен робота пересоздаётся лениво при `?action=reveal` (теперь только admin); новое значение
владелец передаёт роботу штатным способом.

Токен импорта (`external_api_token`) **не меняется** — решение владельца 2026-10-26:
внешняя система принадлежит владельцу. Утечки нет: `debug_token.php` показывал 16 из 64
hex-символов, оставшиеся 48 (192 бита) не подбираются.

## 12. n8n на проде (вариант A, решение владельца 2026-11-10)

В варианте A n8n на проде **не подключается**. Переменные окружения `TASKS_VALIDATE_WEBHOOK_URL`,
`TASKS_RECHECK_WEBHOOK_URL`, `TASKS_N8N_WEBHOOK_SECRET` на Hostland **НЕ задаются** — блок «Задачи»
работает в чистом PHP-режиме: правила FR-10 считает `api/tasks_rules.php`, `check_state` всегда `ok`,
перепроверка pending не запускается, внешние вызовы не выполняются. Каталог `n8n/` (экспорты workflow)
в пакет не входит (раздел 2).

Подключение n8n к проду — отдельным решением владельца. Для справки (при таком решении): таймаут
проверки при сохранении (`tasks-validate`) — 3 с, фоновой перепроверки (`tasks-recheck`) — 10 с;
вызов дольше 10 с пишется в `error_log` строкой `tasks n8n ANOMALY workflow=… ms=… reason=…`
(`reports/TASKS_BLOCK/T1-9_REPORT.md`).
