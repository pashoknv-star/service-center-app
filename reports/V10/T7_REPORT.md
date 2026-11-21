# V10-T7 — Транспорт: геопрокси `api/transport_geo.php` и Leaflet локально (фаза B)

Ветка `v10-t7-geo`, worktree `/home/hermes/wt/v10-t7`, Kanban `t_6cef1438`. Не пушил, не деплоил, `AGENTS.md`/`DEPLOY_HOSTLAND.md` не правил (патч — `T7_AGENTS_patch.md`), `data/app.db` не тронут (sha1 до/после в сьюте: `DB intact: YES`; `git status` чист).

## 1. Итог

- Готов `api/transport_geo.php` — единственная точка исходящих запросов модуля: поиск населённого пункта, обратный геокод, маршрут. Основной набор — Nominatim + OSRM `routing.openstreetmap.de`; запасные — Photon, ORS (ключ только из конфига вне git), Valhalla; переключение конфигом.
- Округление времени пути вверх до 15 мин (положительное < 15 → 15): PHP `transport_geo_leg_min_map()` и JS `js/transport_geo_round.js` дают одинаковые результаты на общем наборе 40 значений (`scripts/transport_geo_round_cases.json`).
- Leaflet 1.9.4 локально в `js/vendor/leaflet/` (версия, лицензия, источник, SHA-256 — в `README.md`); к `index.html` не подключён.
- Сьют `transportgeo`: **430 проверок** (≥ 90 по заданию), красный до реализации (`T7_RED_run_before_impl.txt`: 80 «зелёных» тривиально из-за отрицательных утверждений при нуле запросов, 324 красных), зелёный после (`T7_GREEN_transportgeo.txt`); входит в `ALL_SUITES`, `BASELINE[transportgeo]=430`.
- Полный `bash scripts/verify_all.sh` → `GATE: PASS (24 suites)` (раздел 8).
- Коммиты: `abee7b5` (реализация, сьют 429), `4a175a4` (сьют 430) + коммит документов (этот отчёт и доказательства).

## 2. Что сделано (file:line — файл на коммите `4a175a4`, прочитан после правок)

| Что | Где |
|---|---|
| Геопрокси: обработчик `transport_geo_main()` (`handleOptions` → `migrate` → `require_edit()` → `session_write_close()` → метод POST → действие → белый список входа → кэш → пользовательский лимит → цепочка провайдеров → кэш → ответ) | `api/transport_geo.php:782` (`require_edit()` — `:790`, `session_write_close()` — `:794`) |
| Конфиг: умолчания и допустимые ключи / загрузка и проверка значений | `api/transport_geo.php:80` / `:109` (`opcache_invalidate` на файле конфига — правки подхватываются сразу) |
| User-Agent, заглушка `OWNER_EMAIL_TO_BE_SET`, одно предупреждение (метка `meta:email_warned` в `geo_cache`) | `:177` |
| Белые списки входа: название `transport_geo_place_name()`, координата `transport_geo_coord()` | `:206`, `:238` |
| Округление | `:263`; JS — `js/transport_geo_round.js` |
| Шаблоны исходящих запросов (все 6 вызовов §6.1 SPIKE_MAP, значения только из валидаторов) | `:287` |
| Исходящий GET: без cookie/Referer/редиректов, http/https, таймаут, потолок 256 КБ | `:336` (`CURLOPT_FOLLOWLOCATION=false` — `:348`, `CURLPROTO_HTTP\|HTTPS` — `:354`) |
| Белые списки выхода: поиск / обратный геокод / маршрут | `:421`, `:480`, `:505` |
| Кэш, лимит частоты к сервису, пользовательский лимит, circuit-breaker | `:557`–`:640` |
| Цепочка провайдеров, деградация | `:685` |
| Сьют, фейк внешнего сервиса, набор значений округления | `api/transport_geo_test.php`, `scripts/transport_geo_fake_upstream.php`, `scripts/transport_geo_round_cases.json` |
| `verify_all.sh`: `BASELINE`, `ALL_SUITES`, `run_suite` | `scripts/verify_all.sh:19-20`, `:58-59` (только эти строки) |
| `.gitignore`: `data/transport_geo.config.php` (SPIKE_MAP R9) | `.gitignore` (последние строки) |

Вне границ задачи тронуты только `.gitignore` (строка из SPIKE_MAP R9 — требование задачи «ключей и e-mail в git нет») и фейк/JSON в `scripts/` (тестовая инфраструктура сьюта). `api/transport_lib.php` не менялся: используются его `transport_handle()`, `transport_fail()`, `transport_tx()`, `transport_read_body()`.

### Контракт для T8/T10

`POST api/transport_geo.php?action=search|reverse|route`, `Content-Type: application/json` (cookie-сессия, `SameSite=Lax`, как остальные эндпоинты):

| Действие | Тело | Ответ 200 |
|---|---|---|
| `search` | `{q}` — название населённого пункта | `{success:true, degraded:false, cached, items:[{name, lat, lon (5 знаков), kind, county, state}]}`; ХМАО — первыми; не найдено — `items:[]` |
| `reverse` | `{lat, lon}` | `{success:true, degraded:false, cached, place:{name, level, county, state}}`; «в поле» — `name:null, level:null` (остаётся `county`) |
| `route` | `{lat1, lon1, lat2, lon2}` | `{success:true, degraded:false, cached, route:{km, sec, min_map}}`; `min_map` — минуты, кратные 15 (0 — точки совпали) |
| любое | — | деградация: `{success:true, degraded:true, reason}` (HTTP 200): `timeout`, `connect_error`, `too_large`, `invalid_json`, `bad_response`, `http_<код>`, `rate_limited`, `circuit_open`, `no_route`, `storage_error`, `no_provider` |

Ошибки запроса (наружу ничего не уходит): 401 `unauthorized`; 403 `forbidden` (viewer); 405 `method_not_allowed` (только POST); 400 `invalid_action` / `invalid_json`; 422 `bad_place_name` / `bad_coords`; 500 `server_error`. Доступ: admin и supervisor (`require_edit()`).

Для UI (T10): (а) поиск **только по Enter/кнопке** — автодополнение запрещено политикой Nominatim; (б) `rate_limited` — штатный ответ при двух поисках в одну секунду от разных пользователей (глобальный лимит ≥ 1,1 с к сервису): прокси не ждёт, а отказывает, поэтому UI должен показать «повторите через секунду» или один раз повторить сам; (в) `degraded` — скрыть «Подставить» и показать «Нет связи с картой — введите значения вручную»; (г) подстановка `min_map` в `leg_min` — только кнопкой, `duration_min` не трогать.

## 3. Что реально уходит наружу

Метод везде **GET**, тела нет. Заголовки: `User-Agent: ServiceCenterApp-Transport/0.1 (internal staff-scheduling tool; contact: <e-mail из конфига | OWNER_EMAIL_TO_BE_SET>)`, `Accept: application/json`; дополнительно только для ORS — `Authorization: <ключ приложения>`, для Valhalla — `X-Client-Id: ServiceCenterApp-Transport`. **Не уходят:** Cookie, Referer, Origin, X-Forwarded-For/X-Real-IP, любые заголовки клиента, адрес/заголовок/абонент/телефон заявки. IP источника — сервер приложения, а не пользователь.

| # | Вызов | URL и параметры дословно (в тесте проверяются ключи и значения) | Содержимое |
|---|---|---|---|
| 1 | Поиск, Nominatim (основной) | `GET <nominatim_url>/search?format=jsonv2&q=<НАЗВАНИЕ>&countrycodes=ru&limit=5&accept-language=ru&addressdetails=1&viewbox=59.0,65.8,86.0,58.0` | `q` — название, прошедшее белый список (буквы/пробел/дефис/точка, ≤ 3 слов, без цифр, запятых, адресных слов, инициалов, формы ФИО); остальное — константы |
| 2 | Обратный геокод, Nominatim | `GET <nominatim_url>/reverse?format=jsonv2&lat=60.129&lon=64.804&zoom=14&accept-language=ru&addressdetails=1` | `lat`, `lon` — округлены до 3 знаков (≈ 100 м), формат `%.3f`; `zoom=14` — населённый пункт, не улица |
| 3 | Маршрут, OSRM (основной) | `GET <osrm_url>/route/v1/driving/64.804,60.129;65.909,59.592?overview=false&alternatives=false&steps=false` | только 2 пары `lon,lat` с 3 знаками |
| 4 | Маршрут, ORS (запасной №1, только при заданном `ors_key`) | `GET <ors_url>/v2/directions/driving-car?start=64.804,60.129&end=65.909,59.592` + `Authorization: <ключ>` | 2 пары `lon,lat`; ключ приложения (не пользователя) |
| 5 | Маршрут, Valhalla (запасной №2) | `GET <valhalla_url>/route?json={"locations":[{"lat":60.129,"lon":64.804},{"lat":59.592,"lon":65.909}],"costing":"auto","directions_options":{"units":"kilometers"}}` + `X-Client-Id` | 2 точки `lat/lon` (3 знака) |
| 6 | Поиск, Photon (запасной) | `GET <photon_url>/api/?q=<НАЗВАНИЕ>&limit=5&osm_tag=place&bbox=59.0,58.0,86.0,65.8` | как №1 |
| 7 | Тайлы OSM | **не через прокси**: браузер сам, `https://tile.openstreetmap.org/{z}/{x}/{y}.png` (подключит T8/T10) | номера тайлов = область просмотра; OSM видит IP сотрудников — условие согласия владельца (SPIKE_MAP §8.3) |

Адреса по умолчанию: `nominatim.openstreetmap.org`, `routing.openstreetmap.de/routed-car`, `photon.komoot.io`, `api.openrouteservice.org`, `valhalla1.openstreetmap.de`. В тестах используется только `127.0.0.1` (поддельный сервис); серверу прокси в тесте выставлены `http(s)_proxy` на закрытый порт — случайный выход на реальный адрес упал бы, а не ушёл в сеть. Адреса по умолчанию проверяются в тесте как константы.

**Клиенту возвращается только белый список** (см. раздел 2); улицы, номера домов, индексы, `osm_id`, `place_id`, `display_name`, `importance`, `hint`, `waypoints`, `legs` отбрасываются (проверено на «грязных» ответах фейка и на реальных ответах из `T4_evidence`). В кэш пишется уже отфильтрованный ответ.

## 4. Конфиг `data/transport_geo.config.php`

Файл возвращает массив (`return [...]`); лежит вне git (`.gitignore`), каталог закрыт `data/.htaccess` (`Require all denied`); образец без ключей — `reports/V10/T7_transport_geo.config.example.php`. Все ключи необязательны:

| Ключ | По умолчанию | Назначение |
|---|---|---|
| `contact_email` | `''` → заглушка `OWNER_EMAIL_TO_BE_SET` | e-mail проекта в `User-Agent` (требование OSMF/FOSSGIS). **Владелец подставляет настоящий до деплоя.** Принимается только простой адрес (без пробелов, скобок, CR/LF) |
| `nominatim_url`, `photon_url`, `osrm_url`, `ors_url`, `valhalla_url` | см. раздел 3 | базовые адреса (только http/https; хвостовой `/` срезается) |
| `ors_key` | `''` | ключ ORS; пусто — ORS пропускается; не логируется, клиенту не отдаётся |
| `search_providers` | `['nominatim','photon']` | цепочка поиска (неизвестные имена игнорируются; обратный геокод — только Nominatim) |
| `route_providers` | `['osrm','ors','valhalla']` | цепочка маршрута |
| `gap_ms` / `timeout_search_ms` / `timeout_route_ms` | 1100 / 4000 / 6000 | пауза между запросами к сервису; общие таймауты |
| `user_per_min` | 30 | запросов наружу на пользователя в минуту (кэш не считается) |
| `breaker_fails` / `breaker_window_s` / `breaker_open_s` | 3 / 60 / 60 | circuit-breaker |

Неверное значение (не тот тип, вне диапазона, адрес не http/https) заменяется умолчанием, неизвестные ключи игнорируются (тесты `K`). Нет файла — умолчания; без e-mail — заглушка и **одна** строка в `error_log` (`transport_geo: contact_email is not set in data/transport_geo.config.php — User-Agent uses placeholder OWNER_EMAIL_TO_BE_SET`; метка в `geo_cache`, `kind='meta'`). Для тестов путь задаётся env `TRANSPORT_GEO_CONFIG`.

Состояние хранится в `geo_cache` (схема v15, новых таблиц нет): кэш (`search:`/`reverse:`/`route:` — TTL 90/90/30 суток; «не найдено» — 1 час; сбои не кэшируются), `rl:<сервис>` и `ul:<users.id>` (лимиты), `cb:<сервис>` (breaker), `meta:email_warned`. Записи состояния — короткие транзакции `BEGIN IMMEDIATE` (`transport_tx`); сетевой вызов — вне транзакции.

## 5. Чем проверено

Запуск: `bash scripts/verify_all.sh transportgeo` → `RESULTS: 430 passed, 0 failed`, `DB intact: YES`, ~17 с. Три `php -S` (поддельный внешний сервис с 4 обработчиками; настоящий прокси с 4 обработчиками; копия-«мутант» для негативного контроля), БД — временная копия через `SC_APP_DB`.

| Группа | Что проверяется |
|---|---|
| A | аноним 401, viewer 403 (все 3 действия, исходящих нет), admin/supervisor_zone0/zone1 200; GET → 405; неизвестное/пустое действие → 400; битый JSON → 400; пустое тело → 422 |
| B | поиск: журнал фейка — ровно 7 ключей query и значения-константы, нет `bounded`; User-Agent с e-mail; нет Cookie/Referer/Authorization/X-Forwarded-For/Origin; GET без тела; нет канареек (`Ленина`, `Заявка`, `Subscriber-XYZ`, телефон…); заголовки клиента (Referer/Origin/XFF) не пересылаются; ответ клиенту — только белый список, ХМАО первым, административная единица и префикс «городское поселение» убраны |
| C | кэш: повтор (другой регистр) не идёт наружу; запись отфильтрована; TTL 90/90/30 суток с границами 89/91 и 29/31; «не найдено» — 1 час (50/62 мин); сбой не кэшируется |
| D | 19 «плохих» названий (адреса, ФИО, инициалы, цифры, `&format=xml`, перевод строки, `+7…`) → 422 и **ни одного** исходящего; нестроковый `q`; 9 настоящих названий проходят |
| E | обратный геокод: 6 ключей query, координаты 60.129/64.804, ответ без улицы/дома/индекса; муниципалитет без префикса; «в поле» (`name:null`); 10 плохих координат → 422 |
| F | маршрут: путь `…/driving/lon,lat;lon,lat` (3 знака), query строго `overview=false&alternatives=false&steps=false`, ответ `{km,sec,min_map}`, без `hint`/улиц; NoRoute и NoSegment(400) → `no_route` без учёта в breaker |
| G | округление: 41 граничное значение × (PHP, JS, PHP==JS) + 8 значений через HTTP (899,5 → 15; 900,5 → 30; 164,6 → 165; 368,2 → 375; 0,4 с → 0 …); JS без DOM/сети |
| H | деградация (16 сочетаний): таймаут (< 1,5 с при `timeout_ms=500`), 500, 429, 403, не-JSON, JSON «не той формы», ответ > 256 КБ, редирект (не выполняется), закрытый порт → HTTP 200 `{success,degraded,reason}`; не кэшируется; в `error_log` строка с причиной и **без** параметров запроса |
| I | лимиты: второй запрос к Nominatim в пределах 1,1 с → `rate_limited` (наружу не ушёл); сервисы независимы; кэш не ограничивается; через 1,2 с проходит; пользовательский лимит 3/мин, другой пользователь не затронут |
| J, J2 | breaker: 3 сбоя → `circuit_open` без обращения наружу, на сервис, восстановление через `breaker_open_s`, сброс успехом, окно сбоев, 429 считается сбоем; цепочки Nominatim→Photon, OSRM→ORS→Valhalla (ORS без ключа пропускается, ключ только в `Authorization` и только на ORS, в ответе/логе его нет), оба отказали → причина основного |
| K | конфиг: e-mail в UA; заглушка и ровно одно предупреждение; CR/LF-инъекция отвергнута; умолчания (адреса, цепочки, пороги); проверка значений конфига |
| L | параллельный запрос той же сессии не ждёт медленный исходящий вызов (1-й — 3 с, 2-й — < 1,6 с) |
| P | парсеры на **реальных** ответах из `T4_evidence` (поиск, Photon, обратный z16/лес, 4 маршрута OSRM, Valhalla): совпадают с SPIKE_MAP (124,3 км/120; 191,1/165; 430,9/375; 3,3/15) |
| M | статика: исходящий HTTP в `api/*.php` — только `tasks_rules.php` и `transport_geo.php`; редиректы выключены; нет пересылки заголовков; нет e-mail/ключей в коде; Leaflet: файлы, версия, README, **SHA-256 всех файлов совпадают**, нет CDN; `.gitignore` закрывает конфиг |
| N | негативный контроль: в копии прокси добавлены `comment=<адрес и номер заявки>` и `note=…` → проверка утечек находит лишние ключи query и канарейки (≥ 4 нарушения); на настоящем прокси — 0 |
| Z | в журнале серверов нет PHP Warning/Notice/Deprecated/Fatal |

### Мутационная проверка (чтобы тесты не были «зелёными по определению»)

`T7_mutation_check.sh` / `T7_mutation_check.txt`: девять правок реализации, каждая — красный прогон: убрать `session_write_close()` (2 FAIL), включить редиректы (4), не писать кэш (17), `ceil → floor` (61), координаты `%.6f` вместо `%.3f` (3), отключить breaker (6), отключить лимит частоты (6), `require_edit → require_auth` (viewer получает 200; 5), пересылать Cookie (11). Плюс негативный контроль группы N (лишний параметр в исходящем запросе).

### Красный → зелёный

`T7_RED_run_before_impl.txt` — харнес и фейк поднялись, `transport_geo.php` отсутствует → 404, функций нет (80 passed / 324 failed — «зелёные» только отрицательные утверждения при нуле запросов). После реализации — 430/0 (`T7_GREEN_transportgeo.txt`). По ходу найдены и исправлены две ошибки самого теста (`?? 'нет'` скрывало `null`; интерполяция `«$mode»` в PHP читается как имя переменной) и одна ошибка реализации, найденная тестом: opcache кэшировал конфиг (правка файла не подхватывалась 2 с) — теперь `opcache_invalidate()` перед `include`.

## 6. Leaflet

`js/vendor/leaflet/`: `leaflet.js` (147 552 Б), `leaflet.css` (14 806 Б), `images/` (5 PNG), `LICENSE` (BSD-2-Clause), `README.md`. Источник — npm-tarball `leaflet-1.9.4.tgz`, SHA-1 `23fae724e282fa25745aff82ca4d394748db7d8d` совпал с `dist.shasum` из npm (`T4_evidence/npm_leaflet_latest.json`); файлы не менялись, размеры совпадают с SPIKE_MAP §1.1. CDN нет (в `leaflet.js`/`.css` из URL только `w3.org/2000/svg` и ссылки в комментариях). `check_no_pii.sh` → `OK`. В `index.html` не подключён (`git diff` — файл не затронут).

## 7. Правки документов (не мои файлы — применяет координатор)

`T7_AGENTS_patch.md`: строка сьюта `transportgeo` для таблицы `AGENTS.md`; эталон; правило **«исходящий HTTP из `api/*.php` — только в `tasks_rules.php` и `transport_geo.php`»**; строка в решениях владельца; правка allowlist `DEPLOY_HOSTLAND.md` (иначе `leaflet.css`, `images/`, `LICENSE` в пакет не попадут — SPIKE_MAP R8) и пункты чек-листа выкладки (создать конфиг с e-mail, проверить исходящий HTTP хостинга, `Referrer-Policy`). Замечание: в `AGENTS.md` эталон `transportdb` записан 112, в `BASELINE` — 117 (T1b).

## 8. GATE

Полные таблицы и три прогона — `T7_GATE_full.txt`; ниже — итоговая таблица прогона на коммите реализации и результат на итоговом коммите.

**Прогон 1 — коммит `abee7b5` (реализация), `bash scripts/verify_all.sh` → `GATE: PASS (24 suites)`:**

```
SUITE    RES  PASSED EXPECT   TIME  NOTE
smoke    PASS     84     84     9s
tasks    PASS     66     66    13s
tasksn8n PASS     27     27    27s
tasksatt PASS     24     24     9s
tasklinks PASS     37     37    15s
transportdb PASS    117    117     9s
transportgeo PASS    419    419    17s      (тогда 419; затем сьют дополнен до 430)
tasksui  PASS    334    334    40s
tasksmx  PASS     79     79     8s
taskscal PASS    220    220     9s
director PASS    101    101    20s
emptasks PASS     34     34     3s
tasklinksui PASS    211    211   154s
e51      PASS     23     23     0s
e52      PASS     41     41     0s
hygiene  PASS     19     19     0s
trips    PASS      7      7     4s
tripsform PASS    131    131    69s
tripsstatus PASS    147    147    74s
syntax   PASS      -      -     0s
phplint  PASS     44      -     4s
pii      PASS      -      -     0s
refs     PASS     28     28    32s  удалено 0, со ссылками 0, исключений 0
tasklink PASS     43     43     9s  коммитов 1, с кодом 1, нарушений 0
clean    PASS
GATE: PASS (24 suites)
```

**Итоговый коммит `4a175a4` (transportgeo 430): прогоны 2 и 3 — 23 из 24 сьютов PASS, `tripsform` FAIL** (112/131, 16 проверок сценария «п.2 выбор дат» и зависимых от него «supervisor»: в реальном Chromium `TypeError: Cannot read prope…` (текст обрезан в логе) в самом тесте — по-видимому, элемент формы не найден); в обоих прогонах остальные строки — как в прогоне 1, `transportgeo 430/430`, `tasklink` — 2 коммита с кодом, 0 нарушений, `clean PASS`. Отдельные перезапуски `bash scripts/verify_all.sh tripsform` на том же коммите: **115/131 FAIL, 128/131 FAIL, 131/131 PASS** — результат плавает от прогона к прогону (набор падающих проверок разный), на хосте при этом шли браузерные тесты других воркеров (load average 3,3–3,8). Мои изменения этот сьют не затрагивают: `index.html` и подключаемые к нему файлы не менялись; `tripsform` не читает ни один добавленный файл (`git diff 89e3171..HEAD` — только новые файлы, `.gitignore` и строки `verify_all.sh`). **Прошу координатора учесть:** зелёный `GATE: PASS` по всем 24 сьютам на коммите реализации получен (прогон 1); на итоговом коммите `tripsform` без нагрузки на хосте нужно подтвердить перезапуском (отдельный перезапуск дал 131/131 PASS). Флап `tripsform` под нагрузкой — наблюдение, а не результат моего изменения; причина не исследовалась (вне задачи).

Проверки по заданию: `php -l api/transport_geo.php`, `api/transport_geo_test.php` — без ошибок; `node scripts/check_syntax.js` → `failed: 0`; `bash scripts/check_no_pii.sh` → `OK`; `phplint` в gate — 44 файла; `data/app.db` не изменён.

## 9. Риски и открытые вопросы

1. **Исходящий HTTP Hostland не проверен** (SPIKE_MAP §7): неизвестно, разрешён ли web-PHP исходящий 443, и не заблокированы ли адреса. До проверки (команды владельцу — SPIKE_MAP §7 п. 1–2) карта в проде может работать только в режиме `degraded` (форма — вручную). Код корректно деградирует (тесты H), но «работает ли на Hostland» — не доказано ни одним тестом.
2. **Живые провайдеры в этой задаче не вызывались** (по заданию, в тестах только 127.0.0.1). Формат реальных ответов Nominatim/Photon/OSRM/Valhalla подтверждён офлайн на сохранённых ответах T4 (группа P); **ORS ни разу не проверялся на живом сервисе** (нет ключа): разбор `features[0].properties.summary` и заголовок `Authorization` — по документации ORS и фейку. Перед включением ключа — запустить `scripts/spike/v10_t4_ors_compare.sh` (SPIKE_MAP §8.3 п. 4).
3. **`OWNER_EMAIL_TO_BE_SET`** уйдёт в User-Agent, если владелец не создаст конфиг: OSMF/FOSSGIS могут блокировать анонимные приложения. Пункт чек-листа T15; предупреждение в `error_log` выводится один раз.
4. **Условия сервисов** (SPIKE_MAP R2): вики OSRM — «non-commercial», Nominatim — «приложения для трекинга ТС — свой сервис». Нужно согласие владельца (§8.3); при отказе — запасная цепочка через ORS-ключ или собственный VPS (конфигом, без правки кода).
5. **Лимит 1 запрос/с глобально без ожидания:** два пользователя, нажавшие «Найти» в одну секунду, получат `rate_limited` у второго. Это сознательно (прокси не держит запрос на `sleep`, чтобы не занимать воркеры shared-хостинга); UI (T10) обязан показать повтор (раздел 2).
6. **Остаточный риск ПДн во вводе** (SPIKE_MAP R7): проверка названия не отличит имя собственное из одного слова от посёлка; ограничено правом `require_edit()`, подписью поля («Населённый пункт — без улицы и дома» — в UI T10), отказом на цифры/адресные слова/инициалы/ФИО-форму. Добавлен отказ на инициалы (`И.И.`), которого в прототипе не было.
7. **Не сделано (вне задачи, фиксирую):** предупреждение «маршрут по дорогам без названия» (OSRM `steps=true`, SPIKE_MAP §3.3 — порог 30 % не подтверждён на данных владельца); «ближайший известный населённый пункт» для пина «в поле» (локально по гаверсинусу, SPIKE_MAP §2.3) — клиентская логика T10; клиентский «по прямой ≈ N км». Оценка карты — подсказка, не истина: OSRM не знает зимников (Междуреченский — Кондинское).
8. **Состояние в SQLite:** каждый исходящий запрос — две короткие записи (`rl`, `ul`) под `BEGIN IMMEDIATE` плюс запись `cb`/кэша; при `busy_timeout` 5 с и десятках запросов в сутки нагрузка пренебрежимо мала. Сбой хранилища → `degraded/storage_error` (наружу не идём — fail-closed).
9. **Breaker без полуоткрытого состояния:** после `breaker_open_s` сервис просто опрашивается снова; если снова сбой — нужны ещё `breaker_fails` сбоев до следующей паузы (за это время пользователи видят таймауты, не более `breaker_fails` раз за окно).
10. Тест `L` (параллельные запросы одной сессии) опирается на `PHP_CLI_SERVER_WORKERS` (Linux); на хосте без поддержки воркеров он станет флапающим — на текущем хосте стабилен (3 прогона + 9 мутаций).
