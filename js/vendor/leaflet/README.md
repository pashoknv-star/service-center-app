# Leaflet 1.9.4 (локальная копия)

Библиотека карты для окна «На карте» модуля «Транспорт» (V10). Лежит в репозитории, **без CDN**: в прод-страницу не должно уходить обращений к чужим скриптам и стилям. К `index.html` пока **не подключена** (подключит T8/T10: `js/vendor/leaflet/leaflet.css` и `leaflet.js`; карта создаётся лениво при первом открытии окна).

| | |
|---|---|
| Версия | **1.9.4** (`latest` в npm на 2026-11-21; ветка 2.x в `latest` не вышла) |
| Лицензия | **BSD-2-Clause** — файл `LICENSE` рядом (© Vladimir Agafonkin, © CloudMade) |
| Источник | `https://registry.npmjs.org/leaflet/-/leaflet-1.9.4.tgz`, каталоги `package/dist/` и `package/LICENSE` без изменений |
| Целостность архива | SHA-1 `23fae724e282fa25745aff82ca4d394748db7d8d` — совпал с `dist.shasum` из npm (`reports/V10/T4_evidence/npm_leaflet_latest.json`); npm integrity `sha512-nxS1ynzJOmOlHp+iL3FyWqK89GtNL8U8rvlMOsQdTTssxZwCXh8N2NB3GDQOL+YR3XnWyZAxwQixURb+FA74PA==` |
| Состав | `leaflet.js` (147 552 Б), `leaflet.css` (14 806 Б), `images/` (5 PNG — маркеры и значок слоёв; нужны только стандартным маркерам и контролу слоёв, свои пины делаются через `L.divIcon`), `LICENSE` |

## Контрольные суммы (SHA-256)

Сьют `transportgeo` (`bash scripts/verify_all.sh transportgeo`) сверяет эти суммы с файлами: правка файла библиотеки без обновления таблицы — красный прогон.

| Файл | SHA-256 |
|---|---|
| `leaflet.js` | `db49d009c841f5ca34a888c96511ae936fd9f5533e90d8b2c4d57596f4e5641a` |
| `leaflet.css` | `a7837102824184820dfa198d1ebcd109ff6d0ff9a2672a074b9a1b4d147d04c6` |
| `LICENSE` | `53e8dc25862014e4324741ca18fbe3611e11d42ef69f59f86ea8c5389647d4cb` |
| `images/layers-2x.png` | `066daca850d8ffbef007af00b06eac0015728dee279c51f3cb6c716df7c42edf` |
| `images/layers.png` | `1dbbe9d028e292f36fcba8f8b3a28d5e8932754fc2215b9ac69e4cdecf5107c6` |
| `images/marker-icon-2x.png` | `00179c4c1ee830d3a108412ae0d294f55776cfeb085c60129a39aa6fc4ae2528` |
| `images/marker-icon.png` | `574c3a5cca85f4114085b6841596d62f00d7c892c7b03f28cbfa301deb1dc437` |
| `images/marker-shadow.png` | `264f5c640339f042dd729062cfc04c17f8ea0f29882b538e3848ed8f10edb4da` |

Обновление версии: скачать tarball новой версии, сверить его SHA-1 с `dist.shasum` из `https://registry.npmjs.org/leaflet/<версия>`, заменить файлы, пересчитать суммы выше (`sha256sum leaflet.js leaflet.css LICENSE images/*.png`) и обновить версию здесь.

## Замечания для подключающих (T8/T10)

- **Тайлы** `https://tile.openstreetmap.org/{z}/{x}/{y}.png` грузит браузер напрямую (политика OSMF, `reports/V10/SPIKE_MAP.md` §1.2): видимая атрибуция «© OpenStreetMap contributors» со ссылкой на `openstreetmap.org/copyright`, не ставить `referrerPolicy: 'no-referrer'`, никаких prefetch/офлайн-режима. Поиск, обратный геокод и маршрут — только через `api/transport_geo.php`, не из браузера напрямую.
- В конце `leaflet.js` остаётся комментарий `//# sourceMappingURL=leaflet.js.map`; файла `.map` в репозитории нет (нужен только инструментам разработчика; браузер без открытых DevTools его не запрашивает). Файл библиотеки не правился, чтобы сумма совпадала с релизом.
- **Упаковка:** прод-пакет Hostland собирается по allowlist (`DEPLOY_HOSTLAND.md`, раздел 2), каталоги целиком не берутся — `js/vendor/leaflet/**` в пакет попадёт только после правки allowlist (см. `reports/V10/T7_REPORT.md`, «Правки документов»).
