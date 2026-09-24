# AGENTS.md — Project Runtime Instructions

## Scope

These instructions apply to this project. Keep them operational and concise; durable historical knowledge belongs in the Wiki.

## Роадмап доработок: фиксация выполнения

- ТРИГГЕР: явное одобрение владельцем (Pavel) исправлений/результатов работы — например, «исправления приняты».
- ДЕЙСТВИЕ: после одобрения обновить Роадмап доработок — файл `staff_project/Roadmap доработок (обновлён).xlsx` (openpyxl, `/home/hermes/.venv/bin/python3`): отметить статус этапа «выполнен», проставить дату и краткий результат.
- ЦЕЛЬ: фиксация выполнения задач проекта; роадмап — актуальный источник правды о прогрессе.
- БЕЗ одобрения владельца этап в роадмапе НЕ помечается выполненным — даже если деплой уже сделан.

## Build

- Локальный сервер: `php -S 127.0.0.1:8090 router.php` из корня проекта.
- Прод-пакет и порядок выкладки: см. `DEPLOY_HOSTLAND.md` (раздел 4 — обновление кода, никогда не перезаписывать `data/app.db`).

## Test

- Smoke-набор: `php api/smoke_test.php` из корня проекта (локально, PHP 8.3; на хостинге CLI PHP 5.3 — запускать нельзя). Критерий приёмки: 100% pass.
- Синтаксис: `php -l api/<file>.php`, `node --check js/storage.js`.

### JS-сьюты (frontend) [05.09.2026; 18:08]

Сьюты запускаются ЦЕЛИКОМ одной командой. НЕ разбивать прогон на отдельные вызовы по одному тесту.

- e51 (геометрия пик-панели): `node scripts/test_e51_pick_geometry.js`
- e52 (семантика выбора): `node scripts/test_e52_pick_semantics.js`
- hygiene: `node scripts/test_r4_hygiene.js`
- trips frontend: `bash scripts/test_trips_frontend.sh`
- E2E-харнесс: `/tmp/e5_final.js` (или актуальный `/tmp/e6_final.js`) через headless Chrome CDP
- Backend smoke: `php api/smoke_test.php`

После smoke обязательно возвращать dev-БД: `git checkout -- data/app.db`.

После patch — гонять только релевантный сьют, а не все пять, если изменения локальны (например, только e51 при правке геометрии пик-панели).

### Codebase navigation (CODEMAP) [05.09.2026; 18:08]

Файлы большие (index.html ~3000+ строк, js/trips.js, js/vacations.js) и без IDE-индекса:

1. В начале задачи, если CODEMAP.md устарел (правки после последнего обновления) — перегенерировать одним вызовом: `rg --json -n "function |const .*=.*=>" index.html js/trips.js js/vacations.js` (результат сохранить в CODEMAP.md).
2. CODEMAP.md — первичный источник номеров строк/функций; не грепать «вслепую» повторно.
3. После patch — обновлять релевантную секцию CODEMAP.md, если менялась сигнатура/расположение функции.

### Iteration limit checkpoint [05.09.2026; 18:08]

Если приближаетесь к пределу ходов в рамках turn — НЕ пытаться «успеть доделать всё»: зафиксировать текущий прогресс в todo/progress-файле и явно сообщить, какие пункты остались, вместо того чтобы упереться в hard limit без deliverable.

## Repository rules

- Защищённые файлы/каталоги: `data/app.db` (живые данные), `static/`, корневой `.htaccess`, `staff_project/` (исходные материалы заказчика).
- Прод: изменения только через бэкап → выкладка изменённых файлов → веб-проверки (grep-маркеры + анонимные HTTP-коды).

## Security and side effects

- SSH-пароль хостинга передаётся владельцем в чате; после деплоя напомнить о смене пароля.
- Стартовые пароли учёток (`changeme`) — только в dev-БД; прод-пароли у владельца.

## Source of truth

When instructions conflict, inspect the repository and current project configuration; do not use Wiki history to override actual code state.
