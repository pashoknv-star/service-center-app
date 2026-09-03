# E6 DEPLOY — Hostland, 2026-09-03

## Что деплоилось
Коммит `d65608e` (E6 «Ошибки 6», поверх прода на `de5e5bf`/E5).
Дельта с прода: только `js/trips.js` (97+/29-).

Состав E6:
- T1: сохранение КМ — employeeId из `data-emp-id` + канонизация `emp_<n>`,
  нормализация `saveTrip('undefined')→null`, валидация «Укажите даты командировки»;
- T2: гейт «Удалить» по `trip.id` (новая КМ из матрицы — ровно Отменить+Сохранить);
- T3: ярлык пик-режима — `writing-mode: vertical-rl` + `rotate(180deg)`,
  кнопки 40×120, чтение снизу вверх;
- тест e51: ассерт «no rotation» заменён на «vertical-rl + rotate(180deg)».

## Пакет
`/home/hermes/sc-hostland-deploy-e6.tar.gz` — 49 файлов, 245826 Б.
Исключены: `data/app.db*` (живая БД), `api/smoke_test.php`.
Upload md5: `6b8f141f…` = локальный (транспортировка без искажений).

## Бэкапы (~/backups/)
- `pre-e6-20260903.tar.gz` — 2303729 Б (код www до выкладки);
- `app-pre-e6-20260903.db` — 1163264 Б (консистентный снапшот БД, sqlite3 .backup,
  литеральные пути — $VAR в dot-командах не раскрываются).

## Выкладка
`tar xzf` в `~/host1882970.hostland.pro/htdocs/www` → DEPLOY_COPY_OK.

## Верификация
- md5 `js/trips.js` на проде = `edb84850…` = локальному (HEAD d65608e) — байт-в-байт;
- md5 `index.html` = `20798c77…` = локальному (не менялся, контроль чистоты);
- отданный браузеру `js/trips.js` (112337 Б) md5 = тому же файлу;
- маркеры E6 в отданном коде: «Укажите даты командировки» ×1,
  `trip && trip.id && user && canDeleteTrip` ×1, `writing-mode: vertical-rl` ×1,
  `data-emp-id` ×11;
- защита: фронт 200, `api/load.php` анонимно 401, `data/app.db` 403.

## Регресс перед деплоем (локально, тот же коммит)
E2E реальные клики 16/16 (TOTAL_FAIL=0); smoke 76/76; hygiene 19/19;
e51 23/23; e52 41/41.

## Откат
`tar xzf ~/backups/pre-e6-20260903.tar.gz -C ~/host1882970.hostland.pro/htdocs/www`
(БД не менялась — откат БД не требуется).
