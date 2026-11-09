# T1-4 — Блок «Задачи»: n8n-правила (webhook, push-модель)

Исполнитель: sd_worker_04 · Дата: 2026-11-09 · Kanban: t_5c9a78a9
Основание: `T1-4.md` + **ADDENDUM c34b429** (при конфликте приоритет у ADDENDUM), `TZ.md` §3, эталон — `api/tasks_rules.php` (T1-1).
Деплой/push НЕ выполнялись. LLM не используется.

## Итог

- В n8n (`https://n8n.domenforjob.ru`) активны два workflow: **`tasks-validate`** (id `XoMucJtMzfiPzoCX`) и **`tasks-recheck`** (id `3aC0zXBxQuGoIYn8`).
  Остальные workflow не трогались; дубликатов нет (перед выкладкой список запрошен через REST, существующие обновлены in place `PUT`).
- Сверка с PHP-эталоном на реальных вызовах: validate 18 кейсов + recheck 7 задач + 10 негативных/защитных — **расхождений 0**.
- Сквозная проверка через живой HTTP-API приложения (`scripts/n8n_e2e_live.php`): `E2E LIVE: ALL PASSED`.
- `bash scripts/verify_all.sh` → **GATE: PASS (12 suites)**, без переменных n8n (fallback-режим), новый сьют `tasksn8n` 20/20.

## Отклонения от исходного ТЗ (по ADDENDUM) — что и почему

1. **Push-топология:** n8n никогда не вызывает приложение (n8n — удалённый сервер, dev-приложение — локальный `php -S`).
   `tasks-validate` получает `{employee_ids[], from, to, facts}` — `facts` приложение собирает само (формат `calendar_facts`) и возвращает
   `{blocked_days[], notes[], suggested_start}`. Токен `calendar_facts` в n8n не передаётся и не используется.
2. **Расписания в n8n нет:** `tasks-recheck` — webhook; вызывает его приложение пакетом `{tasks:[{id,employee_ids,from,to}], facts}` →
   `{results:[{id, conflict, blocked_days[]}|{id,error}]}`. Запись `check_state` делает приложение (`task.recheck` в audit_log).
   Триггер: при `GET api/tasks.php` (список), если есть `pending` и с прошлой попытки ≥ 15 мин (метка `meta.tasks_recheck_at`, захватывается атомарным
   `UPDATE … WHERE value <= now-900`). Вызов n8n идёт **после** отправки ответа пользователю (`Content-Length`+`Connection: close`/`fastcgi_finish_request`),
   таймаут 3 с, недоступность n8n ничего не ломает.
3. **Конфигурация — только окружение:** `TASKS_VALIDATE_WEBHOOK_URL`, `TASKS_RECHECK_WEBHOOK_URL`, `TASKS_N8N_WEBHOOK_SECRET`
   (заголовок `X-Tasks-Secret`). Не заданы → чистый PHP-режим (как в T1-1). Для prod переменные выставит владелец при «Деплой».
   Не через `meta` (ADDENDUM п.2.4 — окружение).
4. **Отдельных новых эндпойнтов в `api/tasks.php` не понадобилось** (п.3 исходного ТЗ): пакетная перепроверка и смена `check_state` — внутренние функции
   приложения (`tasks_recheck_pending`), контракт T1-1 не менялся (изменилась лишь сигнатура внутренней `tasks_enforce_fr10`: теперь возвращает `check_state`).
5. **Перепроверка через MCP n8n не выполнена:** в окружении воркера нет MCP-инструментов n8n (`search_workflows`/`get_workflow_details`).
   Вместо этого — перепроверка через REST `GET /workflows` и `GET /workflows/{id}`: оба workflow `active=true`, узлы `webhook → code → respondToWebhook`,
   Schedule/Cron-триггеров нет, код узла `Rules` побайтно совпадает с `n8n/code/common.js + tasks_*.js`, у Webhook `authentication=headerAuth` + credential `httpHeaderAuth`.
6. `AGENTS.md` (защищённый файл) не правился: строка BASELINE там по-прежнему без `tasks`/`tasksn8n`; источник истины — `scripts/verify_all.sh` (`tasksn8n=20`).
   Координатору: добавить `tasksn8n 20` в строку BASELINE.

## Что сделано

### n8n
- `n8n/tasks-validate.json`, `n8n/tasks-recheck.json` — JSON-экспорты (без credential id и секретов; в узле Webhook только имя credential
  `tasks-webhook-secret`). `n8n/code/common.js` — общая логика правил (JS-порт `tasks_rules.php`: блок sick/trip, notes выходной/праздник/отпуск/day_off,
  `suggested_start` с горизонтом), `n8n/code/tasks_validate.js`, `n8n/code/tasks_recheck.js`. Источник правды по JS — `n8n/code/*.js`; workflow собираются `scripts/n8n_deploy.py`.
- `scripts/n8n_deploy.py build|deploy` — сборка экспортов и выкладка через REST (`N8N_API_KEY` из `/etc/service-center-app/secrets.env`, не печатается; секрет вебхука
  генерируется, создаётся как httpHeaderAuth credential через `POST /credentials`, для приложения пишется в `~/.config/service-center-app/dev.env`, `chmod 600`, вне репозитория).
- Защита: webhook с header-auth; без/с неверным секретом → HTTP 403. Настройки workflow: `executionTimeout=10`, `saveDataSuccessExecution=none` (тела запросов с id сотрудников не накапливаются).
  Некорректный вход → HTTP 400 `{error:<код>}`.
- Размер окна фактов (ADDENDUM п.2.1): `tasks_n8n_validate_facts` отправляет полные строки на `[from,to]` (нужны notes) + **разреженные блокирующие строки** на `(to, to+HORIZON]`,
  HORIZON = `TASKS_SUGGEST_HORIZON_DAYS`: PHP-эталон ищет `suggested_start` в `[from, from+HORIZON+len−1] = [from, to+HORIZON]`, т.е. этого достаточно и результат совпадает побайтно.
  Объём: ≤ 100 исп. × 366 строк + только реальные sick/trip-дни в хвосте (единицы–десятки), а не 400 × исполнителей.

### Приложение (`api/tasks_rules.php`, `api/tasks.php`)
- `tasks_n8n_post()` — POST JSON с жёстким общим таймаутом 3000 мс (curl `CURLOPT_TIMEOUT_MS`, fallback — streams), секрет и тела в лог не пишутся, `reason` без секретов.
- `tasks_check_period_checked()` — вариант B: n8n ответил ≤ 3 с → вердикт n8n (`check_state=ok`); n8n недоступен/таймаут/500/невалидный JSON → PHP-эталон + `check_state='pending'`
  (допущение Д-3, AC-8); блок по PHP-fallback при этом сохраняется (422). Расхождение n8n/PHP пишется в `error_log` (запись по вердикту n8n).
- `tasks_recheck_claim()`/`tasks_recheck_pending()`/`tasks_send_json_then()` — перепроверка pending (см. выше). `pending→ok` без смены `version`/`updated_at`
  (чтобы не вызвать 409 у открытых вкладок), `conflict` как и раньше вычисляется при чтении (AC-4).

### Тесты
- `api/tasks_n8n_test.php` — 20 тестов на временной копии БД и **mock-webhook** (без сети): N1–N12 (транспорт, секрет, таймаут 3 с, 500/не-JSON/неверная форма, нормализация вердикта,
  состав фактов, без настройки = PHP), H1–H8 (POST/PUT через реальный HTTP-API: 201 ok; 422 по вердикту n8n; AC-8 pending при 500 и при таймауте — PUT ≤ ~3 с; перепроверка после ответа GET;
  троттлинг 15 мин; недоступный n8n при перепроверке; без переменных). Подключён в `verify_all.sh` как сьют `tasksn8n` (`BASELINE tasksn8n=20`).
- `scripts/n8n_compare.php` — сверка РЕАЛЬНОГО n8n с PHP-эталоном (не в gate: нужна сеть). `scripts/n8n_e2e_live.php` — сквозной прогон через настоящий `php -S` + реальный n8n.
- Побочная правка: в `api/tasks_test.php`, `api/tasks_n8n_test.php`, `scripts/n8n_e2e_live.php` запуск `php -S` через `exec php -S …` —
  иначе `proc_terminate` убивал только обёртку `sh`, а `php -S` оставались осиротевшими процессами (на хосте с 4 ГБ RAM копились).

## Фактические вызовы (секрет заменён на `***`)

```
REQ  POST https://n8n.domenforjob.ru/webhook/tasks-validate   (X-Tasks-Secret: ***)
{"employee_ids":["e_demo"],"from":"2027-03-10","to":"2027-03-12","facts":{"e_demo":[
  {"date":"2027-03-10","matrix_status":"sick","day_type":"workday","is_day_off":false,"holiday_label":null,"trip":null},
  {"date":"2027-03-11","matrix_status":"sick",...},{"date":"2027-03-12","matrix_status":"sick",...}]}}
RESP 200 (0.385 s)
{"blocked_days":[{"date":"2027-03-10","employee_id":"e_demo","reason":"sick"},{"date":"2027-03-11",...},{"date":"2027-03-12",...}],"notes":[],"suggested_start":"2027-03-13"}

REQ  тот же без заголовка / с неверным секретом → RESP 403 "Authorization data is wrong!"

REQ  POST …/webhook/tasks-recheck (X-Tasks-Secret: ***)
{"tasks":[{"id":"t1","employee_ids":["e_demo"],"from":"2027-03-10","to":"2027-03-12"},{"id":"t2",…,"from":"2027-03-15","to":"2027-03-16"}],"facts":{"e_demo":[{"date":"2027-03-11","matrix_status":"sick",…}]}}
RESP 200
{"results":[{"id":"t1","conflict":true,"blocked_days":[{"date":"2027-03-11","employee_id":"e_demo","reason":"sick"}]},{"id":"t2","conflict":false,"blocked_days":[]}]}
```

Сквозной прогон (`php scripts/n8n_e2e_live.php`, приложение → реальный n8n):

```
PASS login — HTTP 200
PASS E1 POST, реальный n8n отвечает — HTTP 201, check_state=ok, 832 мс
PASS E2 POST на sick (вердикт n8n) → 422 — blocked=[{"date":"2027-09-14","employee_id":"live_a","reason":"sick"}], suggested_start=2027-09-15, 437 мс
PASS E2b divergence-лог n8n/php пуст — нет расхождений в error_log сервера
PASS E3 AC-8: webhook недоступен (404) → 201 + pending — HTTP 201, check_state=pending, 395 мс
PASS E4 GET списка не ждёт n8n; conflict по новому больничному — HTTP 200, conflict=true, GET 16 мс
PASS E5 реальный tasks-recheck: pending → ok, audit task.recheck — audit={"check_state":"ok","conflict":true,"blocked_days_count":1}
E2E LIVE: ALL PASSED
```

## Таблица сверки n8n vs PHP-эталон (`php scripts/n8n_compare.php`, реальные вызовы)

tasks-validate: PHP-эталон vs n8n (blocked/notes/suggested_start; значения = число блок-дней / число notes / suggested_start)

| Кейс | Исполнители | Период | PHP | n8n | Время | Итог |
|---|---|---|---|---|---|---|
| V01 выходной (Сб-Вс) — допустимо | 1 исп. | 2027-06-05..2027-06-06 | 0/2/— | 0/2/— | 432 мс | совпало |
| V02 праздничные дни (1-3 мая) — допустимо | 1 исп. | 2027-05-01..2027-05-03 | 0/3/— | 0/3/— | 421 мс | совпало |
| V03 отпуск внутри периода — notes, допустимо | 1 исп. | 2027-05-03..2027-05-07 | 0/6/— | 0/6/— | 402 мс | совпало |
| V04 day_off — notes, допустимо | 1 исп. | 2027-03-24..2027-03-26 | 0/1/— | 0/1/— | 4320 мс | совпало |
| V05 sick — блок целиком | 1 исп. | 2027-03-10..2027-03-12 | 3/0/2027-03-13 | 3/0/2027-03-13 | 386 мс | совпало |
| V06 trip (из trips) — блок | 1 исп. | 2027-03-12..2027-03-12 | 1/0/2027-03-17 | 1/0/2027-03-17 | 392 мс | совпало |
| V07 частичное пересечение (хвост sick) | 1 исп. | 2027-03-08..2027-03-11 | 2/1/2027-03-13 | 2/1/2027-03-13 | 385 мс | совпало |
| V08 частичное пересечение (начало sick) | 1 исп. | 2027-03-12..2027-03-18 | 1/2/2027-03-13 | 1/2/2027-03-13 | 509 мс | совпало |
| V09 trip+sick подряд — suggested_start за обоими | 1 исп. | 2027-03-10..2027-03-13 | 3/1/2027-03-17 | 3/1/2027-03-17 | 493 мс | совпало |
| V10 несколько исполнителей: sick+trip | 2 исп. | 2027-03-09..2027-03-14 | 7/2/2027-03-17 | 7/2/2027-03-17 | 413 мс | совпало |
| V11 4 исполнителя, период со всем сразу | 4 исп. | 2027-03-08..2027-03-26 | 9/9/2027-03-17 | 9/9/2027-03-17 | 570 мс | совпало |
| V12 suggested_start в «хвосте» за to | 1 исп. | 2027-06-01..2027-06-02 | 1/0/2027-06-05 | 1/0/2027-06-05 | 371 мс | совпало |
| V13 sick 06-01, ok 06-02, sick 06-03, trip 06-04 | 1 исп. | 2027-06-01..2027-06-04 | 3/0/2027-06-05 | 3/0/2027-06-05 | 389 мс | совпало |
| V14 день вне блоков — чисто | 2 исп. | 2027-08-02..2027-08-06 | 0/0/— | 0/0/— | 367 мс | совпало |
| V15 один день, на sick | 1 исп. | 2027-12-31..2027-12-31 | 1/0/2028-01-01 | 1/0/2028-01-01 | 512 мс | совпало |
| V16 максимальный период 366 дн. | 4 исп. | 2027-01-01..2028-01-01 | 13/131/2028-01-01 | 13/131/2028-01-01 | 762 мс | совпало |
| V17 дубли исполнителей | 1 исп. | 2027-03-10..2027-03-11 | 2/0/2027-03-13 | 2/0/2027-03-13 | 387 мс | совпало |
| V18 исполнитель без записей | 1 исп. | 2027-03-10..2027-03-12 | 0/0/— | 0/0/— | 388 мс | совпало |

tasks-recheck: пакет из 7 задач (conflict / число блок-дней)

| Задача | Исполнители | Период | PHP | n8n | Итог |
|---|---|---|---|---|---|
| t_ok_weekend | 1 исп. | 2027-06-05..2027-06-06 | ok/0 | ok/0 | совпало |
| t_sick | 1 исп. | 2027-03-08..2027-03-11 | conflict/2 | conflict/2 | совпало |
| t_trip | 1 исп. | 2027-03-14..2027-03-18 | conflict/3 | conflict/3 | совпало |
| t_multi | 3 исп. | 2027-03-01..2027-03-31 | conflict/9 | conflict/9 | совпало |
| t_vac | 1 исп. | 2027-05-03..2027-05-07 | ok/0 | ok/0 | совпало |
| t_clean | 2 исп. | 2027-08-02..2027-08-06 | ok/0 | ok/0 | совпало |
| t_tail | 1 исп. | 2027-12-31..2027-12-31 | conflict/1 | conflict/1 | совпало |

Негативные кейсы и защита webhook

| Кейс | Ответ | Итог |
|---|---|---|
| N01 без заголовка-секрета | HTTP 403 | ожидаемо |
| N02 неверный секрет | HTTP 403 | ожидаемо |
| N03 recheck без секрета | HTTP 403 | ожидаемо |
| N04 from > to (PHP: end_before_start) | HTTP 400 "date_range_invalid" | ожидаемо |
| N05 период 367 дн. (PHP: period_too_long) | HTTP 400 "period_too_long" | ожидаемо |
| N06 пустой employee_ids | HTTP 400 "employee_ids_invalid" | ожидаемо |
| N07 невалидная дата 2027-02-30 | HTTP 400 "invalid_from" | ожидаемо |
| N08 facts не объект | HTTP 400 "facts_invalid" | ожидаемо |
| N04/N05 PHP-эталон отвергает так же | error | ожидаемо |
| N09 recheck: плохая задача в пакете → error только по ней | HTTP 200 | ожидаемо |

Всего кейсов: validate 18, recheck 7, негативных 10. Макс. время ответа n8n: 4320 мс (лимит 3000). РАСХОЖДЕНИЙ: 0

**РАСХОЖДЕНИЙ: 0** (3 независимых прогона compare — 0 расхождений во всех).

## Время ответа (требование ≤ 3 с) — честная оценка

- Типичный ответ n8n: 0.37–0.8 с (30 подряд `curl` на validate: max 0.68 с; connect ≈ 0.14–0.27 с, TLS ≈ 0.3–0.5 с — удалённый сервер).
- **Наблюдались редкие выбросы ~3.9–4.3 с** на отдельных запросах (3 из ~140 вызовов за сессию: V04 в 1-м прогоне, V13 во 2-м, один recheck при параллельной нагрузке на хост).
  Причина не установлена (сеть/холодный старт Code-узла n8n на удалённом сервере). Это именно тот случай, который покрывает дизайн: приложение ждёт максимум 3 с,
  затем PHP-fallback + `check_state='pending'` + перепроверка (AC-8; тест H4/E3). Пользователь не получает ошибку, данные не теряются. Если выбросы важны — вынести n8n в одну
  сеть с прод-приложением (прод на Hostland — отдельный вопрос владельцу). Сам n8n-узел считает за единицы мс (код детерминированный, без внешних вызовов).

## Переменные окружения для prod (имена; значения у владельца)

`TASKS_VALIDATE_WEBHOOK_URL` (`https://n8n.domenforjob.ru/webhook/tasks-validate`), `TASKS_RECHECK_WEBHOOK_URL` (`…/webhook/tasks-recheck`), `TASKS_N8N_WEBHOOK_SECRET`.
Dev-значения — `~/.config/service-center-app/dev.env` (вне репо, `chmod 600`). Секрет в репозиторий/отчёт/лог не попадал (проверено поиском значения по дереву: 0 вхождений).
Пересоздание: `python3 scripts/n8n_deploy.py deploy` (идемпотентно; секрет не меняет, пока есть credential и dev.env). Ротация — удалить credential `tasks-webhook-secret` в n8n и `~/.config/service-center-app/n8n_state.json`, затем deploy.
Примечание: прод — HTTP (BL-02), поэтому в prod секрет уходит на n8n по HTTPS (n8n → https), а приложение сервисного токена n8n не отдаёт.

## Verify (Definition of Done)

`bash scripts/verify_all.sh` — итоговая таблица (на коммите-основании c34b429 + изменения T1-4):

```
SUITE    RES  PASSED EXPECT   TIME  NOTE
smoke    PASS     84     84
tasks    PASS     33     33
tasksn8n PASS     20     20
tasksui  PASS     63     63
tasksmx  PASS     70     70
e51      PASS     23     23
e52      PASS     41     41
hygiene  PASS     19     19
trips    PASS      7      7
syntax   PASS
phplint  PASS     33
pii      PASS
clean    PASS
GATE: PASS (12 suites)
```
(финальный прогон после всех правок — см. ниже/в PROGRESS.md.)

## Риски / открытые вопросы

- Выбросы латентности n8n (см. выше) → доля задач в `pending` до перепроверки; перепроверка раз в 15 мин при чтении списка.
- Логика правил продублирована (PHP ↔ `n8n/code/common.js`): при изменении `tasks_rules.php` обязательно менять JS и гонять `scripts/n8n_compare.php` (в комментарии шапки `tasks_rules.php` указано).
- Режим работы n8n для validate: вердикт n8n первичен; расхождение с PHP только логируется (`error_log` `n8n/php DIVERGENCE`) — решение по варианту B из ТЗ.
- Prod: перед «Деплой» владелец выставляет 3 переменные окружения; HTTPS у n8n уже есть.
- Контейнер/прод `curl` ext: при его отсутствии используется `file_get_contents` с тем же таймаутом (на Hostland не проверялось — деплоя не было).
