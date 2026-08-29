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

```
www/
├── index.html          # фронтенд (vanilla JS, монолит)
├── upload.php          # корневой делегат загрузки фото -> api/upload.php
├── api/                # весь backend (PHP 8.1-совместимый)
│   └── smoke_test.php  # можно НЕ заливать на прод (опционально)
├── js/storage.js
├── data/
│   ├── .htaccess       # Require all denied — ЗАЩИТА БД (работает, проверено)
│   ├── app.db          # SQLite, инициализированная локально
│   └── holidays/2026-2028.json
└── images/
    └── .htaccess       # запрет исполнения PHP в папке фото
```

**НЕ кладём:** корневой `.htaccess` (php_flag → 500), `DEPLOY.md`, `scripts/`, `css/`, `QA_REPORT.md`.

## 2. Сборка пакета (на машине разработчика, PHP 8.3)

```bash
# staging без корневого .htaccess
cd /home/hermes/sc-hostland-staging
rm -f data/app.db* && php api/init_db.php   # свежая БД
tar -czf /home/hermes/sc-hostland-deploy.tar.gz api data images index.html js upload.php
```

## 3. Выкладка на Hostland

```bash
# с машины разработчика:
sshpass -p '<пароль>' scp -P 1024 /home/hermes/sc-hostland-deploy.tar.gz \
  host1882970@serv18.hostland.ru:/home/host1882970/

# на сервере (SSH):
WWW=~/host1882970.hostland.pro/htdocs/www
tar -czf ~/backups/old-site-$(date +%Y%m%d-%H%M).tar.gz -C $WWW .   # бэкап старого
tar -xzf ~/sc-hostland-deploy.tar.gz -C $WWW
find $WWW/api $WWW/data $WWW/images $WWW/js -type d -exec chmod 755 {} +
find $WWW/api $WWW/data $WWW/images $WWW/js -type f -exec chmod 644 {} +
chmod 644 $WWW/index.html $WWW/upload.php
rm -f ~/sc-hostland-deploy.tar.gz
```

> Каталог `static/` (владелец `host1882970_1`) не трогать — chmod на него падает без прав.

## 4. Обновление приложения (когда код изменится)

```bash
# та же выкладка, НО: НЕ перезаписывать data/app.db (там живые данные)!
# Вариант: распаковать во временный каталог и скопировать всё, кроме data/app.db*:
tar -xzf ~/sc-hostland-deploy.tar.gz -C /tmp/scnew
WWW=~/host1882970.hostland.pro/htdocs/www
cp -a /tmp/scnew/api /tmp/scnew/index.html /tmp/scnew/js /tmp/scnew/upload.php $WWW/
cp -a /tmp/scnew/data/.htaccess /tmp/scnew/data/holidays $WWW/data/ 2>/dev/null
rm -rf /tmp/scnew ~/sc-hostland-deploy.tar.gz
```

## 5. Проверка после деплоя (только веб — CLI-тесты недоступны)

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
