# E12-1: Схема v7 + CRUD полей RPA v1.2 в trips — отчёт

- **Задача:** t_49ae131d (E12-1), исполнитель sd_worker_02
- **Дата:** 2026-09-24
- **Ветка:** main (рабочее дерево, коммиты по политике репозитория не выполнялись)

## Что сделано

Расширена сущность Trip полями контракта RPA v1.2 (HelpMe): миграция схемы
v6 → v7 и сквозная поддержка полей в CRUD `api/trips.php`.

### 1. api/schema.sql — статическая схема для новых установок

- Заголовок: `Version: 6` → `Version: 7`, в Features добавлена строка
  `RPA v1.2 (HelpMe) fields on trips (schema v7, E12-1)`.
- `CREATE TABLE trips` (строки ~155–175): добавлены 9 колонок после
  `updated_at`:

| Колонка | Тип | DEFAULT | Комментарий |
|---|---|---|---|
| origin | TEXT | NULL | место отправления |
| hotel | TEXT | NULL | данные о гостинице |
| transport_out_required | INTEGER | 1 | предзаказ билетов «выезд» |
| transport_out_mode | TEXT | NULL | 'avia' \| 'zd' |
| transport_back_required | INTEGER | 1 | предзаказ «возврат» |
| transport_back_mode | TEXT | NULL | 'avia' \| 'zd' |
| advance_amount | INTEGER | NULL | сумма аванса, целые рубли, >= 0 |
| business_process | TEXT | NULL | точное значение пункта списка HelpMe |
| phone | TEXT | NULL | телефон сотрудника |

### 2. api/db.php — мигратор

- `SCHEMA_VERSION` 6 → **7** (строка ~30).
- Новый блок `if ($current < 7)` в `applyIncrementalMigrations()` (строки
  ~226–240): девять `addColumnIfNotExists('trips', ...)` по паттерну миграции
  v1→v2 (users.scope_group_id). Для существующих БД колонки добавляются через
  `ALTER TABLE ADD COLUMN`; колонка добавляется только если отсутствует
  (PRAGMA table_info) — идемпотентно. Транспортные флаги — с `DEFAULT 1`
  («плечо нужно»), остальные — NULLable без DEFAULT.

### 3. api/trips.php — CRUD

- **Шапка-контракт** (строки 11–30): в POST/PUT добавлены RPA-поля
  (origin, hotel, transportOutRequired/Mode, transportBackRequired/Mode,
  advanceAmount, businessProcess, phone — camelCase по конвенции файла),
  описание валидаций и поведения «отсутствующее поле → NULL».
- **`trips_fetch()`** (строки ~86–150): SELECT дополнен 9 колонками; ответ
  содержит все новые ключи. Флаги `transportOutRequired/transportBackRequired`
  нормализуются на чтении: `NULL → 1` (согласовано с DEFAULT 1 миграции);
  `advanceAmount` — int или null; текстовые — string или null.
- **Новый хелпер `trips_normalize_rpa_fields()`** (строки ~232–305):
  - строки origin/hotel/businessProcess/phone: trim, пустая строка → NULL;
  - флаги: true/false, 0/1, '0'/'1' → int; null/'' → NULL; прочее truthy → 1
    (толерантно, «плечо нужно»);
  - `advanceAmount`: int >= 0 или строка-число `^\d+$`; иначе
    **400 `advance_invalid`**;
  - mode: только 'avia' | 'zd' (null/'' → NULL); иначе
    **400 `transport_mode_invalid`**.
- **POST** (строки ~370–460): после валидации участников вызывается
  нормализация RPA-полей; INSERT включает все 9 колонок. Без полей в body
  в БД пишутся NULL (включая флаги — колонки NULLable; DEFAULT 1 срабатывает
  только для существующих строк при ALTER).
- **PUT** (строки ~640–740): `trips_normalize_rpa_fields($body, true)` —
  отсутствующее поле = «не менять»; в UPDATE динамически добавляются SET-ы
  только для переданных полей (защита от перезаписи старыми клиентами).
  Валидации те же (400 advance_invalid / transport_mode_invalid).
- Права и правило пересечений (409 overlapping_entry) не изменены; новые поля
  не влияют на матрицу прав.

## Готово в СЦ (не тронуто, по ТЗ)

title, location (=destination), comment (=details), status
forecast/confirmed, участники с датами.

## Что НЕ входит (другие задачи волны E12)

- `js/trips.js`, `index.html` — фронт (E12-2).
- relay/интеграция с HelpMe, обязательность phone при отправке (E12-3).
- `api/sync.php` — вне скоупа (3 файла по ТЗ). **Замечание для координатора:**
  в sync.php строки 42–82 есть локальная копия trips_fetch (самодостаточность
  файла), поэтому дельта-синк пока отдаёт trips без новых RPA-полей. Нужна
  дочерняя задача либо включение sync.php в E12-2/E12-3.

## Проверки (реальные выводы)

### 1. Синтаксис

```
$ php -l api/trips.php && php -l api/db.php
No syntax errors detected in api/trips.php
No syntax errors detected in api/db.php
```

### 2. Smoke-сьют (дважды: после правок и финально)

```
$ php api/smoke_test.php
=== RESULTS: 76 passed, 0 failed out of 76 ===
DB intact: YES
```
После smoke dev-БД возвращена: `git checkout -- data/app.db`.

### 3. Миграция v7 на копии dev-БД (SC_APP_DB → /tmp-копия)

```
version_before: 6
version_after: 7
idempotent_rerun: OK (version=7)
columns_ok: all 9 present
select_new_cols: no rows (empty table) — OK
```
Повторный вызов migrate() без ошибок, версия не меняется.

### 4. E2E CRUD на копии dev-БД (php -S + curl-пробы, прод-БД не затронута)

Скрипт: scratch-харнесс (по образцу smoke_test.php: proc_open php -S,
SC_APP_DB на копию, curl). Дополнительно в копию вставлена legacy-строка v6
до миграции. Итог:

```
PASS: login admin — status=200
PASS: POST with RPA fields -> 201 — status=201
PASS: POST echoes RPA values — {origin:"Москва", hotel:"Гостиница «Сибирь», 3 ночи",
       transportOutRequired:1, transportOutMode:"avia", transportBackRequired:0,
       transportBackMode:"zd", advanceAmount:25000, businessProcess:"Командировка",
       phone:"+7 900 000-00-00", ...}
PASS: GET contains trip with all 9 RPA keys
PASS: PUT partial update: changed 2, rest intact (advanceAmount 25000→30000,
       businessProcess→"Аудит", version 1→2, остальные RPA-поля не тронуты)
PASS: legacy v6 row got transport flags = 1 after migration
PASS: POST without RPA fields -> NULLs (flags normalized to 1 on read) — status=201
PASS: DB row has raw NULLs for all 9 columns
PASS: POST advanceAmount='abc' -> 400 advance_invalid
PASS: POST transportOutMode='train' -> 400 transport_mode_invalid
PASS: PUT transportBackMode='train' -> 400 transport_mode_invalid
=== E12 E2E: 11 passed, 0 failed ===
```

### 5. Финальное состояние дерева

```
$ git diff --stat api/db.php api/schema.sql api/trips.php
 api/db.php     |  16 +++++-
 api/schema.sql |  15 ++++-
 api/trips.php  | 179 +++++++++++++++++++++++++++++++++++++++++++++++++++++++--
 3 files changed, 202 insertions(+), 8 deletions(-)
```

data/app.db не изменён (восстановлен после smoke), staff_project/, static/,
.htaccess, js/trips.js, index.html не тронуты.

## Приёмка по критериям задачи

1. php -l — без ошибок: ✅ (п.1)
2. smoke 100% pass + возврат dev-БД: ✅ 76/76 (п.2)
3. Миграция на копии dev-БД, SELECT по новым колонкам, meta=7: ✅ (п.3)
4. POST/PUT принимают/сохраняют; без полей — NULL: ✅ (п.4, включая raw-NULL в БД)
5. GET отдаёт новые поля в каждом trip: ✅ (п.4)
6. Валидации advance_invalid / transport_mode_invalid: ✅ (п.4)
7. Отчёт: ✅ этот файл.
