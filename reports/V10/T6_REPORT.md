# V10-T6 — API доски и чтения журнала (сьют `transportboard`)

Карточка `t_9ee15e9a`, ветка `v10-t6-board` (основа `89e3171`), коммит кода `aaad76d`. Класс 🟡. Без push и деплоя. Индексы кода не использовались: утверждения — по исходникам на текущем коммите и прогонам.

## 0. Решения там, где контракт молчит (прошу подтвердить)

1. **Период ≤ 31 дня — включительно** (`to − from + 1 ≤ 31`): `2032-03-01…03-31` → 200, `…04-01` → 422 `range_too_long` `{max_days:31}`; считается по календарю (високосный февраль — тест A7).
2. **`limit` журнала > 200 зажимается до 200** (в ответе фактический `limit`), а не 422; `limit < 1` / не число → 422 `invalid_limit`. По умолчанию 50. Для CSV предел — 20 000 строк (по умолчанию выгружается всё подходящее, `limit`/`offset` тоже работают).
3. **Очередь нераспределённых от периода не зависит** (у заявки нет дат): `status = new` и нет ни одного назначения; не более 500 (`queue_truncated`).
4. **Отсутствия показываются только тем, кто нужен доске**: допустимые водители (группа «Транспорт» ∪ пул) + водители и бригада назначений **этого периода**. Сотрудник вне доски (в т.ч. в командировке) не отдаётся — лишние персональные данные не уходят. Типы: `vacation`, `sick`, `day_off` (статусы `dayoff`/`day_off`), `trip` (confirmed; также статус `trip` в `schedule_entries`), `trip_forecast` (forecast). Статус `work` и прочие — не отсутствие. **Вопрос координатору:** T5 для предупреждений `driver_absent`/`crew_absent` может не учитывать `day_off`/`forecast` — тогда доска и предупреждения расходятся; тип отдаётся явно, UI волен подсвечивать только нужные.
5. **Порядок проверок в эндпоинтах:** аноним → 401, затем (журнал) не admin → 403, затем метод (не `GET` → 405). Т.е. viewer `POST` в журнал → 403, admin → 405.
6. `can_edit` посчитан пакетом в `transport_board.php` (`tb_can_edit_map`), а не вызовом `transport_can_edit_request` на каждую заявку: тот делает запрос `users` на каждую заявку делегированного автора (N+1 для `supervisor_zone0`). `transport_lib.php` не менялся (ни сигнатур, ни новых функций — конфликта с T5 нет). Эквивалентность правилу библиотеки проверяет тест K1 (35 пар «пользователь × автор», включая аноним, неизвестный и пустой автор).

## 1. Что сделано

| Файл | Суть |
|---|---|
| `api/transport_board.php` | `GET ?from=&to=`; `tb_parse_range` (:78), `tb_can_edit_map` (:111), `tb_build_board` (:215), `tb_absences` (:368); основной блок под `if (!defined('TRANSPORT_BOARD_LIB_ONLY'))` — тест подключает файл как библиотеку |
| `api/transport_journal.php` | `GET` только admin; фильтры, пагинация, `format=csv`; в основном блоке нет ни одной записи в БД |
| `api/transport_board_test.php` | сьют `transportboard`: 77 проверок |
| `scripts/verify_all.sh` | `BASELINE[transportboard]=77`, `ALL_SUITES` (после `transportdb`), `run_suite` — только эти строки |
| `reports/V10/T6_RED_run_before_impl.txt` | красный прогон до реализации: `0 passed, 77 failed` |

Не тронуты: `transport_lib.php`, `transport_vehicles.php`, `transport_requests/assignments/warnings.php`, схема, `js/`, `index.html`, `AGENTS.md`, `data/app.db` (`git status` чист, sha1 до/после — `DB intact: YES`). Правка `AGENTS.md` — патч-файлом `reports/V10/T6_AGENTS_patch.md`. `PROGRESS.md` не правил (общий файл параллельных веток T5/T7/T8) — обновит координатор при приёмке.

## 2. Формат ответа доски

`GET api/transport_board.php?from=2032-03-12&to=2032-03-13` (синтетика, фрагмент реального ответа теста; `supervisor_zone0`, `can_edit` для чужих заявок admin — `false`, для заявок `supervisor_zone1` — `true`):

```json
{
  "success": true, "from": "2032-03-12", "to": "2032-03-13",
  "can_move_vehicle": false,
  "bases": [
    { "id": "tb_…", "name": "Тест-База А", "sort_order": 1,
      "vehicles": [ { "id": "tv_…", "name": "Тест-ТС 2", "plate": "Т002ТТ86", "base_id": "tb_…", "status": "repair",
                      "default_driver_id": null, "sort_order": 2, "version": 2 } ] }
  ],
  "assignments": [
    { "id": "tbd_a2", "request_id": "tbd_r2", "vehicle_id": "tv_…", "base_id": "tb_…",
      "driver_id": "tbd_d2", "driver_name": "Водителев Второй",
      "crew": [ { "employee_id": "tbd_c1", "name": "Бригадов Один" } ],
      "stops": [ { "ord": 1, "kind": "intermediate", "place": "Тестпункт Средний", "lat": 60.5, "lon": 65.9,
                   "stay_min": 15, "leg_km": 12.5, "leg_min_map": 30, "leg_min": 30 } ],
      "start_at": "2032-03-12T22:00", "end_at": "2032-03-13T02:00", "duration_min": 240, "version": 4,
      "days": ["2032-03-12", "2032-03-13"],
      "request": { "id": "tbd_r2", "display_no": 9002, "title": "Заявка 2 (zone1)", "subscriber": "Абонент-tbd_r2",
                   "address": "Адрес-tbd_r2", "status": "assigned", "version": 3,
                   "created_by": "supervisor_zone1", "created_by_name": "supervisor_zone1", "can_edit": true } }
  ],
  "queue": [ { "id": "tbd_n1", "display_no": 9101, "title": "Очередь 1 (admin)", "subscriber": "…", "address": "…",
               "status": "new", "version": 3, "created_by": "admin", "created_by_name": "admin", "can_edit": false } ],
  "queue_truncated": false,
  "absences": [ { "employee_id": "tbd_d2", "date": "2032-03-12", "type": "sick" } ]
}
```

(`crew`/`stops` в примере сокращены до одного элемента; в реальном ответе у назначения `tbd_a2` они пусты — пример показывает форму элементов, проверенную тестом B5.)

- `base_id` назначения — **текущая** база ТС (после `action=move` доска показывает ТС в новой базе, назначения прошлых дат остаются на том же ТС — тест H1). `days` — дни периода, которые занимает полуинтервал `[start_at, end_at)`: через полночь — оба дня (C1), конец ровно в 00:00 следующего дня этот день не занимает (C2), начало ровно в 00:00 — занимает (C3).
- В ответе нет: телефонов, фото, комментариев заявок/отпусков/командировок, целей и мест командировок (F4 ищет «секретные» маркеры в сыром теле ответа).

### Журнал `GET api/transport_journal.php`

`{ success, total, limit, offset, items:[{ id, ts, actor, role, action, entity_type, entity_id, before, after, warnings }] }`, новые сверху (`id DESC`), `before/after/warnings` — разобранный JSON. Фильтры `from`, `to` (дни по `ts`, обе границы включительно), `entity_type`, `entity_id`, `actor`, `action` — точное равенство, через параметры (без `LIKE`). `format=csv` — UTF-8 с BOM, `;`, CRLF (как `api/audit_export.php`), ячейки с `= + - @` (и TAB/CR) в начале получают префикс `'`, значения с `; " \r \n` — в кавычках по RFC 4180.

## 3. Как устроен одиночный запрос доски (без N+1)

Число SQL-выполнений не зависит от числа назначений. `tb_build_board` делает **11 запросов** (admin/viewer; у `supervisor_zone0` — 12: +1 `users` для делегирования, один на весь ответ):

1. базы; 2. ТС; 3. назначения `JOIN transport_requests` по окну `start_at < конец_периода AND end_at > начало_периода`; 4. бригада (`JOIN` тем же окном); 5. остановки (то же); 6. очередь (`NOT EXISTS` назначения, `LIMIT 501`); 7–9. `transport_allowed_drivers` (группы, сотрудники группы, пул); 10. `schedule_entries`; 11. `trips ⨝ trip_participants`. Плюс `users` — только у `supervisor_zone0` при наличии чужих авторов.

Дальше всё собирается в PHP из массивов, индексированных по id (бригада и остановки — по `assignment_id`). Окно назначений в запросах 4–5 повторяет окно запроса 3, поэтому подзапрос по «ID назначений» не нужен. Отсутствия ограничены в SQL подзапросами по назначениям окна и списком допустимых водителей (при > 500 водителей список не используется, фильтр остаётся на стороне PHP).

**Проверка (K3):** в тесте подключено второе PDO-соединение со счётчиком (`CountingPDO` + `CountingStmt::execute`: считаются выполнения, а не `prepare`). 7 назначений → 11/12/11 запросов (admin / zone0 / viewer); после добавления 60 назначений (бригада из 3, остановки, заявки трёх авторов, отсутствие) → те же 11/12/11 при 67 назначениях; предел «≤ 16» — тоже проверяется. По БД индексы `idx_transport_assignments_*`, `idx_transport_requests_status` из схемы v15 уже есть; новых индексов и схемы не потребовалось.

## 4. Проверено

`bash scripts/verify_all.sh transportboard` → `RESULTS: 77 passed, 0 failed`, `DB intact: YES`. Что покрыто (77 проверок):

| Блок | Проверок | Суть |
|---|---|---|
| A | 13 | аноним 401; 200 для admin / zone0 / zone1 / viewer; `can_move_vehicle` (admin и viewer — `true`, supervisor — `false`); только GET (405; аноним POST → 401); некорректные параметры (11 вариантов, SQL-инъекция, массив) → 422; `invalid_range`; 31/32 дня, високосный февраль |
| B | 7 | базы по `sort_order` с ТС; точный набор назначений периода (7); сортировка; поля назначения, остановки (null сохраняются), карточка заявки; чужие заявки видны всем |
| C | 7 | через полночь — оба дня; граница «конец ровно 00:00»; «начало ровно 00:00»; последний квант периода; начато до периода; многодневное; пустой период |
| D | 4 | очередь: `new` без назначений (`new` с назначением, `assigned`/`done`/`cancelled` без назначений не попадают); не зависит от периода; поля; уходит и возвращается при появлении/удалении назначения |
| E | 4 | `can_edit` для admin / zone0 / zone1 / viewer по 9–10 заявкам каждый |
| F | 4 | отсутствия: точный набор (отпуск, болезнь, отгул, командировка, прогноз, свободный водитель из пула); чужие/вне периода/«work» не попадают; дубли и порядок; приватность |
| G | 1 | чтение доски не меняет БД и журнал |
| H | 3 | перенос ТС (viewer) виден на доске у admin/zone0/viewer, `version`+1; обратный перенос; ремонт ТС и новая пустая база |
| K | 5 | `tb_can_edit_map` ≡ `transport_can_edit_request` (35 пар); `tb_build_board` ≡ HTTP; **счётчик SQL**; детерминизм; журнал не растёт от чтения доски |
| J, L | 5 + 10 | журнал: аноним 401, не-admin 403 (JSON и CSV), только GET; формат; порядок; все фильтры по отдельности и в сочетании; безопасность значений (`%`, `_`, кавычки, `DROP TABLE`); 422 на неверные параметры |
| M | 3 | пагинация: 205 записей страницами по 2 — без дублей и пропусков; `limit` по умолчанию 50 / 200 / зажим 500→200; offset за концом |
| N | 7 | CSV: заголовки, BOM, `;`, `attachment`, `no-store`; префикс `'` для `= + - @ TAB CR`; ни одна ячейка всего журнала не начинается с формулы; кавычки/`;`/переводы строк; фильтры и > 200 строк; `limit`/`offset`; JSON без CSV-префикса |
| P | 4 | события T1 (`base.create`, `vehicle.move` — viewer и admin) читаются; чтение журнала не меняет БД; append-only триггеры в силе; тело 403 — только `{error}` |

Фикстуры: базы/ТС/пул/перенос — API T1; заявки, назначения, бригада, остановки, отсутствия, строки журнала — прямые INSERT в копию БД (`SC_APP_DB`); все данные синтетические (`check_no_pii.sh` → OK).

Красный прогон: `reports/V10/T6_RED_run_before_impl.txt` (`0 passed, 77 failed`; снят с тестами до правок A5/F2 — в них поправлены кодирование URL и ожидание окна отсутствий, остальное идентично).

### GATE (прогон `bash scripts/verify_all.sh` на `aaad76d`, 2026-11-21 14:07, код выхода 0)

```
SUITE    RES  PASSED EXPECT   TIME  NOTE
smoke    PASS     84     84     4s  
tasks    PASS     66     66     7s  
tasksn8n PASS     27     27    27s  
tasksatt PASS     24     24     9s  
tasklinks PASS     37     37    13s  
transportdb PASS    117    117     7s  
transportboard PASS     77     77     5s  
tasksui  PASS    334    334    36s  
tasksmx  PASS     79     79     8s  
taskscal PASS    220    220     6s  
director PASS    101    101    20s  
emptasks PASS     34     34     4s  
tasklinksui PASS    211    211   125s  
e51      PASS     23     23     0s  
e52      PASS     41     41     0s  
hygiene  PASS     19     19     0s  
trips    PASS      7      7     3s  
tripsform PASS    131    131    64s  
tripsstatus PASS    147    147    80s  
syntax   PASS      -      -     0s  
phplint  PASS     45      -     4s  
pii      PASS      -      -     1s  
refs     PASS     28     28    28s  удалено 0, со ссылками 0, исключений 0
tasklink PASS     43     43     8s  коммитов 1, с кодом 1, нарушений 0
clean    PASS

GATE: PASS (24 suites)
```

**История прогонов (честно):** первый полный прогон на том же коммите дал `GATE: FAIL (2)` — только браузерные `tripsform` (128/131) и `tripsstatus` (138/147), остальные 22 сьюта зелёные. Причина — нагрузка: параллельно на хосте шли `verify_all.sh` соседних воркеров (T5/T7/T8, load average ≈ 4); падения плавающие (в трёх повторах `tripsform`: 128, 112, 119 из 131 — и затем 131/131; `tripsstatus`: 138, затем 147/147). На чистой копии основы `89e3171` (`git archive`) `tripsform` дал 131/131. Код `transport_*` эти сьюты не затрагивает (`js/`, `index.html`, `api/trips.php` не менялись). Отдельный перезапуск `bash scripts/verify_all.sh tripsform tripsstatus` → `PASS 131/131`, `PASS 147/147`; повторный полный прогон → `GATE: PASS (24 suites)` (таблица выше). Рекомендация координатору: не запускать браузерные сьюты параллельно в нескольких ветках.

Прочее: `php -l` (`transport_board.php`, `transport_journal.php`, `transport_board_test.php`) — без ошибок; `node scripts/check_syntax.js` → `failed: 0`; `bash scripts/check_no_pii.sh` → `OK`; `git status --porcelain` пуст, `data/app.db` не изменён.

## 5. Риски и открытые вопросы

1. Типы отсутствий и правило «только нужные доске сотрудники» (п. 4 раздела 0) — подтвердить у координатора, особенно согласованность с T5 (`driver_absent`/`crew_absent`: учитывает ли T5 `day_off` и прогнозные командировки).
2. `limit > 200` зажимается, а не отвергается (п. 2) — если нужен 422, меняется одна строка в `transport_journal.php`.
3. Очередь без периода (до 500 заявок): при росте числа `new` без назначений доске понадобится фильтр/пагинация очереди — сейчас `queue_truncated` лишь сигнализирует.
4. `can_edit` дублирует правило `transport_can_edit_request` (по соображениям N+1). При изменении правила в библиотеке (`TRANSPORT_EDIT_DELEGATION` — карта, общая) тест K1 упадёт — расхождение не останется незамеченным.
5. Доска читает `schedule_entries` без учёта `approval_status` (черновик отпуска тоже подсвечивается) — как и матрица отпусков.

## 6. Что нужно координатору

Применить `reports/V10/T6_AGENTS_patch.md` (строка сьюта и `BASELINE`); при приёмке — обновить `PROGRESS.md`; после T5 — свести тесты предупреждений об отсутствии с типами доски (п. 5.1).
