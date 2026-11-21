<?php
// Пример data/transport_geo.config.php (V10-T7). Файл кладёт на сервер владелец; в git его НЕТ (.gitignore), каталог data/ закрыт
// data/.htaccess (Require all denied). Все ключи необязательны: чего нет — берётся значение по умолчанию (api/transport_geo.php,
// transport_geo_default_config()). Неизвестные ключи игнорируются; адрес не http/https и число вне диапазона заменяются значением по умолчанию.
// Изменения подхватываются сразу (opcache для этого файла сбрасывается при каждом запросе).
return [
    // ОБЯЗАТЕЛЬНО перед деплоем: настоящий контактный e-mail проекта (требование OSMF и FOSSGIS). Попадёт в User-Agent вида
    //   ServiceCenterApp-Transport/0.1 (internal staff-scheduling tool; contact: <e-mail>)
    // Пока пусто — в User-Agent заглушка OWNER_EMAIL_TO_BE_SET и одно предупреждение в error_log.
    'contact_email' => '',

    // Адреса провайдеров (менять без обновления кода — требование политики Nominatim):
    'nominatim_url' => 'https://nominatim.openstreetmap.org',          // поиск и обратный геокод
    'photon_url'    => 'https://photon.komoot.io',                     // запасной геокод
    'osrm_url'      => 'https://routing.openstreetmap.de/routed-car',  // маршрут (основной)
    'ors_url'       => 'https://api.openrouteservice.org',             // маршрут (запасной №1, нужен ключ)
    'valhalla_url'  => 'https://valhalla1.openstreetmap.de',           // маршрут (запасной №2)

    // Ключ приложения OpenRouteService (бесплатная регистрация на account.heigit.org). Пусто — ORS пропускается.
    // Ключ нигде не логируется и клиенту не отдаётся. Здесь — не вписывать настоящий ключ в репозиторий.
    'ors_key' => '',

    // Цепочки провайдеров (порядок = очередность; неизвестные имена игнорируются):
    'search_providers' => ['nominatim', 'photon'],
    'route_providers'  => ['osrm', 'ors', 'valhalla'],

    // Пороги (значения по умолчанию — из reports/V10/SPIKE_MAP.md §6.4):
    'gap_ms'            => 1100,  // минимум между запросами к одному сервису, мс (политика: ≤ 1 запрос/с)
    'timeout_search_ms' => 4000,  // общий таймаут поиска / обратного геокода, мс
    'timeout_route_ms'  => 6000,  // общий таймаут маршрута, мс
    'user_per_min'      => 30,    // запросов наружу на пользователя в минуту
    'breaker_fails'     => 3,     // сбоев подряд за окно → сервис закрывается
    'breaker_window_s'  => 60,
    'breaker_open_s'    => 60,    // сколько секунд ответы degraded без обращения наружу
];
