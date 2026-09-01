# RC: палитра панели «Командировки» → переменные сайта (замечание 15) — отчёт

**Задача:** t_04d5c663 (RC-палитра)
**Исполнитель:** sd_worker_01
**Дата:** 2026-09-01
**Файл правок:** `/home/hermes/service-center-app/js/trips.js`
**Область правок:** только CSS-блок `injectStyles()` + inline-стили `openDraftModal()` / `showTripConflictDialog()`. Логика не менялась. Деплой не выполнялся.

## Что сделано

Все hardcode-цвета в областях видимости заменены на CSS-переменные палитры сайта (`:root` из `index.html`). Радиусы и тени приведены к образцу сайта (`.panel-tab`, `.user-indicator-btn`, `.cell-popup`).

## Таблица замен (до → после)

### Block: injectStyles() (js/trips.js 475-765)

| Где | Было | Стало | Обоснование |
|---|---|---|---|
| `.trip-blue` | `#2196F3` | `var(--trip-blue)` | семантика «командировка» — trip-blue оставлен |
| `.status-confirmed` | `#2196F3` | `var(--trip-blue)` | семантика статуса командировки — trip-blue оставлен |
| `.status-forecast` bg | `rgba(33,150,243,0.35)` | оставлен как есть | семантика «прогноз командировки» — trip-blue (задача: hex, не rgba) |
| `.panel-tab` border | `#ddd` | `var(--divider)` | border → divider |
| `.panel-tab` bg | `white` | `white` | bg панели/карточек, site тоже использует `#fff`/`white` |
| `.panel-tab` radius | `4px` | `8px` | radius к образцу сайта |
| `.panel-tab:hover` bg | `#f5f5f5` | `rgba(119,0,255,0.06)` | secondary-фон → purple-тинт как на сайте (.panel-tab hover) |
| `.panel-tab.active` bg | `#2196F3` | `var(--rt-purple)` | primary-акцент → rt-purple |
| `.panel-tab.active` border | `#2196F3` | `var(--rt-purple)` | primary-акцент → rt-purple |
| `.trip-list-item` border | `#ddd` | `var(--divider)` | border → divider |
| `.trip-list-item` radius | `4px` | `8px` | radius к образцу |
| `.trip-list-item:hover` shadow | `0 2px 4px rgba(0,0,0,0.1)` | `0 2px 6px rgba(0,0,0,0.04)` | тень к образцу сайта |
| `.trip-location` color | `#666` | `var(--accent)` | текст-вторичный → accent |
| `.trip-dates` color | `#888` | `var(--accent)` | текст-вторичный → accent |
| `.trip-participants` color | `#555` | `var(--text)` | текст → text |
| `.trip-modal-header` border-bottom | `#eee` | `var(--divider)` | divider |
| `.trip-form-label` color | `#333` | `var(--text)` | текст → text |
| `.trip-form-input` border | `#ddd` | `var(--divider)` | divider |
| `.trip-form-input` radius | `4px` | `8px` | radius к образцу |
| `.trip-form-input:focus` border | `#2196F3` | `var(--rt-purple)` | фокус → primary-акцент |
| `.trip-form-error` color | `#d32f2f` | `var(--sick-red)` | danger → sick-red |
| `.trip-participant-row` border | `#eee` | `var(--divider)` | divider |
| `.trip-participant-row` radius | `4px` | `8px` | radius к образцу |
| `.trip-btn` radius | `4px` | `8px` | radius к образцу |
| `.trip-btn-primary` bg | `#2196F3` | `var(--rt-purple)` | primary-кнопка → rt-purple |
| `.trip-btn-secondary` bg | `#f5f5f5` | `rgba(119,0,255,0.06)` | secondary-фон → purple-тинт |
| `.trip-btn-secondary` color | `#333` | `var(--text)` | текст → text |
| `.trip-btn-danger` bg | `#d32f2f` | `var(--sick-red)` | danger → sick-red |
| `.trip-pick-edge` bg (R3, в том же injectStyles) | `var(--rt-purple, #7700ff)` | `var(--rt-purple)` | убран fallback-hex |
| `.trip-pick-edge:hover` bg (R3) | `#5c00cc` | `color-mix(in srgb, var(--rt-purple) 85%, black)` | hover-затемнение без hex |

### Block: showTripConflictDialog() (js/trips.js 1881-1915)

| Где | Было | Стало | Обоснование |
|---|---|---|---|
| warning `p` color | `#d32f2f` | `var(--sick-red)` | danger → sick-red |
| warning text `p` color | (нет) | `var(--text)` | единый текст → text |
| conflict box bg | `#fff3cd` | `rgba(119,0,255,0.06)` | вторичный фон → purple-тинт (на сайте нет жёлтого предупреждения) |
| conflict box radius | `4px` | `8px` | radius к образцу |
| Cancel button border | `#ccc` | `var(--divider)` | divider |
| Cancel button bg | `white` | `white` | кнопка-нейтральная |
| Cancel button radius | `4px` | `8px` | radius к образцу |
| Create button bg | `#2196F3` | `var(--rt-purple)` | primary → rt-purple |

### Block: openDraftModal() (js/trips.js 1919-1995)

| Где | Было | Стало | Обоснование |
|---|---|---|---|
| draft-title input border | `#ccc` | `var(--divider)` | divider |
| draft-title input radius | `4px` | `8px` | radius к образцу |
| draft-location input border | `#ccc` | `var(--divider)` | divider |
| draft-location input radius | `4px` | `8px` | radius к образцу |
| draft-comment textarea border | `#ccc` | `var(--divider)` | divider |
| draft-comment textarea radius | `4px` | `8px` | radius к образцу |
| draft-status select border | `#ccc` | `var(--divider)` | divider |
| draft-status select radius | `4px` | `8px` | radius к образцу |
| participants box border | `#ccc` | `var(--divider)` | divider |
| participants box radius | `4px` | `8px` | radius к образцу |
| Отмена footer button | (no стилей) | `border: var(--divider); bg: white; radius: 8px; color: var(--text)` | вторичная кнопка → палитра |
| Создать footer button | (no стилей) | `bg: var(--rt-purple); color: white; radius: 8px` | primary → rt-purple |

Дополнительно добавлены `color: var(--text)`/`background: white` на инпуты/селекты — у них не было явного цвета текста/фона (наследовали от окружения), теперь приведены к палитре.

## Семантический trip-blue (НЕ тронут)

- `.trip-blue { color: var(--trip-blue) }` — маркер командировки
- `.status-confirmed` / `.status-forecast` — статусные бейджи командировки
- матричные оверлеи `.type-trip-confirmed` / `.type-trip-forecast` (rgba(33,150,243,…)) — семантика командировки на матрице

Правило: trip-blue остаётся только там, где это семантика «командировки», не для UI-акцентов. Все primary-кнопки/фокусы/активные табы → rt-purple.

## Приёмка

1. **AC1 — нет hardcode-цветов:** `grep -E '#[0-9A-Fa-f]{3,8}' js/trips.js` → **0 совпадений** (в т.ч. весь injectStyles и inline-стили).
3. **AC3 — регрессий нет:** smoke **76/76 PASS**, e2e (test_trips_frontend.sh) **7/7 PASS**, unit (test_r4_hygiene.js) **19/19 PASS**, `node --check js/trips.js` OK.
2. **AC2 — визуально.** Сравнение скриншотов выполняет координатор (браузерный драйвер из песочницы недоступен — аналогично R1). Ожидаемые изменения: акцентные кнопки/таб «Командировки» из синего акцента → фиолетовый purple сайта; вторичные фоны/бордеры → divider/purple-тинт; радиусы 4→8px.

## Файлы

- Изменён: `js/trips.js` (только CSS-области)
- Отчёт: `reports/RC_palette.md`

## Риски / замечания

- `color-mix()` для hover-затемнения edge-кнопки — современный CSS (Chrome 111+, FF 113+, Safari 16.2+); в проде используется современный браузер (окно-приложение/веб), при необходимости можно заменить на фиксированный тёмный purple-hex через :root-переменную (но это расширило бы задачу).
- Жёлтый фон конфликт-блока `#fff3cd` заменён на purple-тинт — в палитре сайта нет жёлтого предупреждения.
- В рабочем дереве остаются незакоммиченные правки parent-воркеров (R1-R4 в js/trips.js, index.html, data/app.db изменился до моей задачи) — я их не трогал и не откатывал.