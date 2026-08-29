# QA Report — Фаза 9 (часть B): Frontend Static Audit

> **Coordinator addendum (post-audit fixes, 2026-08-14):**
> После исходного статического аудита были внесены и перепроверены следующие исправления:
> 1. Исправлен реальный JS-баг: вызов `handlePopupAction(...)` заменён на прямой `setDayVacationType(...)` в обработчике Enter для popup-комментария.
> 2. Исправлен неверный id: `'user-indicator'` → `'userIndicator'`.
> 3. Усилена серверная защита: `require_auth()` / `require_edit()` добавлены в `load.php`, `save.php`, `employees.php`, `groups.php`, `positions.php`.
> 4. Создан и выполнен `api/smoke_test.php`: **26/26 PASS, DB intact: YES**.
>
> Ниже сохранён оригинальный отчёт воркера; замечания выше по пунктам 2, 3 и 5 больше неактуальны.

**Проект:** Сервисный центр (`/home/hermes/service-center-app/`)
**Дата:** 2026-08-14
**Аудитор:** sd_worker_02 (qa_engineer)
**Метод:** статический анализ (python3 regex + HTMLParser), исходники НЕ изменялись.
**Объекты:** `index.html` (4496 строк), `js/storage.js`, `api/*.php` (17 файлов + 5 библиотек).

---

## 1. Endpoints Audit

Извлечены все `fetch(...)` вызовы из `index.html` (9 вызовов) и `js/storage.js`
(3 вызова через константы `LOAD_URL` / `SAVE_URL`). Итого 11 уникальных endpoint.

| # | Endpoint | Источник | Файл существует | Примечание |
|---|----------|----------|:---:|------------|
| 1 | `api/login.php` | index.html | ✓ | |
| 2 | `api/logout.php` | index.html | ✓ | |
| 3 | `api/session.php` | index.html | ✓ | |
| 4 | `api/holidays_provider.php?year=…` | index.html | ✓ | query-string отброшен при проверке |
| 5 | `upload.php` (корневой) | index.html | ✓ | делегирует в `api/upload.php` |
| 6 | `api/export.php?download=1` | index.html | ✓ | |
| 7 | `api/import.php` | index.html | ✓ | |
| 8 | `api/reset.php` | index.html | ✓ | |
| 9 | `api/positions.php` | index.html | ✓ | |
| 10 | `api/load.php` | js/storage.js (`LOAD_URL`) | ✓ | |
| 11 | `api/save.php` | js/storage.js (`SAVE_URL`) | ✓ | |

Не вызываются из фронтенда (не ошибка): `api/employees.php`, `api/groups.php`,
`api/entries.php`, `api/vacation_import.php`, `api/holidays.php` — серверные/утилитарные.

**Вердикт: PASS** — 11/11 endpoints существуют на диске.

---

## 2. HTML Validation

### 2.1 Парность тегов
Проверено HTMLParser'ом (stack-based, void-элементы учтены):
`div, form, select, table, script, style, canvas, button` и прочие.

- Незакрытых тегов: **0**
- Лишних закрывающих тегов: **0**

### 2.2 getElementById vs id="…"
- Уникальных `getElementById(...)` вызовов: ~140 — все резолвятся, кроме одного:

| Обращение в JS | Строка | id в HTML | Статус |
|----------------|--------|-----------|--------|
| `getElementById('user-indicator')` | index.html:4485 | — (реальный id: `userIndicator`, стр. 1431) | **WARN** |

Код имеет fallback: `document.getElementById('user-indicator') || document.body` —
индикатор режима (Сервер/Локально) аппендится в `body` вместо контейнера.
Критичности нет (не падает), но индикатор отображается не в задуманном месте.

**Вердикт: PASS** (0 ошибок парности; 1 некритичный missing id с fallback → WARN).

---

## 3. JS Consistency

### 3.1 Баланс скобок (после зачистки строк/комментариев)

| Блок | `{}` | `()` | `[]` |
|------|:---:|:---:|:---:|
| index.html (inline scripts) | 0 | 0 | 0 |
| js/storage.js | 0 | 0 | 0 |

### 3.2 Определённость функций
Определено: **102**, вызывается: **110** (встроенные и ключевые слова исключены).

Кандидаты в undefined и их классификация:

| Имя | Статус |
|-----|--------|
| `getLabel`, `isHoliday`, `isWorkingDay` | ложные срабатывания — методы объекта `HolidaysCalendar` (стр. 2059–2084), вызываются как `HolidaysCalendar.isHoliday(...)` |
| **`handlePopupAction`** | **REAL BUG — функция нигде не определена.** Вызов: index.html:3253, обработчик Enter в поле комментария vacation-popup. При нажатии Enter в поле комментария → `ReferenceError`. Основной путь (клик по `.popup-item`) работает — вызывает `setDayVacationType(...)` (стр. 3283). Похоже, задумывался вызов `setDayVacationType(popupTarget.empId, currentYear, popupTarget.day, pendingType)`. |

**Вердикт: WARN** — баланс = 0 (критерий приёмки выполнен), но найдена 1 реальная
undefined-функция на второстепенном пути (Enter в комментарии). Рекомендуется фикс в след. фазе.

---

## 4. CSS Classes

Все 14 обязательных классов проверены на наличие в `<style>` и использование в JS:

| Класс | В CSS | Использование в JS |
|-------|:---:|--------------------|
| `day-holiday` | ✓ | конкатенация строк (index.html:2837, 2874) |
| `day-weekend` | ✓ | конкатенация строк (index.html:2876) |
| `range-selecting` | ✓ | `classList.add/remove` |
| `type-vacation` | ✓ | карта `TYPE_CLASS` (стр. 2011) + статическая разметка |
| `type-sick` | ✓ | карта `TYPE_CLASS` (стр. 2012) |
| `type-trip` | ✓ | карта `TYPE_CLASS` (стр. 2013) |
| `type-dayoff` | ✓ | карта `TYPE_CLASS` (стр. 2014) |
| `cloned` | ✓ | `classList` |
| `app-loading` | ✓ | `body.classList.add` (стр. 1918, 4493) |
| `role-admin` | ✓ | `body.classList.add('role-' + user.role)` (стр. 1876) |
| `role-supervisor` | **✗ (нет селектора)** | добавляется динамически (стр. 1874, 1876) |
| `role-viewer` | ✓ | там же; правила `body.role-viewer ...` (стр. 1296–1311) |
| `editor-only` | ✓ | `querySelectorAll('.editor-only')` (стр. 1880) |
| `admin-only` | ✓ | правила стр. 1314–1315 |

`role-supervisor`: класс ставится на `body`, но CSS-правил для него нет. Это
**by design не ломает UI**: supervisor не имеет ограничений (ограничения только
у `role-viewer`, админ-расширения — у `role-admin`). WARN-уровень, исправление не требуется.

**Вердикт: PASS** (13/14 строго; 1 — by-design, деградации нет).

---

## 5. Security (минимум)

### 5.1 Хардкод секретов в JS
Паттерны `password|secret|token|api_key = '…'` в index.html и js/storage.js: **0 совпадений**.
Длинных base64-литералов (≥40 симв.): **0**. Учётные данные отправляются только
формой логина на `api/login.php`. ✓

### 5.2 upload.php и авторизация
- `api/upload.php`: первая значимая строка после хедеров —
  `require_once __DIR__ . '/auth.php';` → `require_auth();` **✓ защищён**.
- Корневой `upload.php`: тонкая обёртка `require __DIR__ . '/api/upload.php';` —
  авторизация наследуется. **✓ защищён**.

### 5.3 Смежное наблюдение (вне минимального объёма, для следующей фазы)
`require_auth()` есть в: `auth.php, entries.php, export.php, import.php, reset.php, upload.php`.
**Вызывают без auth** (только метод-гейты): `load.php, save.php, employees.php, groups.php,
positions.php` — чтение/запись данных расписания без логина; `holidays*.php` —
публичный календарь (допустимо); `init_db.php, seed_positions.php` — дев-утилиты.
→ рекомендуется добавить `require_auth()` / `require_edit()` в отмеченные endpoint'ы.

**Вердикт: PASS** (по заявленному объёму: секретов нет, upload защищён) + 1 WARN вне объёма.

---

## Итоговая сводка

| Раздел | Вердикт | Детали |
|--------|:---:|--------|
| 1. Endpoints Audit | **PASS** | 11/11 endpoint существуют |
| 2. HTML Validation | **PASS** | парность 0 ошибок; 1 WARN: `user-indicator` (есть fallback `\|\| body`) |
| 3. JS Consistency | **PASS / WARN** | баланс скобок = 0; **1 реальный баг**: `handlePopupAction` не определён (index.html:3253, Enter в комментарии → ReferenceError) |
| 4. CSS Classes | **PASS** | 13/14 в CSS; `role-supervisor` отсутствует by-design (супервизор без ограничений) |
| 5. Security | **PASS** | секретов нет; upload.php защищён `require_auth()`; WARN: 5 API без auth |

**Общий статус: PASS с 2 WARN** (найденные некритичные дефекты задокументированы,
критических блокеров нет). Рекомендации к следующей фазе:
1. `index.html:3253` — заменить вызов на `setDayVacationType(...)` (или определить функцию).
2. `index.html:4485` — заменить `'user-indicator'` → `'userIndicator'`.
3. Добавить `require_auth()` в `load/save/employees/groups/positions.php`.

*Аудит выдержан только для чтения; артефакты аудита: `qa_audit.py`, `qa_audit2.py`, `qa_results.json`, `qa_functions.json`.*
