# T1-9 — D-4 таймауты n8n + D-5 сборка и инструкция выкладки (вариант A)

Исполнитель: sd_worker_04 (автор T1-4). Дата: 2026-11-10. Деплой/SSH/push/правка workflow n8n — не выполнялись.

## D-4. Таймауты n8n и лог аномалий (`api/tasks_rules.php`)

| Вызов | Когда | Таймаут | Константа |
|---|---|---|---|
| `tasks-validate` | синхронно при сохранении, пользователь ждёт | 3000 мс (без изменений) | `TASKS_N8N_TIMEOUT_MS` |
| `tasks-recheck` | после ответа пользователю (`tasks_send_json_then`) | 10000 мс | `TASKS_N8N_RECHECK_TIMEOUT_MS` (новая) |
| порог аномалии | — | 10000 мс | `TASKS_N8N_ANOMALY_MS` (новая) |

- `tasks_n8n_post(..., $timeoutMs, $workflow)` меряет длительность каждого вызова (поле `ms`) и вызывает `tasks_n8n_log_call()`.
- Лог (одна строка в `error_log`, без секрета и payload):
  - `tasks n8n ANOMALY workflow=tasks-recheck ms=10003 reason=timeout` — recheck упёрся в свой таймаут, либо любой вызов с `ms > 10000`;
  - `tasks n8n timeout workflow=tasks-validate ms=3003 limit_ms=3000` — таймаут validate: штатно (задача `pending`), НЕ аномалия, слова ANOMALY нет.
- `tasks_recheck_pending(PDO, $limit, $timeoutMs = TASKS_N8N_RECHECK_TIMEOUT_MS)` — таймаут параметром (для тестов); `tasks_external_validate` передаёт 3000 и `'tasks-validate'`.
- Побочно: в stream-fallback (нет curl) таймаут теперь тоже определяется как `reason=timeout` по затраченному времени.
- Поведение приложения не менялось: fallback на PHP + `pending`, троттлинг 15 мин — как в T1-4.

### Тесты (`api/tasks_n8n_test.php`, mock-webhook, без сети): 20 → 25
- N13 константы 3000 / 10000 / 10000 и дефолт параметра `timeoutMs` у `tasks_recheck_pending` = 10000 (отдельный assert).
- N14 validate с задержкой 4 с → `pending` за 3004 мс (≤ 3,5 с); лог «timeout» без ANOMALY и без секрета.
- N15 recheck с задержкой 4 с (таймаут 10 с) → успех, `pending → ok`, 4017 мс, в логе ни ANOMALY, ни timeout.
- N16 recheck, таймаут 1500 мс (параметр) при задержке 3 с → ровно одна строка `tasks n8n ANOMALY workflow=tasks-recheck ms=… reason=timeout`, задача остаётся `pending`, нет секрета/id задачи/дат.
- N17 юнит `tasks_n8n_log_call`: 10,5 с успех → ANOMALY; validate timeout → без ANOMALY; быстрые вызовы и пустой workflow → тишина.
- `BASELINE[tasksn8n]` 20 → 25 в `scripts/verify_all.sh` и в строке эталона `AGENTS.md`. Сьют вырос с ~14 с до ~26 с.

## D-5. `DEPLOY_HOSTLAND.md` (вариант A)
1. §2 шаг 3: `grep -vE '^api/(smoke_test|init_db|seed_positions|debug_token)\.php$|_test\.php$'` (раньше `api/tasks_test.php` и `api/tasks_n8n_test.php` попадали в пакет — подтверждено запуском старой команды).
2. §2 шаг 5: проверка запрещённого дополнена `_test\.php$` и `^n8n/`.
3. §4 шаг 3 (очистка прода): `rm -f api/*_test.php`.
4. §1 структура: список js актуализирован (`js/storage.js, js/trips.js, js/tasks.js, js/tasks_matrix.js`) + пояснение, что список автоматический (из `<script src>` index.html), текст — снимок на дату; в «НЕ кладём» добавлены `api/*_test.php`, `n8n/`.
5. Веб-проверки: §4 шаг 6 (+`/api/tasks_test.php`, `/api/tasks_n8n_test.php` → 403/404; чек-лист «8 путей»), §10 таблица и `chk` (+`/api/tasks.php` без сессии → 401, два теста → 403/404).
6. Новый §12 «n8n на проде»: `TASKS_VALIDATE_WEBHOOK_URL`, `TASKS_RECHECK_WEBHOOK_URL`, `TASKS_N8N_WEBHOOK_SECRET` НЕ задаются, правила работают на PHP; подключение n8n — отдельным решением владельца.

## Доказательство сборки (локально, в scratch; на хостинг ничего не отправлялось)
Шаги 1–5 раздела 2 извлечены из `DEPLOY_HOSTLAND.md` дословно (`awk` по блоку кода), заменены только пути `OUT` и `.lst` на scratch. Результат: exit 0, шаг 1 (`check_no_pii.sh`) и шаг 5 (проверка запрещённого) прошли.

`tar -tzf sc-hostland-deploy.tar.gz | sort` (39 записей):

```
api/.htaccess
api/audit_export.php
api/auth.php
api/change_password.php
api/db.php
api/employees.php
api/entries.php
api/export.php
api/groups.php
api/helpers.php
api/holidays.php
api/holidays_provider.php
api/import.php
api/load.php
api/login.php
api/logout.php
api/positions.php
api/reset.php
api/save.php
api/schema.sql
api/session.php
api/sync.php
api/tasks.php
api/tasks_rules.php
api/trip_relay.php
api/trips.php
api/upload.php
api/vacation_import.php
data/.htaccess
data/holidays/2026.json
data/holidays/2027.json
data/holidays/2028.json
images/.htaccess
index.html
js/storage.js
js/tasks.js
js/tasks_matrix.js
js/trips.js
upload.php
```

Проверки по списку (счётчики совпадений):

| Шаблон | Совпадений | Ожидание |
|---|---|---|
| `_test\.php$` | 0 | нет |
| `^n8n/` | 0 | нет |
| `^scripts/` | 0 | нет |
| `^reports/` | 0 | нет |
| `^data/app\.db$` | 0 | нет |
| `api/tasks.php`, `api/tasks_rules.php`, `js/tasks.js`, `js/tasks_matrix.js` | по 1 | есть |

Негативный контроль: проверка запрещённого на входе `api/foo_test.php`, `n8n/tasks-validate.json` срабатывает (2 попадания) — защита рабочая, а не вхолостую.

## Gate
`bash scripts/verify_all.sh` → `GATE: PASS (12 suites)` (2026-11-10, до коммита):

```
SUITE    RES  PASSED EXPECT   TIME  NOTE
smoke    PASS     84     84     3s
tasks    PASS     33     33     3s
tasksn8n PASS     25     25    26s
tasksui  PASS     63     63     5s
tasksmx  PASS     70     70     5s
e51      PASS     23     23     0s
e52      PASS     41     41     0s
hygiene  PASS     19     19     1s
trips    PASS      7      7     2s
syntax   PASS      -      -     1s
phplint  PASS     33      -     2s
pii      PASS      -      -     0s
clean    PASS
GATE: PASS (12 suites)
```

## Риски / примечания
- Реальный n8n не вызывался (mock). На проде n8n не подключён (вариант A), поэтому ANOMALY-лог на проде не появится, пока владелец не задаст `TASKS_*`.
- Рекомендую (не сделано, вне задачи): PHP `max_execution_time` на Hostland после `fastcgi_finish_request` — 10-секундный recheck укладывается (ожидание сети не считается как CPU-время), но реальную работу при подключении n8n стоит проверить.
- Роадмап не отмечался — нужно одобрение владельца.
