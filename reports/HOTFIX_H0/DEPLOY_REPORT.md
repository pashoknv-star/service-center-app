# HOTFIX-H0 — отчёт о деплое (Hostland)

Дата: 2026-10-27 (по серверу 2026-10-26 22:xx UTC). Коммит: `4cf6f27` (main). Доступ: ssh-алиас `hostland` (ключ `hermes_hostland`).

## Бэкап (до выкладки)
- БД: `~/backups/app-pre-hotfix-2026-10-26-2220.db` (1 638 400 Б, `sqlite3 .backup`).
- Код: `~/backups/old-site-pre-hotfix-20261026-2220.tar.gz` (2,4 МБ).
- ACL `data/`,`images/`: `~/acl-before.txt`; после выкладки идентичны (различие только в строке пути).

## Выкладка
Пакет по allowlist (`check_no_pii.sh` = 0, запрещённых файлов нет, список — `~/sc-hostland-deploy.lst`, 34 файла). `images/.htaccess` не копировался. `data/app.db` не тронута. Удалены с прода: `api/{smoke_test,debug_token,init_db,seed_positions}.php`, `api/E8_SYNC.md`, `docs/`.

## Анонимная матрица
| Проверка | Результат |
|---|---|
| `/` sha1 = sha1 `index.html` в main (`b5194ade…`), ФИО нет | OK |
| `holidays.php` GET / POST | 401 / 401 |
| debug_token, smoke_test, init_db, seed_positions, E8_SYNC.md, schema.sql | 403 |
| `/docs/…`, `/data/app.db`, `/data/.htaccess` | 404 / 403 / 403 |
| `api/load.php` без сессии | 401 |
| `X-Powered-By` | отсутствует |

## Не проверено (нужен логин владельца)
Вход и сохранение в приложении; reveal токена admin'ом; фото `/images/<файл>` → 200 (нужно имя существующего файла).

## Находки
1. **P2** Осиротевшие `/load.php`, `/save.php` в корне www (от 22.08): отдают 200 с Fatal и серверным путём. Не часть пакета. Предлагаю убрать в бэкап (обратимо) — по команде.
2. **P3** `DEPLOY_HOSTLAND.md` §2 post-check: паттерн `\.htaccess$` совпадёт с легитимными `api/.htaccess` и т.д. и ложно прервёт сборку (на деле запрещённое проверено вручную).
3. `DEPLOY_HOSTLAND.md` §3 (первая выкладка) всё ещё с рекурсивным chmod — для обновлений не используется.

## Действия владельца
Сменить токен робота HelpMe (удалить `meta.rpa_relay_token`, пересоздастся при reveal admin'ом); сменить SSH-пароль Hostland, если он светился.
