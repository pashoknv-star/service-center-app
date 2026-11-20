# V10 — Контракт API модуля «Транспорт» (закреплён координатором)

Контракт — общая точка T1 (реализует часть «справочники/перенос/журнал»), T2 (пишет по нему тесты, в т.ч. под будущий T5) и T5 (фаза V10-B, реализует «заявки/назначения»). Менять контракт может только координатор (addendum). Расхождение, которое мешает написать тест или код, — `kanban block` с вопросом, а не самостоятельная правка. Формат ответов — как `api/tasks.php`: успех `{"success":true,…}`, ошибка `{"error":"<код>", …}` (`sendJson`/`tasks_fail`); конфликт версий — 409 `VERSION_CONFLICT` с актуальной записью и `current_version` (образец `api/tasks.php` `tasks_version_conflict`).

## Общее

- Сессия по cookie, как у остальных эндпоинтов. Аноним → 401 `unauthorized`. Роль — `user_role()`; в dev-БД учётки: `admin`, `supervisor_zone0`, `supervisor_zone1`, `viewer_test` (пароль dev — `changeme`).
- Статусы ошибок: 401 `unauthorized`; 403 `forbidden`; 404 `not_found`; 409 `VERSION_CONFLICT`; 422 — ошибка проверки с кодом из списка ниже; 405 — метод не поддержан.
- Идентификаторы — строки (`genId('tv_')`, `'tb_'`, `'tr_'`, `'ta_'`); `employee_id` — `employees.id` (TEXT).
- Время: `start_at` — строка `YYYY-MM-DDTHH:MM` (локальное +05), минуты кратны 15; `duration_min` — целое > 0, кратное 15, ≤ 7 суток (10080); `end_at` вычисляется сервером. Нарушение → 422 `invalid_start` / `invalid_duration`. Для остановок `stay_min` и `leg_min` — целые ≥ 0, кратные 15, иначе 422 `invalid_step`.
- Все мутации модуля пишут запись в `transport_journal` **в той же транзакции** (см. ниже).

## Часть 1 — T1: справочники, перенос, журнал

### `api/transport_vehicles.php`

| Метод и параметры | Кто | Тело / ответ |
|---|---|---|
| `GET` | любой авторизованный | `{success, bases:[{id,name,sort_order}], vehicles:[{id,name,plate,base_id,status,default_driver_id,sort_order,version}], drivers:[{employee_id,name,source:"group"\|"pool"}]}`. `drivers` = сотрудники группы с названием «Транспорт» ∪ `transport_driver_pool`; в элементе только `employee_id`, `name`, `source` (телефон/фото не отдавать). Дубликаты схлопываются (приоритет `group`). |
| `POST ?entity=base` | admin | `{name, sort_order?}` → 201 `{success, base}`. Имя уникально без учёта регистра (422 `duplicate_name`). |
| `PUT ?entity=base&id=` | admin | `{name?, sort_order?}` |
| `POST ?entity=vehicle` | admin | `{name, plate, base_id, status?("in_service"\|"repair", по умолчанию in_service), default_driver_id?, sort_order?}` → 201. `plate` уникален (422 `duplicate_plate`); `base_id` должен существовать (422 `unknown_base`); `default_driver_id` — допустимый водитель (422 `driver_not_allowed`). |
| `PUT ?entity=vehicle&id=` | admin | поля как при создании, + `version` (обязательна, иначе 422 `version_required`); смена `base_id` через этот путь **запрещена** (422 `use_move`) — база меняется только действием `move`. |
| `POST ?entity=pool` | admin | `{employee_id}` — добавить совместителя в пул (422 `unknown_employee`, `already_in_pool`). |
| `DELETE ?entity=pool&id=<employee_id>` | admin | убрать из пула; если сотрудник стоит `default_driver_id` у ТС — 409 `driver_in_use`. |
| `POST ?action=move&id=<vehicle_id>` | **admin или viewer** | `{base_id, version}` → `{success, vehicle}`. Меняет `vehicles.base_id` навсегда, увеличивает `version`, пишет журнал `vehicle.move` (before/after = `{base_id}`). Тот же `base_id` → 422 `same_base`; неизвестная база → 422 `unknown_base`; устаревшая версия → 409. **supervisor → 403.** На уже созданные назначения не влияет. |

Любая другая запись для viewer и supervisor → 403.

### `api/transport_lib.php` (внутренняя библиотека, не HTTP)

- `transport_role(): string`, `transport_user_id(): string`, `transport_can_move_vehicle(): bool` (admin или viewer), `transport_can_edit_request(array $request): bool` (admin — любая; supervisor — свои (`created_by == transport_user_id()`) плюс заявки пользователей из карты делегирования `TRANSPORT_EDIT_DELEGATION` (константа в `transport_lib.php`: `supervisor_zone0` → `['supervisor_zone1']`, по логину; прочих записей нет); viewer — никогда). Карту сопровождает admin через код/addendum, UI для неё не делается.
- `transport_allowed_drivers(PDO $pdo): array` — единый источник допустимых водителей (группа «Транспорт» ∪ пул); группа ищется по названию «Транспорт» (не по id `g6`).
- `transport_journal_write(PDO $pdo, string $action, string $entityType, string $entityId, ?array $before, ?array $after, ?array $warnings = null): void` — вставка в `transport_journal`, вызывается внутри транзакции вызывающего.
- `transport_now_local(): string`, нормализация/проверка шага 15 (`transport_check_step(int $min): bool`) — для T5.

## Схема v15 (T1)

`transport_bases`, `vehicles` (`vehicles.base_id` → `transport_bases.id`), `transport_driver_pool`, `transport_requests`, `transport_assignments`, `assignment_crew`, `assignment_stops`, `geo_cache`, `transport_journal` — поля по `reports/V10/PLAN.md` §3. Имена таблиц и ключевых колонок T1 не меняет без addendum. Все таблицы создаются в v15 сразу (T5 новых таблиц не добавляет).

- `transport_journal(id INTEGER PK AUTOINCREMENT, ts TEXT, actor TEXT, role TEXT, action TEXT, entity_type TEXT, entity_id TEXT, before_json TEXT, after_json TEXT, warnings_json TEXT)`; индексы по `ts` и `(entity_type, entity_id)`; триггеры `BEFORE UPDATE` и `BEFORE DELETE` → `RAISE(ABORT, 'transport_journal is append-only')`. `audit_cleanup` и прочая очистка её не затрагивают.
- Таблицы для заявок/назначений создаются в v15, но API к ним — задача T5 (фаза B).

## Часть 2 — для T2 (тесты) и T5 (реализация, фаза B)

### `api/transport_requests.php`

| Метод | Кто | Описание |
|---|---|---|
| `GET` (`?id=`; список: `?from=YYYY-MM-DD&to=YYYY-MM-DD&status=`) | все авторизованные | Заявка: `{id, display_no, title, subscriber, address, comment, status, source, external_id, created_by, created_by_name, version, assignments:[…], can_edit:bool}`. `can_edit` вычисляется сервером для текущего пользователя (admin — всегда true; supervisor — свой автор; viewer — false). Чужие заявки читаются всеми. |
| `POST` | admin, supervisor | `{title, subscriber?, address?, comment?, source?}` → 201. `created_by` = текущий пользователь. Viewer → 403. Статус `new`. |
| `PUT ?id=` | admin — любые; supervisor — только свои | поля заявки + `version`. Чужая заявка у supervisor → 403 `forbidden`. |
| `PUT ?id=&action=status` | как `PUT` | `{status, version}`; допустимо `new→assigned` только автоматически при появлении назначения; руками: `in_progress`, `done`, `cancelled`, возврат `cancelled/done→new` — по таблице переходов (T5 фиксирует в отчёте; T2 тестирует: недопустимый переход → 422 `invalid_transition`). |
| `DELETE ?id=` | не поддержан (отмена — статусом `cancelled`) | 405 |

### `api/transport_assignments.php`

| Метод | Кто | Описание |
|---|---|---|
| `POST` | как редактирование родительской заявки | `{request_id, vehicle_id, driver_id, crew:[employee_id…], start_at, duration_min, stops:[{ord,kind("departure"\|"intermediate"\|"arrival"),place,lat?,lon?,stay_min,leg_km?,leg_min_map?,leg_min}], dry_run?:bool, confirm_token?:string}`. `dry_run:true` ничего не пишет и возвращает `{success, warnings:[{code,severity,message,…}], confirm_token}`. Без `dry_run`: при непустых предупреждениях запись возможна только с валидным `confirm_token`, выданным для **этого набора предупреждений**; иначе 409 `confirmation_required` с актуальными предупреждениями. Успех → 201 `{success, assignment}`; заявка `new` автоматически → `assigned`. |
| `PUT ?id=` | как выше | то же + `version`; пересчёт `end_at`. |
| `DELETE ?id=` | как выше | удаляет назначение; у заявки не осталось назначений → статус `new`. |

Валидация (422): `driver_not_allowed` (водитель не из `transport_allowed_drivers`), `driver_in_crew` (водитель в бригаде), `unknown_vehicle`, `unknown_employee`, `invalid_start`, `invalid_duration`, `invalid_step`, `request_closed` (назначение на `done/cancelled`).

Коды предупреждений (не блокируют, подтверждаются `confirm_token`): `vehicle_overlap`, `driver_overlap`, `crew_overlap` (пересечение интервалов `[start_at, end_at)` с другими назначениями; граничное касание — не пересечение), `driver_absent`, `crew_absent` (отпуск/болезнь/командировка по `schedule_entries`/`trips` — точные коды статусов T5 берёт из исходников), `vehicle_in_repair`, `route_sum_mismatch` (сумма `stay_min`+`leg_min` маршрута ≠ `duration_min`). `severity`: `warning`. Проверка пересечений и запись — в одной транзакции (`BEGIN IMMEDIATE`).

### `api/transport_board.php` и `api/transport_journal.php` — фаза B (T6)

- `GET api/transport_board.php?from=&to=` — ТС по базам + назначения + отсутствия за период; доступно всем ролям.
- `GET api/transport_journal.php?…` — только admin; остальные 403. Тут ничего не пишется.

## Права — сводная таблица для тестов

| Действие | admin | supervisor_zone0 | supervisor_zone1 | viewer_test | аноним |
|---|---|---|---|---|---|
| Читать справочники, доску, любые заявки | ✅ | ✅ | ✅ | ✅ | 401 |
| Создать заявку | ✅ | ✅ | ✅ | 403 | 401 |
| PUT/статус/назначения своей заявки | ✅ | ✅ | ✅ | 403 | 401 |
| То же для заявки, созданной другим пользователем | ✅ | 403, **кроме** заявок `supervisor_zone1` (их `supervisor_zone0` править может) | 403 | 403 | 401 |
| Справочник ТС/баз/пула (POST/PUT/DELETE) | ✅ | 403 | 403 | 403 | 401 |
| `action=move` | ✅ | 403 | 403 | **✅** | 401 |
| Журнал (чтение) | ✅ | 403 | 403 | 403 | 401 |

Примечание: правило для `supervisor_zone0` («заявки созданные им и Supervisor_zone1») принято **буквально** по сообщению владельца; `supervisor_zone1` правит только свои. Обратного права нет. Заявки других пользователей (admin и др.) для супервайзеров — чужие. Если владелец имел в виду иное, меняется одна карта `TRANSPORT_EDIT_DELEGATION`.
