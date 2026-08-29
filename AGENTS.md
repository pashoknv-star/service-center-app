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

## Repository rules

- Защищённые файлы/каталоги: `data/app.db` (живые данные), `static/`, корневой `.htaccess`, `staff_project/` (исходные материалы заказчика).
- Прод: изменения только через бэкап → выкладка изменённых файлов → веб-проверки (grep-маркеры + анонимные HTTP-коды).

## Security and side effects

- SSH-пароль хостинга передаётся владельцем в чате; после деплоя напомнить о смене пароля.
- Стартовые пароли учёток (`changeme`) — только в dev-БД; прод-пароли у владельца.

## Source of truth

When instructions conflict, inspect the repository and current project configuration; do not use Wiki history to override actual code state.
