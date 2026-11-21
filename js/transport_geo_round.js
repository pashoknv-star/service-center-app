/* js/transport_geo_round.js — округление времени в пути по карте (модуль «Транспорт», V10-T7).
 *
 * Правило (reports/V10/SPIKE_MAP.md §5; PHP-эквивалент — transport_geo_leg_min_map() в api/transport_geo.php):
 *   вход — секунды сервиса маршрутов (число, возможно дробное);
 *   sec ← round(sec) (до целых секунд); 0 → 0 мин (точки совпадают); любое положительное → ceil(sec / 900) × 15 мин,
 *   то есть кратно 15 и не меньше 15; не число / отрицательное / нет оценки → null.
 * Целочисленная арифметика — без ошибок плавающей точки на границах (899, 900, 901 с).
 * Сервер уже возвращает готовое min_map; функция нужна форме, когда секунды известны на клиенте (подсказка «меньше шага: принято 15 мин»).
 * Без DOM и без сборки: в браузере — window.TransportGeoRound.legMinMap, в Node — module.exports.legMinMap.
 * Общий набор проверочных значений PHP/JS — scripts/transport_geo_round_cases.json (сьют transportgeo).
 */
(function (root) {
  'use strict';

  /** @param {*} sec секунды сервиса; @returns {number|null} минуты, кратные 15, либо null (нет оценки) */
  function legMinMap(sec) {
    if (typeof sec !== 'number' || !isFinite(sec) || sec < 0) return null;
    var s = Math.round(sec);
    if (s === 0) return 0;
    var t = s + 899;
    return ((t - (t % 900)) / 900) * 15;
  }

  var api = { legMinMap: legMinMap, STEP_MIN: 15 };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.TransportGeoRound = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
