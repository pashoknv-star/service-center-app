# Деплой Service Center App (Apache + mod_php, HTTP)

Пошаговая инструкция развёртывания на прод-сервер: **Apache 2.4 + PHP 8.3 (mod_php), без SSL** (HTTP, внутренний круг пользователей — решение владельца).

Все команды выполняются от root или через `sudo`, если не указано иное. ОС: Debian/Ubuntu.

---

## 1. Требования

- **Apache 2.4** с включёнными модулями `mod_php` (ставится пакетом `libapache2-mod-php8.3`) и `mod_rewrite` (входит в стандартную поставку).
- **PHP 8.3** как модуль Apache (не PHP-FPM). Расширения:
  - `pdo_sqlite` (драйвер SQLite для PDO) — обязателен;
  - `gd` — обработка загруженных фото — обязателен;
  - `mbstring` — обязателен;
  - `fileinfo` — проверка MIME-типа загружаемых файлов по сигнатуре (обычно встроен и включён по умолчанию);
  - `imagick` — опционален (в приложении есть fallback на GD; без него всё работает).
- **SQLite3 CLI** (`sqlite3`) — для бэкапов по cron (см. раздел 9).

Проверка расширений после установки:

```bash
php -m | grep -Ei 'pdo_sqlite|gd|mbstring|fileinfo|imagick'
```

Ожидается как минимум: `pdo_sqlite`, `gd`, `mbstring`, `fileinfo`.

## 2. Установка пакетов (Debian/Ubuntu)

```bash
sudo apt update
sudo apt install apache2 libapache2-mod-php8.3 php8.3-sqlite3 php8.3-gd php8.3-mbstring sqlite3
```

Опционально: `sudo apt install php-imagick` (если предпочитаете ImageMagick вместо GD).

Пакет `php8.3-sqlite3` даёт расширение `pdo_sqlite` (+ `sqlite3` extension). Установщик `libapache2-mod-php8.3` сам включает модуль и перезапускает Apache.

## 3. Копирование файлов

Распакуйте deploy-пакет в `/var/www/service-center-app`:

```bash
sudo mkdir -p /var/www/service-center-app
sudo tar -xzf service-center-app-deploy.tar.gz -C /var/www/service-center-app
```

Если архив собран с префиксом каталога внутри (проверьте: `tar -tzf service-center-app-deploy.tar.gz | head`), и файлы лежат в корне архива — команда выше корректна. Если внутри архива есть вложенный каталог `service-center-app/`, распакуйте во временный каталог и перенесите:

```bash
sudo tar -xzf service-center-app-deploy.tar.gz -C /tmp/
sudo cp -a /tmp/service-center-app/. /var/www/service-center-app/
```

Итоговая структура:

```
/var/www/service-center-app/
├── .htaccess              # php_flag display_errors off и др. (нужен AllowOverride All!)
├── index.html             # всё frontend-приложение (vanilla JS)
├── upload.php             # корневой обработчик загрузки фото
├── QA_REPORT.md           # отчёт QA (справочный, не обязателен в проде)
├── api/                   # backend: auth.php, db.php, init_db.php, smoke_test.php,
│                          #        change_password.php, employees.php, entries.php, ...
│                          #        schema.sql
├── css/                   # стили (каталог может быть пустым)
├── data/                  # SQLite-база app.db + .htaccess (Require all denied)
│   ├── app.db             # создаётся на шаге 7 (init_db.php)
│   └── holidays/
├── images/                # загруженные фото сотрудников + .htaccess (запрет исполнения PHP)
├── js/                    # storage.js и др.
└── scripts/               # вспомогательные скрипты (check_syntax.js, generate_holidays.py)
```

## 4. Права доступа

Apache (пользователь `www-data`) пишет **только** в два места: `data/` (SQLite-база и её journal/WAL-файлы) и `images/` (загруженные фото). Всё остальное — только чтение, владелец root.

```bash
# Каталоги для записи Apache (БД + фото):
sudo chown -R www-data:www-data /var/www/service-center-app/data /var/www/service-center-app/images
sudo find /var/www/service-center-app/data /var/www/service-center-app/images -type d -exec chmod 750 {} \;
sudo find /var/www/service-center-app/data /var/www/service-center-app/images -type f -exec chmod 640 {} \;

# Код приложения: владелец root, группа www-data, Apache только читает:
sudo chown -R root:www-data /var/www/service-center-app
sudo find /var/www/service-center-app -type d -exec chmod 750 {} \;
sudo find /var/www/service-center-app -type f -exec chmod 640 {} \;

# Повторно отдать data/ и images/ пользователю Apache (после chown root выше):
sudo chown -R www-data:www-data /var/www/service-center-app/data /var/www/service-center-app/images
```

Пояснения:
- право на запись в код приложения Apache'у не нужно — уменьшает ущерб от компрометации;
- `chmod 750/640` дают группе `www-data` чтение (и вход в каталоги), посторонним пользователям системы — ничего;
- SQLite пишет рядом с `app.db` временные файлы (`app.db-journal`, `app.db-wal`) — поэтому права нужны на **каталог** `data/`, а не только на файл.

## 5. VirtualHost (apache2)

Создайте `/etc/apache2/sites-available/service-center.conf`:

```apache
<VirtualHost *:80>
    ServerName service-center.local
    ServerAdmin webmaster@localhost

    DocumentRoot /var/www/service-center-app

    <Directory /var/www/service-center-app>
        Options -Indexes +FollowSymLinks
        AllowOverride All
        Require all granted
    </Directory>

    ErrorLog  ${APACHE_LOG_DIR}/service-center-error.log
    CustomLog ${APACHE_LOG_DIR}/service-center-access.log combined
</VirtualHost>
```

**КРИТИЧНО — `AllowOverride All`.** Без него Apache игнорирует `.htaccess`, а именно там закрыт веб-доступ к базе:

- `data/.htaccess` содержит `Require all denied` — без `AllowOverride All` файл `data/app.db` будет **скачиваться по URL** (`http://сервер/data/app.db`) вместе с паролями всех пользователей;
- `images/.htaccess` запрещает исполнение PHP в папке с фото;
- корневой `.htaccess` выключает `display_errors` на уровне приложения.

`ServerName` замените на реальное имя/IP сервера (или уберите строку — тогда сработает дефолт). **Редиректа на HTTPS нет и не должно быть** — прод работает по HTTP по решению владельца (см. раздел 12).

Альтернатива `.htaccess` (если политика сервера запрещает `AllowOverride`): перенесите те же правила (`Require all denied` для `data/`, запрет `.php` в `images/`, `php_flag display_errors off`) прямо в `<Directory>`-блоки конфига и поставьте `AllowOverride None`. Поведение идентично.

Включение сайта:

```bash
sudo a2ensite service-center
sudo a2dissite 000-default
sudo apache2ctl configtest    # ожидается: Syntax OK
sudo systemctl reload apache2
```

## 6. PHP настройки

Отредактируйте `/etc/php/8.3/apache2/php.ini` (это ini именно для mod_php):

```ini
display_errors = Off
log_errors = On
```

Ошибки при этом не теряются — пишутся в error_log Apache (`/var/log/apache2/service-center-error.log`).

Корневой `.htaccess` приложения дополнительно дублирует `php_flag display_errors off` — это страховка на уровне приложения (работает при `AllowOverride All` из раздела 5). Настройка в php.ini остаётся обязательной: не полагайтесь только на `.htaccess`.

Перезапуск после изменений:

```bash
sudo systemctl restart apache2
```

## 7. Инициализация БД

Выполняется один раз. Запускать от пользователя Apache, чтобы файлы БД сразу принадлежали `www-data`:

```bash
cd /var/www/service-center-app
sudo -u www-data php api/init_db.php
```

Скрипт создаёт схему (`api/schema.sql`), пользователей по умолчанию и печатает в stdout:

- логин/пароль администратора по умолчанию: **admin / changeme**;
- логины супервизоров: **supervisor_zone0 / changeme** и **supervisor_zone1 / changeme**;
- **external_api_token** — токен для внешнего API (используется как `Authorization: Bearer <token>` в `api/vacation_import.php`).

> ⚠️ **Вывод скрипта не публиковать** (не вставлять в тикеты, чаты, логи деплоя). Пароли по умолчанию меняются на шаге 8; `external_api_token` сохраните в менеджер паролей — повторно он не показывается.

Повторный запуск безопасен: существующие пользователи/токен пропускаются («already exists — skipping»).

## 8. Первый вход и смена паролей (КРИТИЧНО для HTTP!)

Пароли по умолчанию (`changeme`) известны всем, кто читал этот документ, а трафик идёт по HTTP открытым текстом — **смените пароли немедленно после первого входа**, до передачи системы пользователям.

Войти: `http://<сервер>/` → логин `admin` / пароль `changeme`.

### Смена пароля (кнопки в UI пока нет — используем API напрямую)

Endpoint `api/change_password.php` уже существует: любой залогиненный пользователь меняет **свой** пароль. Тело запроса: `{"currentPassword": "...", "newPassword": "..."}` (новый пароль — минимум 8 символов, но см. требование ниже про 12+).

**Вариант А (проще) — DevTools Console.** Откройте приложение, войдите, затем F12 → Console и выполните:

```js
fetch('/api/change_password.php', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  credentials: 'same-origin',
  body: JSON.stringify({
    currentPassword: 'changeme',
    newPassword: 'НОВЫЙ_ПАРОЛЬ_12+_СИМВОЛОВ'
  })
}).then(r => r.json()).then(console.log);
// ожидается: {success: true}
```

Кука сессии `PHPSESSID` подставляется браузером автоматически (запрос same-origin). После смены пароля войдите заново с новым паролем.

**Вариант Б — curl.** Куку нужно скопировать из браузера: F12 → Network → любой запрос к `api/` → Request Headers → строка `Cookie: PHPSESSID=...`. Затем на любой машине:

```bash
curl -X POST 'http://<сервер>/api/change_password.php' \
  -H 'Content-Type: application/json' \
  -b 'PHPSESSID=<значение_куки_из_браузера>' \
  -d '{"currentPassword":"changeme","newPassword":"НОВЫЙ_ПАРОЛЬ_12+_СИМВОЛОВ"}'
# ожидается: {"success":true}
```

### Требования к паролям

- **12+ символов** для всех учётных записей: авторизация и смена пароля идут по HTTP открытым текстом — короткий пароль легко перебрать по захваченному трафику. API формально допускает 8+, но для прода придерживайтесь 12+.
- **Повторить для каждой записи**: `admin`, `supervisor_zone0`, `supervisor_zone1` (войдите каждой по очереди и смените `changeme` тем же способом).

## 9. Бэкапы (cron)

Создайте `/etc/cron.daily/service-center-backup` (запускается ежедневно автоматически):

```bash
#!/bin/sh
# Ежедневный бэкап SQLite-базы Service Center App.
# sqlite3 ".backup" делает консистентный снапшот даже при активных записях
# (в отличие от простого копирования файла).

set -eu

APP_DB="/var/www/service-center-app/data/app.db"
BACKUP_DIR="/var/backups/service-center"
RETENTION_DAYS=30
# Вторая копия на другой диск/сервер (подставьте свой путь):
RSYNC_TARGET="/mnt/backup-disk/service-center"

mkdir -p "$BACKUP_DIR"

# 1. Консистентный снапшот через SQLite Online Backup API:
sudo -u www-data sqlite3 "$APP_DB" ".backup '$BACKUP_DIR/app-$(date +%F).db'"

# 2. Ретеншн: хранить 30 дней:
find "$BACKUP_DIR" -name 'app-*.db' -mtime +${RETENTION_DAYS} -delete

# 3. Копия на другой диск (если смонтирован):
if [ -d "$RSYNC_TARGET" ]; then
    rsync -a --delete "$BACKUP_DIR/" "$RSYNC_TARGET/"
fi
```

Установка:

```bash
sudo chmod 750 /etc/cron.daily/service-center-backup
sudo chown root:root /etc/cron.daily/service-center-backup
```

> `sudo -u www-data` нужен, если БД недоступна для чтения root'у из-за прав 640 www-data:www-data (в конфигурации из раздела 4 root имеет доступ ко всему — тогда `sudo -u` можно опустить; оставлено для симметрии с правами приложения).

Проверка вручную: `sudo /etc/cron.daily/service-center-backup && ls -la /var/backups/service-center/`.

## 10. Проверка после деплоя (smoke)

**Автотест.** Из каталога приложения на сервере:

```bash
cd /var/www/service-center-app
php api/smoke_test.php
```

Скрипт сам поднимает временный PHP-сервер на свободном порту, прогоняет все endpoint'ы и печатает результат. **Ожидается: `=== RESULTS: 26 passed, 0 failed out of 26 ===`** — все 26 PASS. Любой FAIL — деплой не считать завершённым, смотрите вывод.

> Smoke-тест работает с тестовыми данными через собственный временный сервер; на прод-базу `data/app.db` он не влияет.

**Ручная проверка в браузере** (`http://<сервер>/`):

1. Логин `admin` (новый пароль) — вход успешен, ошибки в консоли браузера отсутствуют.
2. Матрица расписания открывается, сотрудники и записи загружаются.
3. **Проверка защиты БД**: открыть `http://<сервер>/data/app.db` — **ожидается 403 Forbidden** (это делает `data/.htaccess` + `AllowOverride All`). Если файл скачивается — `AllowOverride` не включён, вернитесь к разделу 5.
4. Дополнительно: `http://<сервер>/images/test.php` — тоже должен быть запрещён.

## 11. Опционально: ограничение по IP

Если известны сети пользователей (офис, VPN), ограничьте доступ на уровне Apache — добавьте в `<Directory>`-блок из раздела 5:

```apache
    <Directory /var/www/service-center-app>
        Options -Indexes +FollowSymLinks
        AllowOverride All
        # Только доверенные сети:
        Require ip 192.168.1.0/24 10.8.0.0/24
    </Directory>
```

После изменения: `sudo apache2ctl configtest && sudo systemctl reload apache2`. Это заметно сужает поверхность атаки для системы без SSL (пароли в открытом тексте недоступны даже для сканирования из интернета, если сервер имеет публичный IP).

## 12. Известные ограничения (без SSL)

- **Пароли и сессионные куки передаются открытым текстом.** Любой, кто может перехватить трафик между пользователем и сервером (тот же сегмент LAN, Wi-Fi, маршрутизатор), видит логин, пароль и куку сессии. Риск **принят владельцем осознанно**: система предназначена для ограниченного круга лиц в доверенной сети.
- Из этого следует требование **длинных паролей (12+ символов)** — перехваченный пароль должен оставаться устойчивым к перебору до плановой смены.
- Смягчения уже в приложении: cookie `PHPSESSID` помечена `httponly` и `samesite=Lax` (XSS-кража сессии и базовый CSRF); при появлении TLS в будущем достаточно будет включить `secure`-флаг куки и HTTPS-редирект — код приложения изменений не требует.
- Если сервер когда-либо станет доступен из недоверенных сетей — первым делом включите HTTPS (Let's Encrypt) и раздел 11 (ограничение по IP).
