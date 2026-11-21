# V10-T7 — патч для `AGENTS.md` и `DEPLOY_HOSTLAND.md` (применяет координатор)

`AGENTS.md` воркер не правит. Предлагаемые изменения — «было / стало».

## 1. Раздел «Verification» — строка эталонов

**Было** (фрагмент): «…(на 2026-11-18 …: smoke 84, e51 23, …, tasklink 43). … С V10-T1: transportdb 112. …»

**Стало** (добавить): «С V10-T7: transportgeo 429 (входит в `ALL_SUITES`, в отличие от `transport`)». Число `transportdb` в `BASELINE` на ветке — 117 (T1b), в `AGENTS.md` оно устарело (112) — поправить заодно.

## 2. Таблица сьютов — новая строка (после `transportdb (V10-T1)`)

```
| transportgeo (V10-T7) | `bash scripts/verify_all.sh transportgeo` (= `php api/transport_geo_test.php`; временная копия БД через `SC_APP_DB`, три `php -S`: ПОДДЕЛЬНЫЙ внешний сервис `scripts/transport_geo_fake_upstream.php`, настоящий `api/transport_geo.php` (`PHP_CLI_SERVER_WORKERS=4`) и копия-«мутант» для негативного контроля; конфиг прокси — временный файл через env `TRANSPORT_GEO_CONFIG`; `data/app.db` не трогается; ~17 с; реальных сетевых запросов нет — серверу прокси выставлены `http(s)_proxy` на закрытый порт) | `RESULTS: 429 passed, 0 failed`, `DB intact: YES`; геопрокси «Транспорта»: роли (аноним 401, viewer 403, admin/supervisor 200), журнал фейка — query строго из белого списка, нет канареек/Cookie/Referer/Authorization, GET без тела; ответ клиенту без улиц/`hint`/`osm_id`; кэш `geo_cache` и TTL; деградация (таймаут, 5xx, 429, не-JSON, слишком большой ответ, редирект, закрытый порт); глобальный и пользовательский лимиты; circuit-breaker; цепочки Nominatim→Photon и OSRM→ORS→Valhalla; конфиг/e-mail/заглушка; `session_write_close()` до исходящего вызова; округление времени пути PHP = JS на `scripts/transport_geo_round_cases.json`; парсеры на реальных ответах из `reports/V10/T4_evidence`; Leaflet 1.9.4 локально + контрольные суммы; статика «исходящий HTTP — только `tasks_rules.php` и `transport_geo.php`»; негативный контроль (лишний параметр в копии прокси → проверка утечек падает) |
```

## 3. Раздел «Repository rules» / «Security and side effects» — новое правило

**Добавить** (после правил про защищённые файлы):

> - **Исходящий HTTP из `api/*.php` — только в двух файлах (V10-T7, 2026-11-21):** `api/tasks_rules.php` (n8n) и `api/transport_geo.php` (карта: Nominatim/OSRM и запасные провайдеры). Любой другой файл `api/*.php` (кроме `*_test.php`) с `curl_init`/`fsockopen`/`stream_socket_client`/`file_get_contents($url…)`/`file_get_contents('http…')` ломает сьют `transportgeo` (статическая проверка). Новый внешний вызов — только через `transport_geo.php` (белые списки входа и выхода, кэш, лимиты, breaker) либо отдельным решением владельца с правкой этого списка и теста. Наружу из модуля «Транспорт» уходят только название населённого пункта и координаты, округлённые до 3 знаков; адрес, заголовок, абонент, телефон — никогда. Ключи и e-mail проекта — только в `data/transport_geo.config.php` (вне git, `.gitignore`), в репозитории и логах их нет.

## 4. «Решения владельца 2026-11-21 (V10)» — одна строка

> Геопрокси: Nominatim (поиск/обратный геокод) + OSRM `routing.openstreetmap.de` (маршрут); запасные — Photon, ORS (ключ только из конфига вне git), Valhalla; время в пути — вверх до 15 мин, положительное < 15 → 15; подстановка в форму — кнопкой, прогноз длительности — вручную; тайлы OSM грузит браузер напрямую. Перед деплоем владелец подставляет настоящий e-mail в `data/transport_geo.config.php` (иначе в User-Agent заглушка `OWNER_EMAIL_TO_BE_SET`).

## 5. `DEPLOY_HOSTLAND.md`, раздел 2 (сборка пакета), шаг 4 — allowlist

`js/vendor/leaflet/leaflet.css`, картинки и лицензия **в пакет не попадут** (JS берётся только из `<script src>`, каталоги целиком не берутся): `leaflet.js` попадёт сам после подключения в `index.html` (T8/T10), а `leaflet.css`, `images/*.png`, `LICENSE` — нет. Файлы `api/transport_geo.php` и `js/transport_geo_round.js` попадут автоматически (`$API` и `$JS`).

**Было:**
```bash
tar -czf "$OUT" \
  index.html upload.php \
  $JS \
  $API api/.htaccess api/schema.sql \
  data/.htaccess data/holidays/*.json \
  images/.htaccess
```
**Стало** (добавить строку перед `images/.htaccess` — после того как T8/T10 подключит Leaflet к `index.html`):
```bash
  js/vendor/leaflet/leaflet.css js/vendor/leaflet/LICENSE js/vendor/leaflet/images/*.png \
```
И в чек-лист выкладки: (а) создать на сервере `data/transport_geo.config.php` по образцу `reports/V10/T7_transport_geo.config.example.php` с настоящим `contact_email` (файл не из пакета и не из git; пакет его не перезаписывает); (б) проверить исходящий HTTP хостинга (`reports/V10/SPIKE_MAP.md` §7, команды владельцу) ДО включения карты; (в) убедиться, что nginx хостинга не ставит `Referrer-Policy: no-referrer` (нужен `Referer` для тайлов OSM).
