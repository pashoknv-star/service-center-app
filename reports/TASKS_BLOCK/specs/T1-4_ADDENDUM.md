# T1-4 ADDENDUM (2026-11-07, координатор) — заменяет противоречащие пункты T1-4.md

## 1. Ключ n8n (замена PRECONDITION)
- Ключ: `/etc/service-center-app/secrets.env` (`root:hermes 640`), переменная `N8N_API_KEY`.
- Загружать только в окружение своих команд: `set -a; . /etc/service-center-app/secrets.env; set +a`.
  Значение НЕ печатать, не логировать, не копировать в файлы/коммиты/отчёты (в отчёте — только длина или «set»).
- Проверено координатором: `GET /api/v1/workflows` с ключом → 200.
- Заметка: публичный API n8n не отдаёт список credentials (`GET /api/v1/credentials` → 405) — это норма; создание через `POST /api/v1/credentials`.

## 2. Топология: push-модель (замена п.1, п.2, п.6 в части потока данных)
Факт: n8n — удалённый сервер (`n8n.domenforjob.ru` = 178.212.13.17), dev-приложение — локальный `php -S` на другом хосте; прод — HTTP (BL-02).
Поэтому n8n НИКОГДА не вызывает приложение (ни `calendar_facts`, ни запись). Поток только приложение → n8n по HTTPS.

1. `tasks-validate` (webhook POST, header-auth секрет): вход = `{employee_ids[], from, to, facts}`, где `facts` — тот же
   набор, что отдаёт `calendar_facts` (приложение собирает его само через `tasks_rules.php`). n8n только применяет правила
   и возвращает `{blocked_days[], notes[], suggested_start}`. Логика строго эквивалентна `tasks_rules.php`.
   Если `suggested_start` требует фактов за пределами `[from,to]` — приложение передаёт окно фактов с запасом (обосновать размер в отчёте).
2. `tasks-recheck` вместо расписания n8n: webhook, который вызывает ПРИЛОЖЕНИЕ пакетом
   `{tasks:[{id, employee_ids, from, to}], facts}` для задач с `check_state='pending'`; ответ — вердикт по каждой задаче,
   запись `check_state`/`conflict` делает приложение у себя. Триггер на стороне приложения: при чтении списка, если есть
   `pending` и с прошлой перепроверки прошло ≥ 15 мин (метка в `meta`), с таймаутом 3 с и без блокировки ответа пользователю
   при недоступности n8n. Workflow с Schedule-триггером в n8n НЕ создавать.
3. Сервис-эндпойнт `calendar_facts` с Bearer-токеном оставить как есть (контракт T1-1), но n8n его не использует.
4. Конфигурация приложения — только через окружение (уже есть `getenv('TASKS_VALIDATE_WEBHOOK_URL')`):
   `TASKS_VALIDATE_WEBHOOK_URL`, `TASKS_RECHECK_WEBHOOK_URL`, `TASKS_N8N_WEBHOOK_SECRET`. Без переменных — PHP-fallback (как сейчас).
5. Webhook-секрет генерирует исполнитель: в n8n — header-auth credential через REST API; для dev — файл
   `~/.config/service-center-app/dev.env` (вне репозитория, `chmod 600`). В репозиторий/отчёт/лог секрет не попадает.
   Для прода переменные выставит владелец при «Деплой» — в отчёте перечислить имена переменных.
6. Тесты: `verify_all.sh` обязан проходить и БЕЗ переменных n8n (fallback). Сверка n8n vs PHP (п.5 исходной спецификации) —
   отдельным скриптом с реальными вызовами n8n; таблица кейсов в отчёте, расхождений 0.
7. Активировать в n8n только `tasks-validate` и `tasks-recheck`. JSON-экспорты — в `n8n/` без credentials и секретов.

## 3. Не менялось
Acceptance AC-3, AC-4, AC-8; запрет деплоя и пуша; при блокирующей проблеме — `kanban block` с причиной, не complete.
