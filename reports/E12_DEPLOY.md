# E12 DEPLOY — Hostland, 2026-09-29

## Что деплоилось
Коммит `0361e6f` (Ф1 RPA: E12-1 + E12-2 relay + E12-3 UI), поверх прода на `d65608e` (E6, 03.09).
Дельта с прода: E10-2..E10-5 (инцидент-фиксы, 28.09) + E12 (schema v7/v8, api/trip_relay.php, api/helpers.php, api/trips.php, api/db.php, api/schema.sql, js/trips.js).

## Пакет
`/home/hermes/sc-hostland-deploy.tar.gz` — 49 файлов, 272K.
Исключены: `data/app.db*` (живая БД), scripts/, reports/, staff_project/, DEPLOY*.md, AGENTS.md.

## Бэкапы (~/backups/)
- `pre-e12-20260929-1556.tar.gz` — 2.4M (код www до выкладки);
- `app-pre-e12-20260929-1556.db` — 1.6M (консистентный снапшот БД, sqlite3 .backup, литеральные пути).

## Выкладка
scp (sshpass, пароль с деплоя E5/E6 — владельцем подтверждено: не ротирован) →
tar в /tmp/scnew → cp -a БЕЗ data/app.db → chmod. DEPLOY_COPY_OK.

## Pre-apply миграции (прод-БД была v6)
ALTER TABLE trips +9 колонок (RPA v1.2), CREATE trip_requests + 2 индекса, meta.schema_version 6→8.
Проверено: 18 колонок trips, trip_requests 0 строк.
⚠ Известный артефакт: в pre-apply DDL добавлена лишняя колонка `trip_requests.token` (её нет в schema.sql кода). Инертна: весь код обращается по явным спискам колонок; DROP COLUMN недоступен (sqlite 3.26 < 3.35). При будущих пересозданиях таблицы исчезнет.

## Верификация
- фронт `/` 200; `api/load.php` анонимно 401; `data/app.db` 403; **`api/trip_relay.php` 401 missing_token (не 404 — новый файл жив)**;
- `js/trips.js` на проде md5 = локальному HEAD `0361e6f` (2ff2079b…) — байт-в-байт, 121184 Б;
- маркеры E12 в отданном коде: «Проведение технических работ» ×1, tripBusinessProcess ×2, maskPhoneField ×2, transportOutRequired ×5;
- smoke 76/76, trips-сьют 7/7, полный relay e2e — локально на том же коммите.
- Функциональный reveal/poll на проде не выполнялся (прод-пароль приложения ротирован владельцем; анонимная матрица достаточна). Владельцу: login admin → GET /api/trip_relay.php?action=reveal → токен робота.

## Токен робота
Генерируется при первом обращении к relay-эндпоинту (INSERT OR IGNORE meta.rpa_relay_token). Получение: admin-сессия → `GET /api/trip_relay.php?action=reveal`. Для Sherpa: заголовок `X-Auth-Token`.

## Откат
`tar xzf ~/backups/pre-e12-20260929-1556.tar.gz -C ~/host1882970.hostland.pro/htdocs/www`
+ при необходимости БД: `cp ~/backups/app-pre-e12-20260929-1556.db ~/host1882970.hostland.pro/htdocs/www/data/app.db` (осторожно, WAL).

## Регламент
SSH-пароль хостинга по-прежнему старый (подтверждено владельцем 29.09: ротация не проводилась) — сменить после деплоя.
