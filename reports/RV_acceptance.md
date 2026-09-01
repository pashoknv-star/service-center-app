# E9: Приёмочный отчёт — фиксация замечаний (remarks 1-15)

**Дата:** 2026-09-01
**Коммиты:** e6a65e9 (E9 R2-fix: modal portal + in-panel trip form), 11ba58e (E9 wave 2-3: RP, RC, R3, R4), 14fa508 (E9 wave 1: header/ctrl-select fixes)
**Статус:** ПРИНЯТО — все замечания закрыты

## Метод

Приёмка по списку замечаний 1-15 от владельца (Pavel). Каждое замечание верифицировано код-инспекцией и/или тестами. Все промежуточные отчёты (RH, R2, R3, RC, R4) изучены.

## Чек-лист замечаний 1-15

| # | Замечание | Статус | Доказательство |
|---|-----------|--------|----------------|
| 1 | Удалить заголовок `<h2>Матрица отпусков<span id="syncBadge">…</span></h2>` | ✅ | RH_header_ctrl.md:10-11; h2 удалён, null-guard на месте |
| 2 | Табы слева, первый элемент хедера | ✅ | RH_header_ctrl.md:14; `<div class="panel-tabs">` первый в `.vacation-panel-header` |
| 3 | Табы и год-навигация на одной горизонтальной линии | ✅ | RH_header_ctrl.md:16-18; `gap: 12px` + scoped override `margin-bottom: 0` |
| 4 | Ctrl-выделение строк: затемнять ВСЕ невыбранные, выбранные — default, читаемые ФИО | ✅ | RH_header_ctrl.md:26-31; `trip-row-dimmed` на `<tr>`, white-on-purple удалён |
| 5 | В popup ячейки НЕТ «Создать командировку» | ✅ | Код-инспекция: index.html:2000-2009 — только типы work/vacation/sick/trip/dayoff + clear |
| 6 | «Командировка» в popup открывает форму создания Trip с датами | ✅ | index.html:4064-4076, 5048-5108; `createTripFromSelection()` → `renderTripFormInPanel()` |
| 7 | Trip-форма в panel, НЕ в window/modal | ✅ | R2_inpanel_stacking_IMPLEMENTED.md:77-106; `#tripsListView` в `<aside id="vacationPanel">` |
| 8 | Trip-форма без пустой строки участника при редактировании | ✅ | R2_inpanel_stacking_IMPLEMENTED.md:141; `addParticipantRow()` удалён из `showTripModal()` |
| 9 | Trip-форма без лишней пустой строки (initial seed) | ✅ | R2_inpanel_stacking_IMPLEMENTED.md:142; только для новых trips |
| 10 | Добавление сотрудника: Ctrl+click по карточкам на странице, панель уезжает/возвращается | ✅ | R3_emp_pick.md:9-22; `trip-panel-slided`, capture-листенер Ctrl+click |
| 11 | Вход из карточки сотрудника использует тот же механизм (panel form, dates pre-filled) | ✅ | R3_emp_pick.md:31-36; `openTripModal(id, onRendered)` + колбэк после рендера |
| 12 | Существующий выбор (participants) виден в panel, НЕ за ней | ✅ | R2_inpanel_stacking_IMPLEMENTED.md:15-75; `#tripModalRoot` portal, z-index 1500 |
| 13 | Кнопка «×» у участника удаляет корректную строку | ✅ | R3_emp_pick.md:48; `syncPickedEmployeesToForm()` с employeeId, правильное удаление |
| 14 | «Delete» и «Confirm» вызывают API, не рекурсию | ✅ | R4_p2_hygiene.md; `canDeleteTrip`/`canConfirmTrip` экспортированы, T3-10/11 smoke PASS |
| 15 | Палитра panel совпадает с палитрой сайта | ✅ | RC_palette.md; grep hardcode → 0 совпадений, все var(--rt-purple) и т.п. |

## Регрессионные проверки

| Область | Статус | Доказательство |
|---------|--------|----------------|
| ELN приоритет (sick > confirmed) | ✅ | E7 smoke T41: supervisor g0 sees g1 entries |
| Overlay matrix rendering | ✅ | E6 QA: confirmed + forecast штриховка |
| Tabs/переключение вкладок | ✅ | e2e: 5 conf + 4 fc ячеек, табы переключаются |
| Sync-delta (E8) | ✅ | T26-T30: auto version, delta + precheck, appliedVersions |
| Ролевой доступ (admin/supervisor/viewer) | ✅ | T1, T18, T31-T35, T61: zone_forbidden, forbidden |
| 409 конфликты (overlap, version) | ✅ | T48-T49, T52: 409 overlapping_entry, version_conflict |

## Результаты тестов

| Тест-набор | Результат | Ожидание |
|------------|-----------|----------|
| Smoke test (api/smoke_test.php) | **76/76 PASS** | 76/76 PASS |
| Trips E2E (T3-* в smoke_test.php) | **19/19 PASS** | 7/7 PASS (ориентир) |
| Unit (scripts/test_r4_hygiene.js) | **19/19 PASS** | PASS |
| `node --check js/trips.js` | OK | OK |
| `php -l index.html` | OK | OK |

## Изменённые файлы

- `index.html` — popup интеграция, guards, createTripFromSelection
- `js/trips.js` — R2 (portal + in-panel), R3 (Ctrl+pick), RC (palette), R4 (hygiene)
- `scripts/test_r4_hygiene.js` — новый unit-харнесс (19 тестов)

## Артефакты

Отчёты по задачам:
- `reports/RH_header_ctrl.md` — замечания 1-4 (header + Ctrl-выделение)
- `reports/R2_inpanel_stacking_IMPLEMENTED.md` — замечания 7, 8, 9, 12 (portal + panel form)
- `reports/R3_emp_pick.md` — замечания 10-11 (Ctrl+карточки)
- `reports/RC_palette.md` — замечание 15 (palette)
- `reports/R4_p2_hygiene.md` — замечание 14 (delete/confirm экспорты)

## Вывод

Все 15 замечаний от владельца закрыты. Регрессионные проверки зелёные. Синтаксис чистый. Фикс-пакет E9 **принят**.